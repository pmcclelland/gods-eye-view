import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { createOpenFreeMapSource } from '../../sources/openFreeMap.js';
import { readResponseBytesCapped } from '../../sources/httpBody.js';
import {
  BOUNDARY_MAX_LEVEL,
  BOUNDARY_SOURCE_MAX_ZOOM,
  ancestorTile,
  drawBoundaryTile,
} from './boundaryStyle.js';

const MAX_BOUNDARY_FEATURES = 40_000;
const DEFAULT_TILE_BYTES = 4 * 1024 * 1024;

export const OPENFREEMAP_BOUNDARY_CREDIT_HTML =
  '<a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

/**
 * Keep boundary lines from an already-decoded vector tile.
 * Points and rings shorter than two vertices are skipped.
 */
export function boundaryFeaturesFromDecodedTile(tile) {
  const layer = tile?.layers?.boundary;
  if (!layer) return { extent: 4096, features: [] };
  if (layer.length > MAX_BOUNDARY_FEATURES) {
    throw new Error('Vector tile feature limit exceeded');
  }
  const extent =
    Number.isInteger(layer.extent) && layer.extent > 0 ? layer.extent : 4096;
  const features = [];
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    if (feature.type !== 2 && feature.type !== 3) continue;
    const geometry = feature.loadGeometry?.() || [];
    const rings = [];
    for (const ring of geometry) {
      if (!ring || ring.length < 2) continue;
      rings.push(ring.map((point) => [point.x, point.y]));
    }
    if (!rings.length) continue;
    features.push({ properties: feature.properties || {}, rings, extent });
  }
  return { extent, features };
}

/** Decode a Mapbox vector tile and keep its `boundary` source-layer. */
export function boundaryFeaturesFromVectorTile(bytes) {
  return boundaryFeaturesFromDecodedTile(new VectorTile(new PbfReader(bytes)));
}

/** Small LRU of decoded source tiles. In-flight reads are shared. */
export function createBoundaryTileCache({ maxEntries = 32 } = {}) {
  const cache = new Map();
  const inflight = new Map();

  function remember(key, value) {
    cache.set(key, value);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  return {
    get(key, load, signal) {
      if (cache.has(key)) {
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return Promise.resolve(value);
      }
      let flight = inflight.get(key);
      if (!flight) {
        const controller = new AbortController();
        const promise = Promise.resolve()
          .then(() => load(controller.signal))
          .then((value) => {
            remember(key, value);
            return value;
          })
          .finally(() => {
            if (inflight.get(key)?.promise === promise) inflight.delete(key);
          });
        flight = { controller, promise };
        inflight.set(key, flight);
      }
      if (!signal) return flight.promise;
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ?? new DOMException('Aborted', 'AbortError'),
        );
      }
      return new Promise((resolve, reject) => {
        const abort = () =>
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        flight.promise.then(
          (value) => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) abort();
            else resolve(value);
          },
          (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
      });
    },
    destroy() {
      cache.clear();
      for (const flight of inflight.values()) flight.controller.abort();
      inflight.clear();
    },
  };
}

function tileUrl(template, z, x, y) {
  return template
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y));
}

/**
 * Decoded z≤14 boundary tiles. Metadata comes from the OpenFreeMap TileJSON
 * helper so the tile origin check stays in one place. One caller's abort does
 * not cancel a shared read; destroy() does.
 */
export function createOpenFreeMapBoundaryTiles({
  tileJsonUrl = 'https://tiles.openfreemap.org/planet',
  fetchImpl = (...args) => globalThis.fetch(...args),
  createSource = createOpenFreeMapSource,
  maxEntries = 32,
  timeoutMs = 12_000,
  maxResponseBytes = DEFAULT_TILE_BYTES,
} = {}) {
  const source = createSource({
    tileJsonUrl,
    fetchImpl,
    decode: () => ({}),
  });
  const cache = createBoundaryTileCache({ maxEntries });
  let templatePromise = null;

  function templateOf() {
    if (!templatePromise) {
      templatePromise = source
        .getMetadata()
        .then((meta) => {
          if (typeof meta?.template !== 'string') {
            throw new Error('Boundary tile template missing');
          }
          return meta.template;
        })
        .catch((error) => {
          templatePromise = null;
          throw error;
        });
    }
    return templatePromise;
  }

  async function load(z, x, y, signal) {
    const template = await templateOf();
    signal.throwIfAborted();
    const url = tileUrl(template, z, x, y);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 404) {
        await response.body?.cancel?.().catch(() => {});
        return { extent: 4096, features: [] };
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw Object.assign(
          new Error(`Boundary tile HTTP ${response.status}`),
          { status: response.status },
        );
      }
      const bytes = await readResponseBytesCapped(
        response,
        maxResponseBytes,
        controller.signal,
      );
      return boundaryFeaturesFromVectorTile(bytes);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    getTile({ z, x, y, signal }) {
      return cache.get(
        `${z}/${x}/${y}`,
        (shared) => load(z, x, y, shared),
        signal,
      );
    },
    destroy() {
      cache.destroy();
      source.clear?.();
    },
  };
}

function defaultCanvas() {
  if (typeof document !== 'undefined' && document.createElement) {
    return document.createElement('canvas');
  }
  return new OffscreenCanvas(256, 256);
}

function normalizedTile(payload) {
  if (Array.isArray(payload)) return { extent: 4096, features: payload };
  return {
    extent:
      Number.isInteger(payload?.extent) && payload.extent > 0
        ? payload.extent
        : 4096,
    features: payload?.features || [],
  };
}

/**
 * Canvas imagery provider. Levels above the source zoom redraw the ancestor's
 * sub-rectangle at a constant pixel width so overzoom stays crisp.
 */
export function createBoundaryImageryProvider({
  cesium,
  credit = OPENFREEMAP_BOUNDARY_CREDIT_HTML,
  tileSize = 256,
  maximumLevel = BOUNDARY_MAX_LEVEL,
  sourceMaxZoom = BOUNDARY_SOURCE_MAX_ZOOM,
  getTile,
  createCanvas = defaultCanvas,
  tilingScheme,
} = {}) {
  if (!cesium) throw new TypeError('Boundary imagery requires Cesium');
  if (typeof getTile !== 'function') {
    throw new TypeError('Boundary imagery requires a tile reader');
  }
  const scheme = tilingScheme || new cesium.WebMercatorTilingScheme();
  const creditObject =
    credit && typeof credit === 'object' && typeof credit.html === 'string'
      ? credit
      : new cesium.Credit(String(credit));
  return {
    tilingScheme: scheme,
    rectangle: scheme.rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    proxy: undefined,
    credit: creditObject,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: true,
    getTileCredits() {
      return undefined;
    },
    pickFeatures() {
      return undefined;
    },
    requestImage(x, y, level, request) {
      let window;
      try {
        if (!Number.isInteger(level) || level < 0 || level > maximumLevel) {
          throw new TypeError('Invalid boundary tile');
        }
        window = ancestorTile(x, y, level, { sourceMaxZoom });
      } catch (error) {
        return Promise.reject(error);
      }
      const controller = new AbortController();
      if (request) {
        request.cancelFunction = () => controller.abort();
        if (request.cancelled) controller.abort();
      }
      return getTile({
        z: window.z,
        x: window.x,
        y: window.y,
        signal: controller.signal,
      }).then((payload) => {
        if (controller.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const decoded = normalizedTile(payload);
        const frame = ancestorTile(x, y, level, {
          sourceMaxZoom,
          extent: decoded.extent,
        });
        const canvas = createCanvas();
        canvas.width = tileSize;
        canvas.height = tileSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Boundary tile canvas unavailable');
        drawBoundaryTile(ctx, decoded.features, frame, tileSize);
        return canvas;
      });
    },
    destroy() {},
  };
}

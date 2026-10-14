import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  OPENFREEMAP_BOUNDARY_CREDIT_HTML,
  boundaryFeaturesFromDecodedTile,
  boundaryFeaturesFromVectorTile,
  createBoundaryImageryProvider,
  createOpenFreeMapBoundaryTiles,
} from './boundaryTiles.js';

const fixture = readFileSync(
  new URL('../../data/fixtures/ofm-austin-14-3743-6745.pbf', import.meta.url),
);

function lineFeature(properties, ring) {
  return {
    type: 2,
    properties,
    loadGeometry: () => [ring.map(([x, y]) => ({ x, y }))],
  };
}

test('decoded boundary tiles keep lines and polygon rings only', () => {
  const decoded = boundaryFeaturesFromDecodedTile({
    layers: {
      boundary: {
        length: 4,
        extent: 4096,
        feature(index) {
          return [
            lineFeature({ admin_level: 2 }, [
              [0, 0],
              [8, 8],
            ]),
            {
              type: 1,
              properties: { admin_level: 2 },
              loadGeometry: () => [[{ x: 1, y: 1 }]],
            },
            {
              type: 3,
              properties: { admin_level: 4, maritime: 0 },
              loadGeometry: () => [
                [
                  { x: 0, y: 0 },
                  { x: 2, y: 0 },
                  { x: 2, y: 2 },
                ],
                [{ x: 1, y: 1 }],
              ],
            },
            lineFeature({ admin_level: 2 }, [[0, 0]]),
          ][index];
        },
      },
    },
  });
  assert.equal(decoded.extent, 4096);
  assert.equal(decoded.features.length, 2);
  assert.equal(decoded.features[1].rings.length, 1);
  assert.throws(
    () =>
      boundaryFeaturesFromDecodedTile({
        layers: { boundary: { length: 40_001, extent: 4096, feature() {} } },
      }),
    /feature limit/,
  );
  const live = boundaryFeaturesFromVectorTile(fixture);
  assert.ok(Array.isArray(live.features));
  assert.ok(live.features.every((feature) => feature.rings.length > 0));
});

function response({ status = 200, bytes = fixture } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    arrayBuffer: async () => bytes,
  };
}

test('boundary tile reads share one fetch, cache hits, and retry after failure', async () => {
  const urls = [];
  let metadataCalls = 0;
  let failMetadata = true;
  let status = 200;
  let held = null;
  const tiles = createOpenFreeMapBoundaryTiles({
    createSource: () => ({
      getMetadata: async () => {
        metadataCalls += 1;
        if (failMetadata) throw new Error('tilejson down');
        return {
          template: 'https://tiles.openfreemap.org/planet/v/{z}/{x}/{y}.pbf',
        };
      },
      clear() {},
    }),
    fetchImpl: (url, options) => {
      urls.push({ url, options });
      if (!held) return Promise.resolve(response({ status }));
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
        held.push(() => resolve(response({ status })));
      });
    },
  });
  await assert.rejects(tiles.getTile({ z: 14, x: 1, y: 2 }), /tilejson down/);
  failMetadata = false;
  held = [];
  const firstController = new AbortController();
  const first = tiles.getTile({
    z: 14,
    x: 1,
    y: 2,
    signal: firstController.signal,
  });
  const second = tiles.getTile({ z: 14, x: 1, y: 2 });
  while (held.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 1);
  firstController.abort();
  await assert.rejects(first, /Abort/);
  const finish = held[0];
  held = null;
  finish();
  const loaded = await second;
  assert.ok(loaded.features.length >= 0);
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0].url,
    'https://tiles.openfreemap.org/planet/v/14/1/2.pbf',
  );
  assert.equal(urls[0].options.redirect, 'error');
  urls.length = 0;
  await tiles.getTile({ z: 14, x: 1, y: 2 });
  assert.equal(urls.length, 0);
  status = 500;
  await assert.rejects(tiles.getTile({ z: 14, x: 3, y: 4 }), /HTTP 500/);
  status = 404;
  const missing = await tiles.getTile({ z: 14, x: 3, y: 4 });
  assert.deepEqual(missing.features, []);
  assert.equal(metadataCalls, 2);
  tiles.destroy();
});

function recordingCanvas() {
  const ctx = {
    ops: [],
    lineWidth: 0,
    strokeStyle: '',
    lineJoin: '',
    lineCap: '',
    dash: [],
    clearRect(...args) {
      ctx.ops.push(['clearRect', ...args]);
    },
    beginPath() {},
    moveTo(x, y) {
      ctx.ops.push(['moveTo', x, y]);
    },
    lineTo(x, y) {
      ctx.ops.push(['lineTo', x, y]);
    },
    setLineDash(dash) {
      ctx.dash = [...dash];
    },
    stroke() {
      ctx.ops.push(['stroke', ctx.lineWidth, ctx.strokeStyle]);
    },
  };
  return {
    width: 0,
    height: 0,
    ctx,
    getContext() {
      return ctx;
    },
  };
}

test('the imagery provider redraws the z14 ancestor and advertises alpha', async () => {
  const asked = [];
  const canvas = recordingCanvas();
  const provider = createBoundaryImageryProvider({
    cesium: Cesium,
    createCanvas: () => canvas,
    getTile: async (query) => {
      asked.push(query);
      return {
        extent: 4096,
        features: [
          {
            properties: { admin_level: 2 },
            rings: [
              [
                [0, 0],
                [4096, 4096],
              ],
            ],
          },
        ],
      };
    },
  });
  assert.equal(provider.ready, true);
  assert.equal(provider.hasAlphaChannel, true);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.tileHeight, 256);
  assert.equal(provider.maximumLevel, 20);
  assert.equal(provider.credit.html, OPENFREEMAP_BOUNDARY_CREDIT_HTML);
  assert.match(provider.credit.html, /OpenFreeMap/);
  assert.match(provider.credit.html, /©/);
  assert.match(provider.credit.html, /OpenMapTiles/);
  assert.match(provider.credit.html, /Data from/);
  assert.match(provider.credit.html, /OpenStreetMap/);
  const image = await provider.requestImage(3, 5, 15);
  assert.equal(image, canvas);
  assert.equal(canvas.width, 256);
  assert.deepEqual(
    asked.map(({ z, x, y }) => [z, x, y]),
    [[14, 1, 2]],
  );
  assert.ok(canvas.ctx.ops.some((op) => op[0] === 'moveTo' && op[1] === -256));
  assert.deepEqual(
    canvas.ctx.ops.filter((op) => op[0] === 'stroke').map((op) => op[1]),
    [5, 3],
  );
  await assert.rejects(provider.requestImage(0, 0, 21), TypeError);
  const request = { cancelled: true };
  await assert.rejects(provider.requestImage(0, 0, 0, request), /Abort/);
  assert.equal(typeof request.cancelFunction, 'function');
});

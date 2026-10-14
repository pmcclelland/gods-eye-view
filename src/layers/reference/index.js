import * as Cesium from 'cesium';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import {
  ESRI_REFERENCE_CREDIT_HTML,
  ESRI_WORLD_BOUNDARIES_AND_PLACES_URL,
  ESRI_WORLD_TRANSPORTATION_URL,
  createEsriReferenceImagery,
} from '../../maps/imagery.js';
import {
  createBoundaryImageryProvider,
  createOpenFreeMapBoundaryTiles,
} from './boundaryTiles.js';
import { forgetReferenceImagery, orderReferenceImagery } from './ordering.js';

const REFERENCE_LAYER_SPECS = Object.freeze([
  Object.freeze({
    id: 'reference-boundaries',
    name: 'Boundaries',
    icon: '▦',
    source: 'OpenFreeMap',
    priority: 0,
    kind: 'boundaries',
  }),
  Object.freeze({
    id: 'reference-roads',
    name: 'Roads',
    icon: '═',
    source: 'Esri World Transportation',
    priority: 1,
    kind: 'esri',
    url: ESRI_WORLD_TRANSPORTATION_URL,
  }),
  Object.freeze({
    id: 'reference-labels',
    name: 'Labels',
    icon: 'Aa',
    source: 'Esri Boundaries and Places',
    priority: 2,
    kind: 'esri',
    url: ESRI_WORLD_BOUNDARIES_AND_PLACES_URL,
  }),
]);

function defaultImageryLayer(cesium, provider) {
  const imagery = new cesium.ImageryLayer(provider);
  imagery.alpha = 1;
  return imagery;
}

function containsLayer(collection, imagery) {
  if (!collection || collection.isDestroyed?.()) return false;
  if (typeof collection.contains === 'function') {
    return collection.contains(imagery);
  }
  return collection.indexOf?.(imagery) >= 0;
}

// Cesium 1.138 does not collect credits from imagery draped on a 3D tileset.
// Static credits are de-duped by Credit equality (same html shares one id) but
// removeStaticCredit matches the registered object, so shared text is refcounted.
const staticCreditHolds = new WeakMap();

function creditHoldKey(credit) {
  return `${credit.html}\0${credit.showOnScreen ? 1 : 0}`;
}

function referenceCredit(provider, spec, cesium) {
  const credit = provider?.credit;
  if (credit && typeof credit === 'object') return credit;
  const html =
    typeof credit === 'string' && credit
      ? credit
      : spec.kind === 'esri'
        ? ESRI_REFERENCE_CREDIT_HTML
        : '';
  return html ? new cesium.Credit(html) : null;
}

function retainStaticCredit(display, credit) {
  let holds = staticCreditHolds.get(display);
  if (!holds) {
    holds = new Map();
    staticCreditHolds.set(display, holds);
  }
  const key = creditHoldKey(credit);
  const existing = holds.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  display.addStaticCredit(credit);
  holds.set(key, { credit, count: 1 });
}

function releaseStaticCredit(display, credit) {
  const holds = staticCreditHolds.get(display);
  const key = creditHoldKey(credit);
  const existing = holds?.get(key);
  if (!existing) {
    display.removeStaticCredit(credit);
    return;
  }
  existing.count -= 1;
  if (existing.count > 0) return;
  holds.delete(key);
  display.removeStaticCredit(existing.credit);
}

/**
 * Three independent draped overlays. Each owns its imagery layer and follows
 * the active imagery host (globe, or the photoreal tileset when the globe is
 * hidden). A host of kind `none` leaves the toggle on and reports
 * NO_IMAGERY_HOST.
 */
function createReferenceLayer(spec, options) {
  const cesium = options.cesium || Cesium;
  const eventTarget =
    options.eventTarget === undefined ? globalThis.window : options.eventTarget;
  const createLayer =
    options.createImageryLayer ||
    ((provider) => defaultImageryLayer(cesium, provider));
  let viewer = null;
  let enabled = false;
  let destroyed = false;
  let imageryHost = null;
  let listener = null;
  let imagery = null;
  let provider = null;
  let collection = null;
  let hostKind = null;
  let shownAt = null;
  let epoch = 0;
  let tail = Promise.resolve();
  let listening = false;
  let creditRegistration = null;

  const getHost = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers,
      kind: 'globe',
    };

  const notify = () => listener?.();

  function detachFrom(from) {
    if (!imagery || !containsLayer(from, imagery)) return;
    from.remove(imagery, false);
  }

  function showTilesetCredit() {
    if (creditRegistration || !provider) return;
    const credit = referenceCredit(provider, spec, cesium);
    const display = viewer?.scene?.frameState?.creditDisplay;
    if (!credit || typeof display?.addStaticCredit !== 'function') return;
    try {
      retainStaticCredit(display, credit);
      creditRegistration = { display, credit };
    } catch {
      creditRegistration = null;
    }
  }

  function hideTilesetCredit() {
    const current = creditRegistration;
    if (!current) return;
    creditRegistration = null;
    if (typeof current.display?.removeStaticCredit !== 'function') return;
    try {
      releaseStaticCredit(current.display, current.credit);
    } catch {
      /* The credit display can already be gone during teardown. */
    }
  }

  function destroyImagery() {
    hideTilesetCredit();
    detachFrom(collection);
    collection = null;
    if (imagery) {
      forgetReferenceImagery(imagery);
      if (!imagery.isDestroyed?.()) imagery.destroy?.();
    }
    provider?.destroy?.();
    imagery = null;
    provider = null;
    viewer?.scene?.requestRender?.();
  }

  async function makeProvider() {
    if (options.createProvider) return options.createProvider(spec);
    if (spec.kind === 'esri') {
      return createEsriReferenceImagery(spec.url, { fromUrl: options.fromUrl });
    }
    const tiles = createOpenFreeMapBoundaryTiles(options.boundaryTileOptions);
    const boundaryProvider = createBoundaryImageryProvider({
      cesium,
      getTile: (query) => tiles.getTile(query),
      createCanvas: options.createCanvas,
    });
    const baseDestroy = boundaryProvider.destroy;
    boundaryProvider.destroy = () => {
      baseDestroy?.();
      tiles.destroy();
    };
    return boundaryProvider;
  }

  function mount(host) {
    if (collection && collection !== host.collection) {
      detachFrom(collection);
      collection = null;
    }
    if (!containsLayer(host.collection, imagery)) host.collection.add(imagery);
    collection = host.collection;
    imagery.show = true;
    imagery.alpha = 1;
    hostKind = host.kind;
    orderReferenceImagery(collection, imagery, spec.priority);
    if (host.kind === 'tileset') showTilesetCredit();
    else hideTilesetCredit();
    if (!shownAt) shownAt = Date.now();
    viewer?.scene?.requestRender?.();
    notify();
  }

  function park() {
    hideTilesetCredit();
    hostKind = 'none';
    shownAt = null;
    detachFrom(collection);
    collection = null;
    if (imagery) imagery.show = false;
    viewer?.scene?.requestRender?.();
    notify();
  }

  async function sync(token) {
    if (destroyed || !enabled || token !== epoch) return;
    const host = getHost();
    if (!host?.collection || host.kind === 'none') {
      park();
      return;
    }
    if (!provider) {
      const created = await makeProvider();
      if (destroyed || !enabled || token !== epoch) {
        created?.destroy?.();
        return;
      }
      const latest = getHost();
      if (!latest?.collection || latest.kind === 'none') {
        provider = created;
        imagery = createLayer(provider);
        imagery.alpha = 1;
        imagery.show = false;
        park();
        return;
      }
      provider = created;
      imagery = createLayer(provider);
      imagery.alpha = 1;
    }
    if (destroyed || !enabled || token !== epoch) return;
    const latest = getHost();
    if (!latest?.collection || latest.kind === 'none') {
      park();
      return;
    }
    mount(latest);
  }

  function enqueue() {
    const token = epoch;
    const run = tail.then(() => sync(token));
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  const onMapStackChanged = () => {
    if (enabled && !destroyed) void enqueue();
  };

  return {
    id: spec.id,
    name: spec.name,
    icon: spec.icon,
    source: spec.source,
    init(nextViewer) {
      viewer = nextViewer;
      if (!listening && eventTarget?.addEventListener) {
        eventTarget.addEventListener(
          'gev:map-stack-changed',
          onMapStackChanged,
        );
        listening = true;
      }
    },
    enable() {
      if (destroyed) return false;
      enabled = true;
      return enqueue();
    },
    async disable() {
      enabled = false;
      epoch += 1;
      await tail;
      if (!destroyed) {
        destroyImagery();
        hostKind = null;
        shownAt = null;
        notify();
      }
    },
    async update() {
      if (destroyed || !enabled) return false;
      await enqueue();
      return true;
    },
    async destroy() {
      destroyed = true;
      enabled = false;
      epoch += 1;
      await tail;
      destroyImagery();
      if (listening) {
        eventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          onMapStackChanged,
        );
      }
      listening = false;
      imageryHost = null;
      listener = null;
      viewer = null;
      hostKind = null;
      shownAt = null;
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      if (enabled && !destroyed) void enqueue();
    },
    getRowControls() {
      if (enabled && hostKind === 'none') return { info: NO_IMAGERY_HOST };
      return null;
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      const hidden = enabled && hostKind === 'none';
      return {
        count: hidden || !shownAt ? 0 : 1,
        lastUpdate: hidden ? null : shownAt,
        error: hidden ? NO_IMAGERY_HOST : null,
      };
    },
  };
}

/** Catalog layers for Roads, Labels, and Boundaries. */
export function createReferenceLayers(options = {}) {
  return REFERENCE_LAYER_SPECS.map((spec) =>
    createReferenceLayer(spec, options),
  );
}

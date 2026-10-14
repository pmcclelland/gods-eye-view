import assert from 'node:assert/strict';
import test from 'node:test';
import { ESRI_REFERENCE_CREDIT_HTML } from '../../maps/imagery.js';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { createReferenceLayers } from './index.js';

function collection() {
  const layers = [];
  return {
    get length() {
      return layers.length;
    },
    get(index) {
      return layers[index];
    },
    add(layer) {
      if (layers.includes(layer)) throw new Error('duplicate imagery layer');
      layers.push(layer);
    },
    remove(layer, destroy) {
      const index = layers.indexOf(layer);
      if (index < 0) return false;
      layers.splice(index, 1);
      if (destroy) layer.destroy?.();
      return true;
    },
    contains(layer) {
      return layers.includes(layer);
    },
    indexOf(layer) {
      return layers.indexOf(layer);
    },
    raise(layer) {
      const index = layers.indexOf(layer);
      if (index < 0 || index === layers.length - 1) return;
      const [item] = layers.splice(index, 1);
      layers.splice(index + 1, 0, item);
    },
    lower(layer) {
      const index = layers.indexOf(layer);
      if (index <= 0) return;
      const [item] = layers.splice(index, 1);
      layers.splice(index - 1, 0, item);
    },
    raiseToTop(layer) {
      const index = layers.indexOf(layer);
      if (index < 0) return;
      layers.splice(index, 1);
      layers.push(layer);
    },
    isDestroyed() {
      return false;
    },
    ids() {
      return layers.map((layer) => layer.id);
    },
  };
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

function harness(hostCollection = collection()) {
  const base = { id: 'base' };
  const recent = { id: 'recent' };
  const weather = { id: 'weather' };
  hostCollection.add(base);
  hostCollection.add(recent);
  hostCollection.add(weather);
  orderWeatherImagery(hostCollection, weather, 2);
  let host = { collection: hostCollection, kind: 'globe' };
  const listeners = new Set();
  const eventTarget = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    dispatch() {
      for (const listener of [...listeners]) listener();
    },
  };
  const providers = [];
  const layers = createReferenceLayers({
    eventTarget,
    createProvider: async (spec) => {
      const provider = {
        id: spec.id,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      providers.push(provider);
      return provider;
    },
    createImageryLayer(provider) {
      return {
        id: provider.id,
        provider,
        alpha: 0,
        show: false,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
    },
  });
  const viewer = {
    imageryLayers: hostCollection,
    scene: { requestRender() {} },
  };
  for (const layer of layers) {
    layer.init(viewer);
    layer.attachShellServices({ imageryHost: () => host });
  }
  return {
    collection: hostCollection,
    layers,
    providers,
    eventTarget,
    listenerCount: () => listeners.size,
    setHost(next) {
      host = next;
    },
    byId(id) {
      return layers.find((layer) => layer.id === id);
    },
  };
}

test('reference overlays stack above the basemap and below other imagery', async () => {
  const order = [
    'base',
    'reference-boundaries',
    'reference-roads',
    'reference-labels',
    'recent',
    'weather',
  ];
  for (const enabled of permutations([
    'reference-boundaries',
    'reference-roads',
    'reference-labels',
  ])) {
    const scene = harness();
    for (const id of enabled) await scene.byId(id).enable();
    assert.deepEqual(scene.collection.ids(), order);
    for (const id of enabled) {
      const imagery = scene.collection
        .ids()
        .map((item, index) => scene.collection.get(index))
        .find((item) => item.id === id);
      assert.equal(imagery.alpha, 1);
      assert.equal(imagery.show, true);
    }
    for (const layer of scene.layers) await layer.destroy();
  }
});

test('one or two reference toggles keep the same relative order', async () => {
  const scene = harness();
  await scene.byId('reference-labels').enable();
  await scene.byId('reference-boundaries').enable();
  assert.deepEqual(scene.collection.ids(), [
    'base',
    'reference-boundaries',
    'reference-labels',
    'recent',
    'weather',
  ]);
  await scene.byId('reference-labels').disable();
  assert.deepEqual(scene.collection.ids(), [
    'base',
    'reference-boundaries',
    'recent',
    'weather',
  ]);
  assert.equal(
    scene.providers.find((provider) => provider.id === 'reference-labels')
      .destroyed,
    true,
  );
  await scene.byId('reference-roads').enable();
  assert.deepEqual(scene.collection.ids(), [
    'base',
    'reference-boundaries',
    'reference-roads',
    'recent',
    'weather',
  ]);
});

test('reference overlays follow the imagery host across globe, tileset, and none', async () => {
  const globe = collection();
  const scene = harness(globe);
  const tileset = collection();
  const weather = { id: 'weather' };
  tileset.add(weather);
  orderWeatherImagery(tileset, weather, 1);
  for (const layer of scene.layers) await layer.enable();
  assert.deepEqual(globe.ids().slice(0, 4), [
    'base',
    'reference-boundaries',
    'reference-roads',
    'reference-labels',
  ]);
  assert.equal(scene.byId('reference-roads').getStats().error, null);
  assert.equal(scene.byId('reference-roads').getStats().count, 1);
  assert.equal(scene.byId('reference-roads').getRowControls(), null);

  scene.setHost({ collection: tileset, kind: 'tileset' });
  scene.eventTarget.dispatch();
  for (const layer of scene.layers) await layer.update();
  assert.deepEqual(globe.ids(), ['base', 'recent', 'weather']);
  assert.deepEqual(tileset.ids(), [
    'reference-boundaries',
    'reference-roads',
    'reference-labels',
    'weather',
  ]);

  scene.setHost({ collection: null, kind: 'none' });
  scene.eventTarget.dispatch();
  for (const layer of scene.layers) await layer.update();
  assert.deepEqual(tileset.ids(), ['weather']);
  for (const layer of scene.layers) {
    assert.equal(layer.getStats().error, NO_IMAGERY_HOST);
    assert.equal(layer.getStats().count, 0);
    assert.equal(layer.getStats().lastUpdate, null);
    assert.equal(layer.getRowControls().info, NO_IMAGERY_HOST);
  }
  assert.equal(scene.providers.length, 3);
  assert.ok(scene.providers.every((provider) => provider.destroyed === false));

  scene.setHost({ collection: globe, kind: 'globe' });
  scene.eventTarget.dispatch();
  for (const layer of scene.layers) await layer.update();
  assert.deepEqual(globe.ids(), [
    'base',
    'reference-boundaries',
    'reference-roads',
    'reference-labels',
    'recent',
    'weather',
  ]);
  assert.deepEqual(tileset.ids(), ['weather']);
  assert.equal(scene.providers.length, 3);
  assert.equal(scene.byId('reference-labels').getStats().error, null);

  const before = scene.listenerCount();
  for (const layer of scene.layers) await layer.destroy();
  assert.equal(scene.listenerCount(), 0);
  assert.ok(before > 0);
  assert.deepEqual(globe.ids(), ['base', 'recent', 'weather']);
  assert.ok(scene.providers.every((provider) => provider.destroyed === true));
  scene.eventTarget.dispatch();
  assert.deepEqual(globe.ids(), ['base', 'recent', 'weather']);
});

test('a hidden host is reported without creating imagery, including over a weather-only tileset', async () => {
  const scene = harness();
  scene.setHost({ collection: null, kind: 'none' });
  await scene.byId('reference-roads').enable();
  assert.equal(scene.providers.length, 0);
  assert.equal(scene.byId('reference-roads').getStats().error, NO_IMAGERY_HOST);
  const tileset = collection();
  const weather = { id: 'weather' };
  tileset.add(weather);
  orderWeatherImagery(tileset, weather, 1);
  scene.setHost({ collection: tileset, kind: 'tileset' });
  scene.eventTarget.dispatch();
  await scene.byId('reference-roads').update();
  await scene.byId('reference-boundaries').enable();
  assert.deepEqual(tileset.ids(), [
    'reference-boundaries',
    'reference-roads',
    'weather',
  ]);
});

test('disabling during provider creation does not attach the imagery layer', async () => {
  let release;
  let created = null;
  const globe = collection();
  globe.add({ id: 'base' });
  const layer = createReferenceLayers({
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    createProvider: (spec) =>
      new Promise((resolve) => {
        release = () => {
          created = {
            id: spec.id,
            destroyed: false,
            destroy() {
              this.destroyed = true;
            },
          };
          resolve(created);
        };
      }),
    createImageryLayer: (provider) => ({
      id: provider.id,
      provider,
      alpha: 1,
      show: true,
      destroy() {},
    }),
  })[1];
  layer.init({ imageryLayers: globe, scene: { requestRender() {} } });
  const enabling = layer.enable();
  await new Promise((resolve) => setImmediate(resolve));
  const disabling = layer.disable();
  release();
  await enabling;
  await disabling;
  assert.equal(created.destroyed, true);
  assert.deepEqual(globe.ids(), ['base']);
});

test('an in-flight provider lands on the host that is current when it resolves', async () => {
  let release;
  const globe = collection();
  const tileset = collection();
  globe.add({ id: 'base' });
  let host = { collection: globe, kind: 'globe' };
  const layer = createReferenceLayers({
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    createProvider: () =>
      new Promise((resolve) => {
        release = () => resolve({ id: 'reference-roads', destroy() {} });
      }),
    createImageryLayer: (provider) => ({
      id: provider.id,
      provider,
      alpha: 1,
      show: true,
      destroy() {},
    }),
  }).find((item) => item.id === 'reference-roads');
  layer.init({ imageryLayers: globe, scene: { requestRender() {} } });
  layer.attachShellServices({ imageryHost: () => host });
  const enabling = layer.enable();
  await new Promise((resolve) => setImmediate(resolve));
  host = { collection: tileset, kind: 'tileset' };
  release();
  await enabling;
  assert.deepEqual(globe.ids(), ['base']);
  assert.deepEqual(tileset.ids(), ['reference-roads']);
});

function staticCreditDisplay() {
  const credits = [];
  return {
    credits,
    adds: 0,
    addStaticCredit(credit) {
      this.adds += 1;
      const duplicate = credits.some(
        (item) =>
          item === credit ||
          (item.html === credit.html &&
            Boolean(item.showOnScreen) === Boolean(credit.showOnScreen)),
      );
      if (!duplicate) credits.push(credit);
    },
    removeStaticCredit(credit) {
      const index = credits.indexOf(credit);
      if (index >= 0) credits.splice(index, 1);
    },
    htmls() {
      return credits.map((credit) => credit.html);
    },
  };
}

function creditScene(createProvider) {
  const display = staticCreditDisplay();
  const globe = collection();
  const tileset = collection();
  globe.add({ id: 'base' });
  let host = { collection: globe, kind: 'globe' };
  const layers = createReferenceLayers({
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    createProvider,
    createImageryLayer(provider) {
      return {
        id: provider.id,
        provider,
        alpha: 1,
        show: true,
        destroy() {
          this.destroyed = true;
        },
      };
    },
  });
  const viewer = {
    imageryLayers: globe,
    scene: {
      requestRender() {},
      frameState: { creditDisplay: display },
    },
  };
  for (const layer of layers) {
    layer.init(viewer);
    layer.attachShellServices({ imageryHost: () => host });
  }
  return {
    display,
    globe,
    tileset,
    layers,
    byId(id) {
      return layers.find((layer) => layer.id === id);
    },
    setHost(next) {
      host = next;
    },
  };
}

test('tileset draping registers static credits and removes them off the tileset', async () => {
  const scene = creditScene(async (spec) => ({
    id: spec.id,
    credit:
      spec.kind === 'esri'
        ? { html: 'Esri reference', showOnScreen: false }
        : { html: 'OpenFreeMap', showOnScreen: false },
    destroy() {},
  }));

  for (const layer of scene.layers) await layer.enable();
  assert.deepEqual(scene.display.credits, []);

  scene.setHost({ collection: scene.tileset, kind: 'tileset' });
  for (const layer of scene.layers) await layer.update();
  assert.deepEqual(scene.display.htmls(), ['OpenFreeMap', 'Esri reference']);
  assert.equal(scene.display.adds, 2);

  for (const layer of scene.layers) await layer.update();
  assert.equal(scene.display.adds, 2);

  await scene.byId('reference-roads').disable();
  assert.deepEqual(scene.display.htmls(), ['OpenFreeMap', 'Esri reference']);
  await scene.byId('reference-labels').disable();
  assert.deepEqual(scene.display.htmls(), ['OpenFreeMap']);

  scene.setHost({ collection: scene.globe, kind: 'globe' });
  await scene.byId('reference-boundaries').update();
  assert.deepEqual(scene.display.credits, []);

  scene.setHost({ collection: scene.tileset, kind: 'tileset' });
  await scene.byId('reference-boundaries').update();
  await scene.byId('reference-roads').enable();
  await scene.byId('reference-labels').enable();
  assert.deepEqual(scene.display.htmls(), ['OpenFreeMap', 'Esri reference']);

  scene.setHost({ collection: null, kind: 'none' });
  for (const layer of scene.layers) await layer.update();
  assert.deepEqual(scene.display.credits, []);

  scene.setHost({ collection: scene.tileset, kind: 'tileset' });
  for (const layer of scene.layers) await layer.update();
  assert.deepEqual(scene.display.htmls(), ['OpenFreeMap', 'Esri reference']);

  for (const layer of scene.layers) await layer.destroy();
  assert.deepEqual(scene.display.credits, []);
});

test('an Esri tileset credit uses provider.credit and falls back to the HTML constant', async () => {
  const scene = creditScene(async (spec) => ({
    id: spec.id,
    credit: spec.id === 'reference-roads' ? 'Road credit' : undefined,
    destroy() {},
  }));
  scene.setHost({ collection: scene.tileset, kind: 'tileset' });
  await scene.byId('reference-roads').enable();
  await scene.byId('reference-labels').enable();
  assert.deepEqual(scene.display.htmls(), [
    'Road credit',
    ESRI_REFERENCE_CREDIT_HTML,
  ]);
  assert.equal(scene.display.credits[1].showOnScreen, false);
  await scene.byId('reference-roads').disable();
  assert.deepEqual(scene.display.htmls(), [ESRI_REFERENCE_CREDIT_HTML]);
  await scene.byId('reference-labels').destroy();
  assert.deepEqual(scene.display.credits, []);
});

test('a throwing credit display still mounts the tileset overlay', async () => {
  const scene = creditScene(async (spec) => ({
    id: spec.id,
    credit: { html: 'Esri reference', showOnScreen: false },
    destroy() {},
  }));
  scene.display.addStaticCredit = () => {
    throw new Error('credit display unavailable');
  };
  scene.setHost({ collection: scene.tileset, kind: 'tileset' });
  await scene.byId('reference-roads').enable();
  assert.deepEqual(scene.tileset.ids(), ['reference-roads']);
  assert.equal(scene.byId('reference-roads').getStats().error, null);
  await scene.byId('reference-roads').destroy();
});

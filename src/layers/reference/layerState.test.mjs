import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
} from '../../data/layerState.js';

const IDS = ['reference-boundaries', 'reference-labels', 'reference-roads'];

function roundTrip(enabledLayerIds) {
  const state = createDefaultLayerState();
  state.enabledLayerIds = enabledLayerIds;
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, state);
  return {
    token: params.get('l'),
    enabled: decodeLayerStateParams(params).enabledLayerIds,
  };
}

test('reference overlay tokens round-trip independently and in registry order', () => {
  assert.deepEqual(roundTrip(['reference-boundaries']), {
    token: '3',
    enabled: ['reference-boundaries'],
  });
  assert.deepEqual(roundTrip(['reference-labels']), {
    token: '4',
    enabled: ['reference-labels'],
  });
  assert.deepEqual(roundTrip(['reference-roads']), {
    token: '5',
    enabled: ['reference-roads'],
  });
  assert.deepEqual(roundTrip(['reference-labels', 'reference-roads']), {
    token: '4.5',
    enabled: ['reference-labels', 'reference-roads'],
  });
  assert.deepEqual(roundTrip(['reference-roads', 'reference-boundaries']), {
    token: '3.5',
    enabled: ['reference-boundaries', 'reference-roads'],
  });
  assert.deepEqual(roundTrip([...IDS].reverse()), {
    token: '3.4.5',
    enabled: IDS,
  });
  assert.deepEqual(roundTrip([]), { token: '', enabled: [] });
});

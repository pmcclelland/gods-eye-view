import { isOrderedWeatherImagery } from '../weather/imageryOrder.js';

const priorities = new WeakMap();

/**
 * Reference overlays sit immediately above the current bottom imagery layer
 * and below every other foreign layer (weather, recent imagery, and anything
 * else already draped). Bottom→top among the three is Boundaries, Roads,
 * Labels, independent of enable order.
 *
 * The bottom layer is kept only when it is not itself weather or a reference
 * overlay. A photoreal tileset whose only draped layer is weather therefore
 * keeps weather above the reference block. A tileset whose only layer is
 * recent imagery treats that layer as the bottom.
 */
export function orderReferenceImagery(collection, layer, priority) {
  priorities.set(layer, priority);
  if (
    typeof collection?.get !== 'function' ||
    typeof collection.raise !== 'function' ||
    typeof collection.lower !== 'function' ||
    typeof collection.indexOf !== 'function' ||
    typeof collection.length !== 'number'
  ) {
    return;
  }
  const all = [];
  for (let i = 0; i < collection.length; i += 1) all.push(collection.get(i));
  if (!all.includes(layer)) return;
  const refs = all
    .filter((item) => priorities.has(item))
    .sort((a, b) => priorities.get(a) - priorities.get(b));
  const foreign = all.filter((item) => !priorities.has(item));
  const preserveBottom =
    foreign.length > 0 &&
    !priorities.has(all[0]) &&
    !isOrderedWeatherImagery(all[0]);
  const above = preserveBottom ? foreign.slice(1) : foreign;
  const desired = preserveBottom
    ? [foreign[0], ...refs, ...above]
    : [...refs, ...above];
  for (let target = 0; target < desired.length; target += 1) {
    const item = desired[target];
    let index = collection.indexOf(item);
    let guard = 0;
    while (index > target && guard <= desired.length) {
      collection.lower(item);
      const next = collection.indexOf(item);
      if (next >= index) break;
      index = next;
      guard += 1;
    }
  }
}

/** Drop a destroyed imagery layer so a later instance can take its slot. */
export function forgetReferenceImagery(layer) {
  priorities.delete(layer);
}

const priorities = new WeakMap();

/** True once a layer has been parked by orderWeatherImagery. */
export function isOrderedWeatherImagery(layer) {
  return priorities.has(layer);
}

/** Scalar context, infrared, radar, then lightning: independent of enable order. */
export function orderWeatherImagery(collection, layer, priority) {
  priorities.set(layer, priority);
  if (typeof collection.raiseToTop !== 'function') return;
  const weather = [];
  for (let i = 0; i < collection.length; i++) {
    const item = collection.get(i);
    if (priorities.has(item)) weather.push(item);
  }
  const ordered = [...weather].sort(
    (a, b) => priorities.get(a) - priorities.get(b),
  );
  if (weather.every((item, i) => item === ordered[i])) return;
  for (const item of ordered) collection.raiseToTop(item);
}

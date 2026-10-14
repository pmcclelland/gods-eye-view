/** OpenFreeMap / OpenMapTiles publishes boundary geometry through zoom 14. */
export const BOUNDARY_SOURCE_MAX_ZOOM = 14;

/** Cesium may ask past the source zoom; vectors are redrawn, not upsampled. */
export const BOUNDARY_MAX_LEVEL = 20;

/** OpenMapTiles extent. Tile coordinates are y-down, matching canvas and XYZ. */
export const BOUNDARY_TILE_EXTENT = 4096;

const COUNTRY_DASH = Object.freeze([12, 7]);
const REGION_DASH = Object.freeze([9, 6]);
const LOCAL_DASH = Object.freeze([5, 4]);

function flagOn(value) {
  return value === 1 || value === true || value === '1';
}

/** Maritime boundaries are omitted so ocean imagery stays uncluttered. */
export function isMaritimeBoundary(properties) {
  return flagOn(properties?.maritime);
}

export function isDisputedBoundary(properties) {
  return flagOn(properties?.disputed);
}

/** Integer admin levels 2–6. Municipal and non-numeric levels are ignored. */
export function boundaryAdminLevel(properties) {
  const level = Number(properties?.admin_level);
  if (!Number.isInteger(level) || level < 2 || level > 6) return null;
  return level;
}

/**
 * Stroke style for one boundary, or null when the feature is not drawn.
 * Levels 3–4 are solid unless disputed. Levels 5–6 are always dashed.
 * The casing stays solid; only the light line takes the dash.
 */
export function boundaryLineStyle(properties) {
  if (isMaritimeBoundary(properties)) return null;
  const adminLevel = boundaryAdminLevel(properties);
  if (adminLevel == null) return null;
  const disputed = isDisputedBoundary(properties);
  if (adminLevel === 2) {
    return {
      adminLevel,
      lineWidth: 3,
      lineColor: '#ffffff',
      casingWidth: 5,
      casingColor: 'rgba(0,0,0,0.55)',
      dashed: disputed,
      dash: COUNTRY_DASH,
    };
  }
  if (adminLevel <= 4) {
    return {
      adminLevel,
      lineWidth: 2,
      lineColor: '#ffe08a',
      casingWidth: 4,
      casingColor: 'rgba(0,0,0,0.5)',
      dashed: disputed,
      dash: REGION_DASH,
    };
  }
  return {
    adminLevel,
    lineWidth: 1.25,
    lineColor: 'rgba(255,255,255,0.85)',
    casingWidth: 2.5,
    casingColor: 'rgba(0,0,0,0.4)',
    dashed: true,
    dash: LOCAL_DASH,
  };
}

/**
 * Map a Web Mercator request onto the source tile that contains it and the
 * sub-rectangle of that tile's extent the request covers. Levels above
 * `sourceMaxZoom` share their ancestor; the span shrinks so the redraw stays
 * in destination pixels instead of scaling a bitmap.
 */
export function ancestorTile(
  x,
  y,
  level,
  {
    sourceMaxZoom = BOUNDARY_SOURCE_MAX_ZOOM,
    extent = BOUNDARY_TILE_EXTENT,
  } = {},
) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(level) ||
    level < 0 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** level ||
    y >= 2 ** level ||
    !Number.isInteger(extent) ||
    extent <= 0
  ) {
    throw new TypeError('Invalid boundary tile');
  }
  const ancestorLevel = Math.min(level, sourceMaxZoom);
  const shift = level - ancestorLevel;
  const spanTiles = 2 ** shift;
  const span = extent / spanTiles;
  const subX = x % spanTiles;
  const subY = y % spanTiles;
  return {
    z: ancestorLevel,
    x: Math.floor(x / spanTiles),
    y: Math.floor(y / spanTiles),
    subX,
    subY,
    spanTiles,
    originX: subX * span,
    originY: subY * span,
    span,
    extent,
  };
}

function ringPoints(ring) {
  if (!ring || ring.length < 2) return null;
  const points = [];
  for (const point of ring) {
    const px = Array.isArray(point) ? point[0] : point?.x;
    const py = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    points.push([px, py]);
  }
  return points.length >= 2 ? points : null;
}

/**
 * Project drawable boundary rings into a tile's pixel square.
 * Higher admin levels are painted first so country borders sit on top.
 * @param {Array<{ properties?: object, rings?: Array<Array> }>} features
 * @param {{ originX: number, originY: number, span: number }} window
 * @param {number} size Destination tile size in pixels.
 */
export function projectBoundaryPaths(features, window, size) {
  const scale = size / window.span;
  const paths = [];
  for (const feature of features || []) {
    const style = boundaryLineStyle(feature?.properties);
    if (!style) continue;
    for (const ring of feature.rings || []) {
      const points = ringPoints(ring);
      if (!points) continue;
      paths.push({
        style,
        rank: style.adminLevel,
        points: points.map(([px, py]) => [
          (px - window.originX) * scale,
          (py - window.originY) * scale,
        ]),
      });
    }
  }
  paths.sort((a, b) => b.rank - a.rank);
  return paths;
}

/** Stroke casing then the light line. Widths stay in destination pixels. */
export function strokeBoundaryPaths(ctx, paths) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  for (const pass of ['casing', 'line']) {
    for (const path of paths) {
      const dashed = pass === 'line' && path.style.dashed;
      ctx.beginPath();
      ctx.moveTo(path.points[0][0], path.points[0][1]);
      for (let i = 1; i < path.points.length; i += 1) {
        ctx.lineTo(path.points[i][0], path.points[i][1]);
      }
      ctx.setLineDash(dashed ? path.style.dash : []);
      ctx.lineWidth =
        pass === 'casing' ? path.style.casingWidth : path.style.lineWidth;
      ctx.strokeStyle =
        pass === 'casing' ? path.style.casingColor : path.style.lineColor;
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

/** Clear the tile, then stroke every accepted boundary. */
export function drawBoundaryTile(ctx, features, window, size) {
  ctx.clearRect(0, 0, size, size);
  strokeBoundaryPaths(ctx, projectBoundaryPaths(features, window, size));
}

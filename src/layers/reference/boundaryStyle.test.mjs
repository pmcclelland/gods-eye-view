import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ancestorTile,
  boundaryLineStyle,
  drawBoundaryTile,
  projectBoundaryPaths,
} from './boundaryStyle.js';

function fakeContext() {
  const ops = [];
  const ctx = {
    ops,
    lineWidth: 0,
    strokeStyle: '',
    lineJoin: '',
    lineCap: '',
    dash: [],
    clearRect(...args) {
      ops.push(['clearRect', ...args]);
    },
    beginPath() {
      ops.push(['beginPath']);
    },
    moveTo(x, y) {
      ops.push(['moveTo', x, y]);
    },
    lineTo(x, y) {
      ops.push(['lineTo', x, y]);
    },
    setLineDash(dash) {
      ctx.dash = [...dash];
      ops.push(['setLineDash', [...dash]]);
    },
    stroke() {
      ops.push(['stroke', ctx.lineWidth, ctx.strokeStyle, [...ctx.dash]]);
    },
  };
  return ctx;
}

test('boundary styles keep country, region, and local lines distinct', () => {
  assert.deepEqual(boundaryLineStyle({ admin_level: '2' }), {
    adminLevel: 2,
    lineWidth: 3,
    lineColor: '#ffffff',
    casingWidth: 5,
    casingColor: 'rgba(0,0,0,0.55)',
    dashed: false,
    dash: [12, 7],
  });
  const region = boundaryLineStyle({ admin_level: 4 });
  assert.equal(region.dashed, false);
  assert.equal(region.lineColor, '#ffe08a');
  assert.equal(region.casingWidth, 4);
  assert.equal(boundaryLineStyle({ admin_level: 4, disputed: 1 }).dashed, true);
  const county = boundaryLineStyle({ admin_level: '6' });
  assert.equal(county.dashed, true);
  assert.equal(county.lineWidth, 1.25);
  assert.equal(county.lineColor, 'rgba(255,255,255,0.85)');
  assert.equal(county.casingColor, 'rgba(0,0,0,0.4)');
  assert.equal(
    boundaryLineStyle({ admin_level: 2, disputed: '1' }).dashed,
    true,
  );
  assert.equal(boundaryLineStyle({ admin_level: 2, maritime: 1 }), null);
  assert.equal(boundaryLineStyle({ admin_level: 2, maritime: true }), null);
  assert.equal(boundaryLineStyle({ admin_level: 7 }), null);
  assert.equal(boundaryLineStyle({ admin_level: 1 }), null);
  assert.equal(boundaryLineStyle({ admin_level: 2.5 }), null);
  assert.equal(boundaryLineStyle({}), null);
});

test('ancestor tiles cover the source zoom and the z14 sub-rectangle above it', () => {
  assert.deepEqual(ancestorTile(5, 7, 14), {
    z: 14,
    x: 5,
    y: 7,
    subX: 0,
    subY: 0,
    spanTiles: 1,
    originX: 0,
    originY: 0,
    span: 4096,
    extent: 4096,
  });
  assert.deepEqual(ancestorTile(3, 5, 15), {
    z: 14,
    x: 1,
    y: 2,
    subX: 1,
    subY: 1,
    spanTiles: 2,
    originX: 2048,
    originY: 2048,
    span: 2048,
    extent: 4096,
  });
  assert.deepEqual(ancestorTile(5, 7, 16), {
    z: 14,
    x: 1,
    y: 1,
    subX: 1,
    subY: 3,
    spanTiles: 4,
    originX: 1024,
    originY: 3072,
    span: 1024,
    extent: 4096,
  });
  for (const args of [
    [-1, 0, 0],
    [1.5, 0, 1],
    [1, 0, 0],
    [0, 0, -1],
  ]) {
    assert.throws(() => ancestorTile(...args), TypeError);
  }
});

test('drawing paints casing under the light line and skips maritime features', () => {
  const window = ancestorTile(3, 5, 15);
  const features = [
    {
      properties: { admin_level: 6 },
      rings: [
        [
          [0, 0],
          [10, 0],
        ],
      ],
    },
    {
      properties: { admin_level: 2, maritime: 1 },
      rings: [
        [
          [0, 0],
          [4096, 4096],
        ],
      ],
    },
    {
      properties: { admin_level: 8 },
      rings: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    {
      properties: { admin_level: 2 },
      rings: [
        [
          [0, 0],
          [4096, 4096],
        ],
      ],
    },
  ];
  const projected = projectBoundaryPaths(features, window, 256);
  assert.deepEqual(
    projected.map((path) => path.style.adminLevel),
    [6, 2],
  );
  const ctx = fakeContext();
  drawBoundaryTile(ctx, features, window, 256);
  assert.deepEqual(ctx.ops[0], ['clearRect', 0, 0, 256, 256]);
  assert.equal(ctx.lineJoin, 'round');
  assert.equal(ctx.lineCap, 'butt');
  const strokes = ctx.ops.filter((op) => op[0] === 'stroke');
  assert.deepEqual(
    strokes.map((op) => [op[1], op[2], op[3]]),
    [
      [2.5, 'rgba(0,0,0,0.4)', []],
      [5, 'rgba(0,0,0,0.55)', []],
      [1.25, 'rgba(255,255,255,0.85)', [5, 4]],
      [3, '#ffffff', []],
    ],
  );
  const far = ctx.ops.filter(
    (op) => op[0] === 'lineTo' && op[1] === 256 && op[2] === 256,
  );
  assert.equal(far.length, 2);
  assert.deepEqual(ctx.ops.at(-1), ['setLineDash', []]);
});

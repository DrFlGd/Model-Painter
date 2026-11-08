import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold, toManifold } from '../src/core/solid.ts';
import { PaintModel, triangleDistance2, type LabelImage, type StampView } from '../src/core/paint-model.ts';
import { walkCode } from '../src/core/paint-tree.ts';
import type { IndexedMesh } from '../src/core/mesh.ts';

/** A flat 40 mm square in z = 0 made of two triangles, facing up. */
const square = (): IndexedMesh => ({
  positions: Float32Array.from([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]),
  triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
});

/** Area per colour of the paint, from its baked triangles. */
function areas(model: PaintModel): Map<number, number> {
  const b = model.baked(), P = b.mesh.positions, T = b.mesh.triangles;
  const out = new Map<number, number>();
  for (let i = 0; i < T.length / 3; i++) {
    const p = [0, 1, 2].map((k) => [P[T[i * 3 + k] * 3], P[T[i * 3 + k] * 3 + 1], P[T[i * 3 + k] * 3 + 2]]);
    const u = p[1].map((x, d) => x - p[0][d]), v = p[2].map((x, d) => x - p[0][d]);
    const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    out.set(b.faceMaterial[i], (out.get(b.faceMaterial[i]) ?? 0) + a);
  }
  return out;
}

/** Looking straight down at the square, 10 px per mm, the square's middle at pixel (200, 200); y down on screen. */
const topView = (model: PaintModel): StampView => ({
  project: (x, y) => [200 + x * 10, 200 - y * 10],
  visible: (f, x, y) => {
    // the face under a pixel of the square: the diagonal from (-20,-20) to (20,20) splits it
    const wx = (x - 200) / 10, wy = (200 - y) / 10;
    if (Math.abs(wx) > 20 || Math.abs(wy) > 20) return false;
    const g = wx >= wy ? 0 : 1;
    return g === f || model.touches(f, g);
  },
});

test('triangle distance', () => {
  const a = [0, 0, 0], b = [10, 0, 0], c = [0, 10, 0];
  assert.equal(triangleDistance2({ x: 2, y: 2, z: 3 }, a, b, c), 9);
  assert.equal(triangleDistance2({ x: -3, y: -4, z: 0 }, a, b, c), 25);
  assert.ok(Math.abs(triangleDistance2({ x: 10, y: 10, z: 0 }, a, b, c) - 50) < 1e-9);
});

test('the brush paints a disc inside two big triangles without changing the mesh', () => {
  const model = new PaintModel(square());
  const n = model.brush({ x: 3, y: -2, z: 0 }, 4, 2);
  assert.equal(n, 2, 'both triangles are touched (the disc crosses the diagonal)');
  assert.equal(model.mesh.triangles.length, 6, 'the mesh keeps its two triangles');
  assert.equal(model.codes.size, 2);
  const a = areas(model);
  const disc = Math.PI * 16;
  assert.ok(Math.abs((a.get(2) ?? 0) - disc) / disc < 0.05, `painted ${a.get(2)} mm², a disc is ${disc.toFixed(1)}`);
  assert.ok(Math.abs((a.get(2) ?? 0) + (a.get(0) ?? 0) - 1600) < 1e-3);
  // the areas from the codes agree with the baked triangles
  const fromCodes = model.colourAreas();
  assert.ok(Math.abs(fromCodes[2] - (a.get(2) ?? 0)) < 1e-3);
  // a bigger brush over everything makes the triangles whole again
  model.brush({ x: 0, y: 0, z: 0 }, 40, 2);
  assert.equal(model.codes.size, 0);
  assert.deepEqual([...model.faceMaterial], [2, 2]);
});

test('the brush can keep to the triangles facing the camera', () => {
  const model = new PaintModel(square());
  // looking down the −z axis sees the square's top (its normal is +z): painted
  assert.equal(model.brush({ x: 0, y: 0, z: 0 }, 100, 1, { facing: [0, 0, -1] }), 2);
  // looking up from below sees only its back: nothing
  assert.equal(model.brush({ x: 0, y: 0, z: 0 }, 100, 2, { facing: [0, 0, 1] }), 0);
});

test('undo brings back the paint before a stroke, and redo puts it back', () => {
  const model = new PaintModel(square());
  model.snapshot();
  model.brush({ x: 0, y: 0, z: 0 }, 5, 1);
  const before = areas(model).get(1)!;
  model.snapshot();
  model.brush({ x: 2, y: 0, z: 0 }, 5, 3);
  assert.ok(model.materialsUsed().has(3));
  assert.ok(model.undo());
  assert.ok(!model.materialsUsed().has(3));
  assert.ok(Math.abs(areas(model).get(1)! - before) < 1e-6);
  assert.ok(model.redo());
  assert.ok(model.materialsUsed().has(3));
  assert.ok(model.undo());
  assert.ok(model.undo());
  assert.equal(model.painted, false);
  assert.equal(model.undo(), false);
  // a change to everything undoes as one step too
  model.fillAll(4);
  assert.deepEqual([...model.faceMaterial], [4, 4]);
  assert.ok(model.undo());
  assert.deepEqual([...model.faceMaterial], [0, 0]);
});

test('a screen stamp paints sharp edges inside triangles, only where the part shows', () => {
  const model = new PaintModel(square());
  // a 100 × 60 px block (10 × 6 mm) of label 1 with a 20 px strip of label 2 inside
  const W = 400, H = 400, labels = new Int16Array(W * H).fill(-1);
  for (let y = 170; y < 230; y++) for (let x = 150; x < 250; x++) labels[y * W + x] = x >= 190 && x < 210 ? 2 : 1;
  const img: LabelImage = { labels, width: W, height: H };
  const changed = model.paintLabels(img, topView(model), [0, 1]);
  assert.equal(changed, 2);
  const a = areas(model);
  assert.ok(Math.abs((a.get(1) ?? 0) - 48) < 1.5, `label 1 covers ${a.get(1)} mm², expected 48`);
  assert.ok(Math.abs((a.get(2) ?? 0) - 12) < 1, `label 2 covers ${a.get(2)} mm², expected 12`);
  // nothing shows: nothing is painted
  const hidden = new PaintModel(square());
  const n = hidden.paintLabels(img, { project: topView(hidden).project, visible: () => false }, [0, 1]);
  assert.equal(n, 0);
  assert.equal(hidden.codes.size, 0);
});

test('the bucket fills across leaves up to another colour', () => {
  const model = new PaintModel(square());
  // a ring: paint a disc colour 1, then its middle back to 0, then bucket the middle colour 2
  model.brush({ x: 0, y: 0, z: 0 }, 8, 1);
  model.brush({ x: 0, y: 0, z: 0 }, 5, 0);
  // the very middle lies on the diagonal, in both triangles: weights of triangle 0's corners (-20,-20), (20,-20), (20,20)
  const changed = model.bucket(0, [0.5, 0, 0.5], 2, 180);
  assert.ok(changed >= 1);
  const a = areas(model);
  assert.ok(Math.abs((a.get(2) ?? 0) - Math.PI * 25) / (Math.PI * 25) < 0.06, `middle ${a.get(2)}`);
  assert.ok(Math.abs((a.get(1) ?? 0) - Math.PI * 39) / (Math.PI * 39) < 0.06, `ring ${a.get(1)}`);
  // the outside is untouched
  assert.ok((a.get(0) ?? 0) > 1600 - Math.PI * 64 - 10);
  // a fill outside the ring takes all of the outside, and only that
  model.bucket(0, [0.05, 0.9, 0.05], 3, 180);
  const b = areas(model);
  assert.ok(Math.abs((b.get(3) ?? 0) - (1600 - Math.PI * 64)) < 10, `outside ${b.get(3)}`);
  assert.ok(!b.has(0));
});

test('the bucket stops at creases', async () => {
  const { Manifold } = await manifold();
  const model = new PaintModel(fromManifold(Manifold.cube([10, 10, 10], true)));
  assert.equal(model.bucket(0, [1 / 3, 1 / 3, 1 / 3], 1, 40), 2, 'one side of the cube');
  assert.equal(model.bucket(0, [1 / 3, 1 / 3, 1 / 3], 2, 180), 2, 'a fill of colour 1 covers only what is colour 1');
  model.fillAll(0);
  assert.equal(model.bucket(0, [1 / 3, 1 / 3, 1 / 3], 1, 180), 12, 'without creases, all of it');
});

test('the colour at a point reads the leaf under it', () => {
  const model = new PaintModel(square());
  model.brush({ x: 10, y: -10, z: 0 }, 3, 5);
  // triangle 0 is (-20,-20), (20,-20), (20,20): the point (10,-10) is 0.25, 0.5, 0.25 of its corners
  assert.equal(model.colourAt(0, [0.25, 0.5, 0.25]), 5);
  assert.equal(model.colourAt(0, [0.9, 0.05, 0.05]), 0);
});

test('remap swaps colours everywhere and merges what became one', () => {
  const model = new PaintModel(square());
  model.brush({ x: 0, y: 0, z: 0 }, 5, 1);
  assert.equal(model.codes.size, 2);
  model.remap([2, 2]); // both colours become 2
  assert.equal(model.codes.size, 0);
  assert.deepEqual([...model.faceMaterial], [2, 2]);
  assert.ok(model.undo());
  assert.equal(model.codes.size, 2);
});

test('paint inside triangles bakes to a closed solid and writes slicer codes', async () => {
  const { Manifold } = await manifold();
  const mesh = fromManifold(Manifold.cube([20, 20, 20], true));
  const model = new PaintModel(mesh);
  model.brush({ x: 0, y: 0, z: 10 }, 4, 1);
  model.brush({ x: 10, y: 3, z: 3 }, 3, 2);
  assert.ok(model.codes.size >= 3);
  const solid = await toManifold(model.baked().mesh);
  assert.ok(Math.abs(solid.volume() - 8000) < 1e-2);
  const codes = model.paintCodes();
  assert.equal(codes.length, 12);
  for (const [f] of model.codes) assert.ok(codes[f].length > 1, `split face ${f} has a long code`);
  assert.ok(codes.some((c) => c === ''), 'unpainted faces have no code');
  // a code's leaves hold filament n for colour n − 1
  const states = new Set<number>();
  for (const c of codes) if (c) walkCode(c, (_w, s) => states.add(s));
  assert.deepEqual([...states].sort(), [1, 2, 3]);
  // restore puts the same paint back
  const again = new PaintModel(mesh);
  again.restore(model.faceMaterial, codes);
  assert.deepEqual(again.paintCodes(), codes);
  assert.equal(again.canUndo, false);
});

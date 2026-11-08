import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold, toManifold } from '../src/core/solid.ts';
import {
  CORNERS, areaShare, bakePaint, codeSplits, collapse, decodePaint, encodePaint, forEachLeaf, majority, splitNode,
  type PaintNode,
} from '../src/core/paint-tree.ts';
import type { IndexedMesh } from '../src/core/mesh.ts';

const leaf = (material = 0): PaintNode => ({ v: CORNERS, material });
const leaves = (n: PaintNode) => { const out: PaintNode[] = []; forEachLeaf(n, (l) => out.push(l)); return out; };
const shareSum = (n: PaintNode) => leaves(n).reduce((s, l) => s + areaShare(l), 0);

/** Every directed edge has exactly one partner running the other way: a closed, consistently wound surface. */
function closed(mesh: IndexedMesh): string | null {
  const T = mesh.triangles, edges = new Map<string, number>();
  for (let i = 0; i < T.length; i += 3) for (let k = 0; k < 3; k++) {
    const key = `${T[i + k]}>${T[i + (k + 1) % 3]}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split('>');
    if (count !== 1) return `edge ${key} used ${count} times`;
    if (edges.get(`${b}>${a}`) !== 1) return `edge ${key} has no partner`;
  }
  return null;
}

test('paint codes match the slicer encoding and round trip', () => {
  // whole-triangle codes: state 1 is "4", state 2 is "8", state 3 needs the long form "0C"
  assert.equal(encodePaint(leaf(1)), '4');
  assert.equal(encodePaint(leaf(2)), '8');
  assert.equal(encodePaint(leaf(3)), '0C');
  assert.equal(encodePaint(leaf(7)), '4C');
  for (const [code, state] of [['4', 1], ['8', 2], ['0C', 3], ['4C', 7]] as const) {
    const t = decodePaint(code)!;
    assert.equal(t.children, undefined, code);
    assert.equal(t.material, state, code);
    assert.equal(codeSplits(code), false, code);
  }
  // a split tree, with every kind of split and states needing both forms
  const t = leaf(0);
  splitNode(t, 3);
  t.children![0].material = 1;
  t.children![1].material = 4;
  splitNode(t.children![2], 1, 2);
  t.children![2].children![1].material = 2;
  splitNode(t.children![3], 2, 1);
  t.children![3].children![0].material = 3;
  const code = encodePaint(t);
  assert.ok(codeSplits(code), code);
  const back = decodePaint(code)!;
  assert.equal(encodePaint(back), code);
  assert.deepEqual(leaves(back).map((l) => [l.material, l.v]), leaves(t).map((l) => [l.material, l.v]));
  // states map through the palette both ways
  assert.equal(encodePaint(decodePaint(code, (s) => s * 2)!, (m) => m / 2), code);
});

test('splits cover the triangle and keep its winding', () => {
  const cross = (n: PaintNode) => {
    const [a, b, c] = n.v; // the signed area in the (w1, w2) plane, positive for the parent's own winding
    return (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  };
  for (const [sides, special] of [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0]]) {
    const t = leaf(0);
    splitNode(t, sides, special);
    assert.equal(t.children!.length, sides + 1);
    assert.ok(Math.abs(shareSum(t) - 1) < 1e-12, `${sides}/${special}`);
    for (const c of t.children!) assert.ok(cross(c) > 0, `${sides}/${special} child ${JSON.stringify(c.v)}`);
  }
});

test('collapse merges a uniform subtree; majority weighs by area', () => {
  const t = leaf(0);
  splitNode(t, 3);
  splitNode(t.children![3], 3);
  for (const c of t.children![3].children!) c.material = 2;
  assert.equal(collapse(t), false);
  assert.equal(t.children![3].children, undefined, 'the middle quarter is one leaf again');
  assert.equal(t.children![3].material, 2);
  assert.equal(majority(t), 0, 'three quarters are still unpainted');
  for (const c of t.children!) c.material = 2;
  assert.equal(collapse(t), true);
  assert.equal(t.material, 2);
  assert.equal(majority(t), 2);
});

test('baking trees of different depths on neighbouring triangles keeps the solid closed', async () => {
  const { Manifold } = await manifold();
  const sphere = Manifold.sphere(10, 24);
  const mesh = fromManifold(sphere);
  const n = mesh.triangles.length / 3;
  const faceMaterial = new Uint8Array(n);
  // neighbours of triangle 0, so the depths meet on shared edges
  const T = mesh.triangles;
  const near = [0];
  for (let f = 1; f < n && near.length < 6; f++) {
    let shared = 0;
    for (let k = 0; k < 3; k++) if ([T[0], T[1], T[2]].includes(T[f * 3 + k])) shared++;
    if (shared >= 1) near.push(f);
  }
  const trees = new Map<number, PaintNode>();
  near.forEach((f, i) => {
    const t = leaf(0);
    // depth i: keep splitting the first child three ways, painting the middle each time
    let node = t;
    for (let d = 0; d <= i; d++) {
      splitNode(node, 3);
      node.children![3].material = 1 + (d % 2);
      node = node.children![d % 3];
    }
    if (i === 2) splitNode(t.children![1], 1, 1);
    if (i === 3) splitNode(t.children![2], 2, 2);
    trees.set(f, t);
  });
  const baked = bakePaint(mesh, faceMaterial, trees);
  assert.equal(closed(baked.mesh), null);
  assert.equal(baked.faceMaterial.length, baked.mesh.triangles.length / 3);
  assert.equal(baked.source.length, baked.faceMaterial.length);
  const solid = await toManifold(baked.mesh);
  assert.ok(Math.abs(solid.volume() - sphere.volume()) < 1e-3, `volume ${solid.volume()} vs ${sphere.volume()}`);
  assert.equal(solid.genus(), 0);
  // the painted area per colour matches the trees' leaves
  const area = (tri: number) => {
    const P = baked.mesh.positions, t = baked.mesh.triangles;
    const p = [0, 1, 2].map((k) => [P[t[tri * 3 + k] * 3], P[t[tri * 3 + k] * 3 + 1], P[t[tri * 3 + k] * 3 + 2]]);
    const u = p[1].map((x, d) => x - p[0][d]), v = p[2].map((x, d) => x - p[0][d]);
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  };
  const meshArea = (f: number) => {
    const P = mesh.positions;
    const p = [0, 1, 2].map((k) => [P[T[f * 3 + k] * 3], P[T[f * 3 + k] * 3 + 1], P[T[f * 3 + k] * 3 + 2]]);
    const u = p[1].map((x, d) => x - p[0][d]), v = p[2].map((x, d) => x - p[0][d]);
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  };
  let bakedPainted = 0, treePainted = 0;
  for (let i = 0; i < baked.faceMaterial.length; i++) if (baked.faceMaterial[i]) bakedPainted += area(i);
  for (const [f, t] of trees) for (const l of leaves(t)) if (l.material) treePainted += areaShare(l) * meshArea(f);
  assert.ok(treePainted > 0);
  assert.ok(Math.abs(bakedPainted - treePainted) < 1e-6, `${bakedPainted} vs ${treePainted}`);
  // the untouched triangles far away are copied as they are
  assert.ok(baked.leafIndex.some((l) => l === -1));
});

test('walking a code gives the same leaves as decoding it, without a tree', async () => {
  const { walkCode, cornersShare, codeMajority, CodeWriter, leafCode } = await import('../src/core/paint-tree.ts');
  const t = leaf(0);
  splitNode(t, 3);
  t.children![0].material = 1;
  t.children![1].material = 4;
  splitNode(t.children![2], 1, 2);
  t.children![2].children![1].material = 2;
  splitNode(t.children![3], 2, 1);
  t.children![3].children![0].material = 3;
  t.children![3].children![2].material = 20; // needs the long escape
  const code = encodePaint(t);
  const walked: [number, number[]][] = [];
  walkCode(code, (c, s) => walked.push([s, Array.from(c)]));
  const decoded = leaves(t).map((l) => [l.material, [...l.v[0], ...l.v[1], ...l.v[2]]] as [number, number[]]);
  assert.deepEqual(walked.reverse(), decoded);
  let total = 0;
  walkCode(code, (c) => { total += cornersShare(c); });
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.equal(codeMajority(code), 1); // states 1 and 4 hold a quarter each, the first wins
  // the writer makes the same codes as encodePaint
  const w = new CodeWriter();
  const write = (n: PaintNode) => {
    if (!n.children) { w.leaf(n.material); return; }
    w.split(n.sides!, n.special!);
    for (let i = n.children.length - 1; i >= 0; i--) write(n.children[i]);
  };
  write(t);
  assert.equal(w.toString(), code);
  assert.equal(leafCode(1), '4');
  assert.equal(leafCode(3), '0C');
  assert.equal(leafCode(16), 'DC');
});

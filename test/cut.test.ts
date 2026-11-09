import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Manifold } from 'manifold-3d';
import { cutModel, onBed, printPose, type CutPlane, type Joint, type Piece } from '../src/core/cut.ts';
import { BASE } from '../src/core/finish.ts';
import { mapFinished } from '../src/core/finish-map.ts';
import { PaintModel } from '../src/core/paint-model.ts';
import { manifold, toManifold, fromManifold } from '../src/core/solid.ts';
import type { IndexedMesh } from '../src/core/mesh.ts';

const close = (a: number, b: number, rel: number, what = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${what} ${a} is not ${b} within ${rel * 100}%`);

async function solidMesh(make: (m: Awaited<ReturnType<typeof manifold>>) => Manifold): Promise<IndexedMesh> {
  const m = await manifold();
  const s = make(m);
  const mesh = fromManifold(s);
  s.delete();
  return mesh;
}
const cylinder = (h = 40, r = 10) => solidMesh((m) => m.Manifold.cylinder(h, r, r, 96));
/** the area of the 96-sided circle the test cylinders have */
const DISC = 0.5 * 96 * 100 * Math.sin((2 * Math.PI) / 96);
const acrossZ = (at: number, joint: Partial<Joint> = {}): CutPlane => ({ normal: [0, 0, 1], point: [0, 0, at], joint });

/** The piece as a solid: an error when it isn't watertight. */
async function watertight(p: Piece): Promise<Manifold> {
  try { return await toManifold(p.mesh); } catch (e) { throw new Error(`${p.name} isn't watertight: ${(e as Error).message}`); }
}

test('a flat cut splits a solid into two watertight halves, the top first', async () => {
  const r = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'flat' })], wall: 1.6 }, { solid: true });
  assert.deepEqual(r.pieces.map((p) => p.name), ['Piece 1', 'Piece 2']);
  const whole = DISC * 40;
  const vols = await Promise.all(r.pieces.map(async (p) => (await watertight(p)).volume()));
  close(vols[0] + vols[1], whole, 0.001, 'both');
  close(vols[0], vols[1], 1e-3, 'halves');
  close(r.pieces[0].volume, vols[0], 1e-6, 'its volume');
  const zOf = (p: Piece) => { let s = 0; for (let i = 2; i < p.mesh.positions.length; i += 3) s += p.mesh.positions[i]; return s; };
  assert.ok(zOf(r.pieces[0]) / r.pieces[0].mesh.positions.length > zOf(r.pieces[1]) / r.pieces[1].mesh.positions.length);
  assert.deepEqual(r.joints, [{ cut: 0, crossed: 1, placed: 0, skipped: 0, kind: 'flat' }]);
});

test('pegs stand on one side and fit holes wider by the clearance', async () => {
  const clr = 0.25, d = 4, depth = 5;
  const r = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'pegs', diameter: d, depth, clearance: clr, count: 2 })], wall: 1.6 }, { solid: true });
  const [top, bottom] = await Promise.all(r.pieces.map(watertight));
  assert.equal(r.joints[0].placed, 2);
  const half = DISC * 20;
  const peg = Math.PI * (d / 2) ** 2 * depth, hole = Math.PI * (d / 2 + clr) ** 2 * (depth + clr);
  // the top piece points the way the cut's normal does, so the pegs stand on it, into the bottom piece
  close(top.volume(), half + 2 * peg, 0.01, 'top');
  close(bottom.volume(), half - 2 * hole, 0.01, 'bottom');
  // through the holes, 1 mm below the cut: two circles of the peg's radius plus the clearance
  const ring = bottom.slice(19), pegs = top.slice(19);
  close(ring.area(), DISC - 2 * Math.PI * (d / 2 + clr) ** 2, 0.01, 'ring');
  close(pegs.area(), 2 * Math.PI * (d / 2) ** 2, 0.02, 'pegs');
  assert.ok(r.pieces[0].faces[0].raised && !r.pieces[1].faces[0].raised);
});

test('flipped pegs stand on the other side', async () => {
  const r = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'pegs', flip: true, count: 1 })], wall: 1.6 }, { solid: true });
  const [top, bottom] = await Promise.all(r.pieces.map(watertight));
  assert.ok(bottom.volume() > top.volume());
  assert.ok(r.pieces[1].faces[0].raised && !r.pieces[0].faces[0].raised);
});

test('dowels make holes on both sides and dowel pieces', async () => {
  const r = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'dowels', diameter: 3, depth: 6, clearance: 0.2 })], wall: 1.6 }, { solid: true });
  assert.deepEqual(r.pieces.map((p) => p.kind), ['piece', 'piece', 'dowel', 'dowel']);
  close((await watertight(r.pieces[2])).volume(), Math.PI * 1.5 ** 2 * 12, 0.02, 'dowel'); // 6 mm into each side
  assert.deepEqual(r.pieces[2].axis, [0, 0, 1]);
  const off = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'dowels', printDowels: false })], wall: 1.6 }, { solid: true });
  assert.deepEqual(off.pieces.map((p) => p.kind), ['piece', 'piece']);
});

test('magnet pockets on both sides', async () => {
  const r = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'magnets', magnetDiameter: 6, magnetHeight: 2, clearance: 0.1, count: 1 })], wall: 1.6 }, { solid: true });
  const [top, bottom] = await Promise.all(r.pieces.map(watertight));
  const pocket = Math.PI * 3.1 ** 2 * 2.1;
  close(top.volume(), DISC * 20 - pocket, 0.01, 'top');
  close(bottom.volume(), top.volume(), 1e-3, 'bottom');
});

test('a key follows the shape of the cut face', async () => {
  const box = await solidMesh((m) => m.Manifold.cube([30, 12, 40]));
  const r = await cutModel(box, { cuts: [acrossZ(20, { kind: 'key', depth: 4, clearance: 0.2 })], wall: 2 }, { solid: true });
  const [top, bottom] = await Promise.all(r.pieces.map(watertight));
  // 2 mm below the cut: the tongue, inset 2 mm from the box's sides
  const b = top.slice(18).bounds();
  assert.ok(Math.abs(b.max[0] - b.min[0] - 26) < 0.05 && Math.abs(b.max[1] - b.min[1] - 8) < 0.05, JSON.stringify(b));
  // the groove is wider by the clearance (inset corners stay sharp)
  close(bottom.slice(18).area(), 30 * 12 - 26.4 * 8.4, 0.01, 'groove');
});

test('a feature with no room leaves the cut flat and says so', async () => {
  const plate = await solidMesh((m) => m.Manifold.cube([40, 2, 40])); // 2 mm thick: no room for a 5 mm peg
  const r = await cutModel(plate, { cuts: [acrossZ(20, { kind: 'pegs' })], wall: 1.6 }, { solid: true });
  assert.equal(r.pieces.length, 2);
  assert.equal(r.joints[0].placed, 0);
  assert.ok(r.notes.some((n) => n === 'Cut 1: 1 place had no room for a peg and was left flat.'), r.notes.join(' / '));
});

test('a peg is made shorter where the far piece is thin', async () => {
  let r = await cutModel(await cylinder(), { cuts: [acrossZ(36, { kind: 'pegs', depth: 8, count: 1 })], wall: 1.6 }, { solid: true });
  assert.equal(r.joints[0].placed, 1);
  assert.ok((await watertight(r.pieces[1])).volume() < DISC * 36 - 10); // the hole went into the long part
  r = await cutModel(await cylinder(), { cuts: [acrossZ(4, { kind: 'pegs', depth: 8, count: 1 })], wall: 1.6 }, { solid: true });
  assert.equal(r.joints[0].placed, 1); // 4 mm left below the cut: the peg is cut down to fit
  for (const p of r.pieces) await watertight(p);
});

test('cuts in any direction, and several of them', async () => {
  const sphere = await solidMesh((m) => m.Manifold.sphere(20, 96));
  const r = await cutModel(sphere, { cuts: [{ normal: [1, 0.3, 0.2], point: [0, 0, 0], joint: { kind: 'pegs' } }, { normal: [0, 0, 1], point: [0, 0, 5], joint: { kind: 'magnets' } }], wall: 1.6 }, { solid: true });
  assert.equal(r.pieces.filter((p) => p.kind === 'piece').length, 4);
  assert.deepEqual(r.joints.map((j) => j.crossed), [1, 2]);
  for (const p of r.pieces) await watertight(p);
  await assert.rejects(cutModel(sphere, { cuts: [{ normal: [0, 0, 0], point: [0, 0, 0] }], wall: 1.6 }, { solid: true }), /needs a direction/);
});

test('a cut that misses the model says so', async () => {
  const r = await cutModel(await cylinder(), { cuts: [acrossZ(100, { kind: 'flat' })], wall: 1.6 }, { solid: true });
  assert.equal(r.pieces.length, 1);
  assert.ok(r.notes.includes("Cut 1 doesn't go through the model."));
});

test('a cut on a face of the model leaves no sheet behind', async () => {
  const mesh = await solidMesh((m) => {
    const base = m.Manifold.cube([50, 50, 12], true).translate([0, 0, 6]);
    const torso = m.Manifold.cylinder(40, 16, 12, 96).translate([0, 0, 12]);
    const both = base.add(torso);
    base.delete(); torso.delete();
    return both;
  });
  const r = await cutModel(mesh, { cuts: [acrossZ(12, { kind: 'key' })], wall: 1.6 }, { solid: true }); // exactly on the base's top
  const P = r.pieces[0].mesh.positions;
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 2; d++) { lo[d] = Math.min(lo[d], P[i + d]); hi[d] = Math.max(hi[d], P[i + d]); }
  // the torso alone, not the base's top face with it
  assert.ok(Math.abs(hi[0] - lo[0] - 32) < 0.05 && Math.abs(hi[1] - lo[1] - 32) < 0.05, `${hi[0] - lo[0]} × ${hi[1] - lo[1]}`);
  for (const p of r.pieces) await watertight(p);
});

test('open parts are closed or thickened and joined into one solid before cutting', async () => {
  const m = await manifold();
  // a box without its lid (closed flat), a flat cape (thickened) and a ball half in the box (joined)
  const box = fromManifold(m.Manifold.cube([30, 30, 30]));
  const keep: number[] = [];
  for (let t = 0; t < box.triangles.length / 3; t++) if (![0, 1, 2].every((k) => box.positions[box.triangles[t * 3 + k] * 3 + 2] === 30)) keep.push(box.triangles[t * 3], box.triangles[t * 3 + 1], box.triangles[t * 3 + 2]);
  const P: number[] = Array.from(box.positions), T: number[] = keep;
  const n = 12, start = P.length / 3;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P.push(60 + (40 * j) / (n - 1), (40 * i) / (n - 1), 10);
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const a = start + i * n + j;
    T.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
  }
  const ball = fromManifold(m.Manifold.sphere(10, 48).translate([15, 15, 30]));
  const s = P.length / 3;
  P.push(...ball.positions);
  T.push(...Array.from(ball.triangles, (v) => v + s));
  const mesh = { positions: Float32Array.from(P), triangles: Uint32Array.from(T) };
  const r = await cutModel(mesh, { cuts: [acrossZ(15, { kind: 'flat' })], wall: 1.6 }, { sheet: 1.5 });
  for (const note of ['1 part had openings, closed flat.', '1 open surface thickened to 1.5 mm.']) assert.ok(r.notes.includes(note), r.notes.join(' / '));
  // the cup is cut in two: the ball comes with its top, the cape (apart, below the cut) with its bottom, as Dark STL keeps them
  assert.equal(r.pieces.length, 2, r.pieces.map((p) => p.name).join(', '));
  const total = r.pieces.reduce((a, p) => a + p.volume, 0);
  close(total, 30 ** 3 + 40 * 40 * 1.5 + (4 / 3) * Math.PI * 1000 / 2, 0.02, 'volume');
  // the lid closing the cup is new: it takes its colour from the nearest of the model, so it isn't marked a cut face
  assert.ok(r.pieces.some((p) => p.source.some((x) => x === -1)));
});

test("every piece's triangle is a piece of the model's, or a face the cut made, and the paint stays where it was", async () => {
  const m = await manifold();
  const box = fromManifold(m.Manifold.cube([20, 20, 20]).refine(4));
  const nt = box.triangles.length / 3;
  // the model painted: x < 10 colour 2, the rest colour 3, and a brush dab across where the cut goes
  const paint = new PaintModel(box);
  const left: number[] = [], right: number[] = [];
  for (let t = 0; t < nt; t++) (box.positions[box.triangles[t * 3] * 3] + box.positions[box.triangles[t * 3 + 1] * 3] + box.positions[box.triangles[t * 3 + 2] * 3] < 30 ? left : right).push(t);
  paint.paintFaces(left, 1);
  paint.paintFaces(right, 2);
  paint.brush({ x: 20, y: 10, z: 10 }, 3, 3);
  const r = await cutModel(box, { cuts: [{ normal: [0, 0, 1], point: [0, 0, 10], joint: { kind: 'pegs', count: 1 } }], wall: 1.6 }, { solid: true });
  let made = 0;
  for (const piece of r.pieces) {
    const P = piece.mesh.positions, T = piece.mesh.triangles;
    for (let t = 0; t < T.length / 3; t++) {
      const s = piece.source[t];
      if (s === BASE) { made++; continue; }
      assert.ok(s >= 0 && s < nt);
      // in the plane of the model's triangle
      const a = box.triangles[s * 3] * 3, b = box.triangles[s * 3 + 1] * 3, c = box.triangles[s * 3 + 2] * 3, Q = box.positions;
      const u = [Q[b] - Q[a], Q[b + 1] - Q[a + 1], Q[b + 2] - Q[a + 2]], v = [Q[c] - Q[a], Q[c + 1] - Q[a + 1], Q[c + 2] - Q[a + 2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(nrm[0], nrm[1], nrm[2]);
      for (let k = 0; k < 3; k++) {
        const q = T[t * 3 + k] * 3;
        assert.ok(Math.abs(((P[q] - Q[a]) * nrm[0] + (P[q + 1] - Q[a + 1]) * nrm[1] + (P[q + 2] - Q[a + 2]) * nrm[2]) / l) < 1e-3);
      }
    }
    // mapped: what is still the model's surface keeps its paint; cut faces, the peg and its hole are colour 1
    const mapped = mapFinished({ mesh: box, uvs: null, vertexColours: null, faceMaterial: new Uint16Array(nt), faceGroup: new Uint32Array(nt), paint: { colour: paint.faceMaterial, codes: paint.codes }, baseMaterial: 1 }, piece);
    assert.equal(mapped.nearest, 0);
    const painted = new PaintModel(mapped.mesh);
    painted.restore(mapped.paint!.colour, mapped.paint!.codes);
    for (let t = 0; t < T.length / 3; t++) {
      const s = piece.source[t];
      if (s === BASE) { assert.equal(mapped.paint!.colour[t], 0); assert.equal(mapped.faceMaterial[t], 1); continue; }
      const p = painted.point(t, [1 / 3, 1 / 3, 1 / 3]);
      // away from the dab, the side's colour
      if (Math.hypot(p[0] - 20, p[1] - 10, p[2] - 10) > 3.5) assert.equal(painted.colourAt(t, [1 / 3, 1 / 3, 1 / 3]), p[0] < 10 ? 1 : 2);
    }
    assert.ok(mapped.paint!.codes.size > 0, 'the dab is split paint on both pieces');
  }
  assert.ok(made > 0);
});

test('pieces are laid on a cut face without pegs on it; dowels stand on end', async () => {
  const quarters = await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'pegs' }), { normal: [1, 0, 0], point: [0, 0, 0], joint: { kind: 'flat' } }], wall: 1.6 }, { solid: true });
  for (const p of quarters.pieces) {
    const P = printPose(p);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], P[i + d]); hi[d] = Math.max(hi[d], P[i + d]); }
    assert.ok(Math.abs(lo[2]) < 1e-4 && Math.abs(lo[0] + hi[0]) < 1e-4 && Math.abs(lo[1] + hi[1]) < 1e-4);
    // a quarter of a cylinder lies on the flat face of the upright cut, its biggest (20 × 20 mm)
    let down = 0;
    const T = p.mesh.triangles;
    for (let t = 0; t < T.length / 3; t++) {
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const nz = u[0] * v[1] - u[1] * v[0], l = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], nz);
      if (nz / l < -0.999) down += l / 2;
    }
    assert.ok(down > 400 * 0.9 && down < 400 * 1.1, `${p.name} lies on ${down} mm²`); // less the holes, or more by the pegs, cut by it
  }
  // with only the pegged face to lie on, a piece stays upright
  const top = (await cutModel(await cylinder(), { cuts: [acrossZ(20, { kind: 'pegs' })], wall: 1.6 }, { solid: true })).pieces[0];
  assert.deepEqual(printPose(top), onBed(top.mesh.positions));
  // the holed face is the bottom piece's: turned over, it lies on it, 30 mm tall
  const bottom = (await cutModel(await cylinder(), { cuts: [acrossZ(30, { kind: 'pegs' })], wall: 1.6 }, { solid: true })).pieces[1];
  const turned = printPose(bottom);
  let z1 = -Infinity;
  for (let i = 2; i < turned.length; i += 3) z1 = Math.max(z1, turned[i]);
  assert.ok(Math.abs(z1 - 30) < 0.01, `${z1}`);
  // a dowel across X stands on end
  const lying = await cutModel(await solidMesh((m) => m.Manifold.cube([40, 20, 20], true)), { cuts: [{ normal: [1, 0, 0], point: [0, 0, 0], joint: { kind: 'dowels', diameter: 3, depth: 6, count: 1 } }], wall: 1.6 }, { solid: true });
  const dowel = lying.pieces.find((p) => p.kind === 'dowel')!;
  const D = printPose(dowel);
  let top2 = -Infinity;
  for (let i = 2; i < D.length; i += 3) top2 = Math.max(top2, D[i]);
  assert.ok(Math.abs(top2 - 12) < 0.01, `the dowel stands ${top2} mm tall`);
});

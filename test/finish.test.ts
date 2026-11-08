import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatertight, gapCell, narrowestGap, BASE } from '../src/core/finish.ts';
import { openEdges, type IndexedMesh } from '../src/core/mesh.ts';

type Box = [number, number, number, number, number, number];

/** Boxes (x0 y0 z0 x1 y1 z1) as one mesh, faces outwards, each box its own vertices. */
function boxes(...list: Box[]): IndexedMesh {
  const P: number[] = [], T: number[] = [];
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const b = P.length / 3;
    for (let i = 0; i < 8; i++) P.push(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0);
    // two triangles per side, wound outwards
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (const [a, c, d, e] of quads) T.push(b + a, b + c, b + d, b + a, b + d, b + e);
  }
  return { positions: Float32Array.from(P), triangles: Uint32Array.from(T) };
}

/** The mesh without some of its triangles. */
function without(mesh: IndexedMesh, drop: number[]): IndexedMesh {
  const T: number[] = [];
  for (let f = 0; f < mesh.triangles.length / 3; f++) if (!drop.includes(f)) T.push(mesh.triangles[f * 3], mesh.triangles[f * 3 + 1], mesh.triangles[f * 3 + 2]);
  return { positions: mesh.positions, triangles: Uint32Array.from(T) };
}

function closed(mesh: IndexedMesh) {
  const { open, overused } = openEdges(mesh);
  assert.equal(open, 0, 'no open edges');
  assert.equal(overused, 0, 'no edge shared by more than two triangles');
}

/** Every triangle that says it came from one of the model's lies in that triangle's plane, within `tol`. */
function inPlane(model: IndexedMesh, out: IndexedMesh, source: Int32Array, tol = 1e-3) {
  const P = model.positions, T = model.triangles, Q = out.positions, U = out.triangles;
  let checked = 0;
  for (let t = 0; t < source.length; t++) {
    const s = source[t];
    if (s < 0) continue;
    const a = T[s * 3] * 3, b = T[s * 3 + 1] * 3, c = T[s * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    for (let k = 0; k < 3; k++) {
      const q = U[t * 3 + k] * 3;
      const d = ((Q[q] - P[a]) * n[0] + (Q[q + 1] - P[a + 1]) * n[1] + (Q[q + 2] - P[a + 2]) * n[2]) / l;
      assert.ok(Math.abs(d) < tol, `triangle ${t} lies ${d} off the plane of the model's triangle ${s}`);
    }
    checked++;
  }
  return checked;
}

test('overlapping parts become one solid: only the outside stays, every piece of it from the model', async () => {
  const model = boxes([0, 0, 0, 20, 20, 20], [10, 10, 10, 30, 30, 30]);
  const r = await makeWatertight(model, null);
  closed(r.mesh);
  assert.equal(r.shells, 1);
  assert.ok(Math.abs(r.volume - (2 * 8000 - 1000)) < 1e-3, `volume ${r.volume}`);
  assert.ok(r.notes.some((n) => n.includes('2 parts joined')), r.notes.join(' / '));
  // nothing finishing made: every triangle is a piece of one of the model's, in its plane
  assert.ok([...r.source].every((s) => s >= 0));
  assert.equal(inPlane(model, r.mesh, r.source), r.source.length);
});

test('a part with a small opening is closed flat; an open sheet is thickened', async () => {
  // a box without its top: the opening is a sixth of it, closed with a fan
  const open = without(boxes([0, 0, 0, 20, 20, 20]), [2, 3]);
  const a = await makeWatertight(open, null);
  closed(a.mesh);
  assert.ok(Math.abs(a.volume - 8000) < 1e-3, `volume ${a.volume}`);
  assert.ok(a.notes.some((n) => n.includes('openings, closed flat')), a.notes.join(' / '));
  assert.ok(a.source.some((s) => s < 0), 'the lid is new');
  inPlane(open, a.mesh, a.source);
  // one side of a box alone: a sheet, made 1.5 mm thick
  const sheet = without(boxes([0, 0, 0, 20, 20, 20]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const b = await makeWatertight(sheet, null, { sheet: 1.5 });
  closed(b.mesh);
  assert.ok(Math.abs(b.volume - 400 * 1.5) < 1, `volume ${b.volume}`);
  assert.ok(b.notes.some((n) => n.includes('thickened to 1.5 mm')), b.notes.join(' / '));
  // the front and back are the model's triangles, the strip round the edge new
  assert.ok(b.source.some((s) => s >= 0) && b.source.some((s) => s < 0));
});

test('solids that touch along an edge are taken apart there, not rebuilt from voxels', async () => {
  const r = await makeWatertight(boxes([0, 0, 0, 10, 10, 10], [10, 10, 0, 20, 20, 10]), null);
  assert.ok(!r.notes.some((n) => n.includes('voxels')), r.notes.join(' / '));
  assert.ok(Math.abs(r.volume - 2000) < 1e-3, `volume ${r.volume}`);
  assert.ok([...r.source].every((s) => s >= 0));
});

test('a hollow sealed inside the model is filled', async () => {
  // six walls 2 mm thick, overlapping at the edges: a closed box with air inside
  const walls: Box[] = [
    [0, 0, 0, 20, 20, 2], [0, 0, 18, 20, 20, 20],
    [0, 0, 0, 2, 20, 20], [18, 0, 0, 20, 20, 20],
    [0, 0, 0, 20, 2, 20], [0, 18, 0, 20, 20, 20],
  ];
  // each wall its own sub-mesh, as a game model's parts are: they overlap where they meet, sharing edges
  const groups = Uint16Array.from({ length: 72 }, (_, t) => Math.floor(t / 12));
  const kept = await makeWatertight(boxes(...walls), groups, { fillHollows: false });
  assert.ok(Math.abs(kept.volume - (8000 - 16 * 16 * 16)) < 1e-2, `walls ${kept.volume}`);
  assert.equal(kept.hollows, 0);
  const r = await makeWatertight(boxes(...walls), groups);
  closed(r.mesh);
  assert.equal(r.hollows, 1);
  assert.ok(Math.abs(r.volume - 8000) < 1e-2, `filled ${r.volume}`);
  assert.ok(r.notes.some((n) => n.includes('1 hollow sealed inside the model filled (4.1 cm³)')), r.notes.join(' / '));
});

test('a narrow gap is bridged, and the bridge stays inside the gap', async () => {
  const model = boxes([0, 0, 0, 20, 20, 20], [20.6, 0, 0, 40.6, 20, 20]);
  const apart = await makeWatertight(model, null);
  assert.equal(apart.shells, 2);
  assert.ok(apart.notes.some((n) => n.includes("2 separate pieces")));
  const r = await makeWatertight(model, null, { closeGaps: 1 });
  closed(r.mesh);
  assert.equal(r.shells, 1, r.notes.join(' / '));
  assert.ok(r.gapVolume > 20 * 20 * 0.6 * 0.5, `bridge ${r.gapVolume}`);
  // nothing outside the boxes' outline (bar the bridge's rounding)
  const P = r.mesh.positions;
  for (let i = 0; i < P.length; i += 3) {
    assert.ok(P[i] > -0.2 && P[i] < 40.8 && P[i + 1] > -0.2 && P[i + 1] < 20.2 && P[i + 2] > -0.2 && P[i + 2] < 20.2, `vertex at ${P[i]}, ${P[i + 1]}, ${P[i + 2]}`);
  }
  assert.ok(r.notes.some((n) => n.startsWith('Gaps up to 1 mm wide closed')), r.notes.join(' / '));
  // too narrow a gap for the model's size is refused with what can be done
  assert.equal(gapCell([2000, 2000, 2000], 0.1), null);
  assert.ok(narrowestGap([2000, 2000, 2000]) > 0.1);
});

test('loose bits smaller than a share of the model are removed', async () => {
  const model = boxes([0, 0, 0, 20, 20, 20], [40, 0, 0, 41, 1, 1], [40, 10, 0, 50, 20, 10]);
  const r = await makeWatertight(model, null, { loose: 1 });
  closed(r.mesh);
  assert.equal(r.looseRemoved, 1);
  assert.equal(r.shells, 2);
  assert.ok(Math.abs(r.volume - 9000) < 1e-3, `volume ${r.volume}`);
});

test('a broken part is rebuilt from voxels', async () => {
  // a box with one side twice over and an extra triangle hanging off an edge: no clean surface
  const base = boxes([0, 0, 0, 20, 20, 20]);
  const T = Array.from(base.triangles);
  const P = Array.from(base.positions);
  T.push(T[0], T[1], T[2]);
  P.push(10, -10, 0);
  T.push(T[3], T[4], P.length / 3 - 1);
  const r = await makeWatertight({ positions: Float32Array.from(P), triangles: Uint32Array.from(T) }, null);
  closed(r.mesh);
  assert.ok(r.notes.some((n) => n.includes('rebuilt from voxels')), r.notes.join(' / '));
  assert.ok(r.volume > 6000 && r.volume < 11000, `volume ${r.volume}`);
});

test('the bottom is cut flat, and a base added under the foot', async () => {
  const box = boxes([0, 0, 0, 10, 10, 10]);
  const cut = await makeWatertight(box, null, { flatten: 2 });
  closed(cut.mesh);
  assert.ok(Math.abs(cut.volume - 800) < 1e-3, `cut ${cut.volume}`);
  assert.ok(cut.notes.some((n) => n.startsWith('The bottom 2 mm cut off')));
  await assert.rejects(makeWatertight(box, null, { flatten: 12 }), /would leave nothing/);
  // a round base round the foot (a 10 mm square: 14.1 mm across) with 3 mm to spare, 3 mm thick, the box sunk 0.5 mm into it
  const round = await makeWatertight(box, null, { base: 'round', baseHeight: 3, baseMargin: 3 });
  closed(round.mesh);
  assert.equal(round.shells, 1);
  const r = Math.hypot(5, 5) + 3;
  const segments = Math.max(48, Math.min(256, Math.round((2 * Math.PI * r) / 0.6)));
  const disc = 0.5 * segments * r * r * Math.sin((2 * Math.PI) / segments);
  assert.ok(Math.abs(round.volume - (disc * 3.5 + 1000 - 50)) < 0.1, `round ${round.volume}`);
  assert.ok(round.source.some((s) => s === BASE) && round.source.some((s) => s >= 0));
  let low = Infinity;
  for (let i = 2; i < round.mesh.positions.length; i += 3) low = Math.min(low, round.mesh.positions[i]);
  assert.ok(Math.abs(low + 3) < 1e-4, `the base's bottom at ${low}`);
  assert.ok(round.notes.some((n) => n.startsWith('A round base 20.1 mm across and 3 mm thick')), round.notes.join(' / '));
  const square = await makeWatertight(box, null, { base: 'square', baseHeight: 2, baseMargin: 1 });
  closed(square.mesh);
  assert.ok(Math.abs(square.volume - (12 * 12 * 2.5 + 1000 - 50)) < 1e-3, `square ${square.volume}`);
});

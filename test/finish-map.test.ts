import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatertight, BASE } from '../src/core/finish.ts';
import { mapFinished } from '../src/core/finish-map.ts';
import { PaintModel } from '../src/core/paint-model.ts';
import type { IndexedMesh } from '../src/core/mesh.ts';

type Box = [number, number, number, number, number, number];

/** Boxes (x0 y0 z0 x1 y1 z1) as one welded mesh, faces outwards, cut into a grid of `n` × `n` squares a side. */
function boxes(n: number, ...list: Box[]): IndexedMesh {
  const P: number[] = [], T: number[] = [];
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const lo = [x0, y0, z0], hi = [x1, y1, z1];
    for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const b = P.length / 3;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const p = [0, 0, 0];
        p[axis] = side ? hi[axis] : lo[axis];
        p[u] = lo[u] + ((hi[u] - lo[u]) * i) / n;
        p[v] = lo[v] + ((hi[v] - lo[v]) * j) / n;
        P.push(p[0], p[1], p[2]);
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const a = b + i * (n + 1) + j, c = a + n + 1;
        // (u, v, axis) is right-handed: u × v points along +axis
        if (side) T.push(a, c, c + 1, a, c + 1, a + 1); else T.push(a, c + 1, c, a, a + 1, c + 1);
      }
    }
  }
  return { positions: Float32Array.from(P), triangles: Uint32Array.from(T) };
}

/** A UV and colour everywhere that change evenly through space, so a piece's are known from where it is. */
const uvAt = (x: number, y: number, z: number) => [x * 0.01 + z * 0.003, y * 0.01 - z * 0.005];

function modelOf(mesh: IndexedMesh) {
  const n = mesh.triangles.length / 3;
  const uvs = new Float32Array(n * 6);
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const v = mesh.triangles[t * 3 + k] * 3;
    const [u, w] = uvAt(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]);
    uvs[t * 6 + k * 2] = u; uvs[t * 6 + k * 2 + 1] = w;
  }
  const faceMaterial = Uint16Array.from({ length: n }, (_, t) => (mesh.positions[mesh.triangles[t * 3] * 3] < 15 ? 0 : 1));
  return { mesh, uvs, vertexColours: null, faceMaterial, faceGroup: new Uint32Array(n) };
}

/** Random points on a triangle, as corner weights. */
function* samples(count: number, seed = 1): Generator<[number, number, number]> {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < count; i++) {
    let a = rnd(), b = rnd();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    yield [1 - a - b, a, b];
  }
}

test('the finished model keeps the UVs, materials and paint where they were', async () => {
  const mesh = boxes(3, [0, 0, 0, 20, 20, 20], [10, 10, 10, 30, 30, 30]);
  const model = modelOf(mesh);
  // paint: dabs where the boxes cross (on triangles the boolean cuts), one elsewhere, and one triangle all red
  const paint = new PaintModel(mesh);
  paint.brush({ x: 13, y: 10, z: 20 }, 3, 1);
  paint.brush({ x: 20, y: 4, z: 14 }, 2.5, 2);
  paint.brush({ x: 12, y: 30, z: 20 }, 3, 2);
  paint.paintFaces([5], 2);
  assert.ok(paint.codes.size > 5);
  const fin = await makeWatertight(mesh, null);
  const out = mapFinished({ ...model, paint: { colour: paint.faceMaterial, codes: paint.codes } }, fin);
  assert.equal(out.nearest, 0);
  const Q = out.mesh.positions, U = out.mesh.triangles, n = U.length / 3;
  // the UVs are the model's at every corner
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const v = U[t * 3 + k] * 3;
    const [u, w] = uvAt(Q[v], Q[v + 1], Q[v + 2]);
    assert.ok(Math.abs(out.uvs![t * 6 + k * 2] - u) < 1e-5 && Math.abs(out.uvs![t * 6 + k * 2 + 1] - w) < 1e-5, `uv of triangle ${t}`);
  }
  // the material of the piece's model triangle
  for (let t = 0; t < n; t++) assert.equal(out.faceMaterial[t], model.faceMaterial[fin.source[t]]);
  // the paint: at points over every triangle, the colour the model had there
  const painted = new PaintModel(out.mesh);
  painted.restore(out.paint!.colour, out.paint!.codes);
  let wrong = 0, all = 0, copied = 0, repainted = 0;
  const P = mesh.positions, T = mesh.triangles;
  for (let t = 0; t < n; t++) {
    const s = fin.source[t];
    if (paint.codes.has(s) && out.paint!.codes.get(t) === paint.codes.get(s)) copied++;
    else if (out.paint!.codes.has(t)) repainted++;
    for (const w of samples(40, t + 1)) {
      const p = painted.point(t, w);
      // the point as weights of the model's triangle (both lie in its plane)
      const a = T[s * 3] * 3, b = T[s * 3 + 1] * 3, c = T[s * 3 + 2] * 3;
      const e0 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e1 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const d = [p[0] - P[a], p[1] - P[a + 1], p[2] - P[a + 2]];
      const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
      const d00 = dot(e0, e0), d01 = dot(e0, e1), d11 = dot(e1, e1), d20 = dot(d, e0), d21 = dot(d, e1), den = d00 * d11 - d01 * d01;
      const bv = (d11 * d20 - d01 * d21) / den, bw = (d00 * d21 - d01 * d20) / den;
      all++;
      if (painted.colourAt(t, w) !== paint.colourAt(s, [1 - bv - bw, bv, bw])) wrong++;
    }
  }
  // pieces the boolean didn't cut keep their codes as they were
  assert.ok(copied > 0, 'codes copied');
  // and pieces of painted triangles are painted again from the paint over them
  assert.ok(repainted > 0, 'pieces repainted');
  assert.ok(wrong / all < 0.01, `${wrong} of ${all} points changed colour`);
});

test('a surface finishing made takes its colour from the nearest of the model facing its way', async () => {
  // a box without its top, the walls painted: red at the back (y = 20), the rest blue
  const box = boxes(2, [0, 0, 0, 20, 20, 20]);
  const keep: number[] = [];
  const P = box.positions, T = box.triangles;
  for (let t = 0; t < T.length / 3; t++) {
    const top = [0, 1, 2].every((k) => P[T[t * 3 + k] * 3 + 2] === 20);
    if (!top) keep.push(T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
  }
  const mesh = { positions: P, triangles: Uint32Array.from(keep) };
  const model = modelOf(mesh);
  const paint = new PaintModel(mesh);
  const back: number[] = [], rest: number[] = [];
  for (let t = 0; t < keep.length / 3; t++) ([0, 1, 2].every((k) => P[keep[t * 3 + k] * 3 + 1] === 20) ? back : rest).push(t);
  paint.paintFaces(rest, 2);
  paint.paintFaces(back, 1);
  const fin = await makeWatertight(mesh, null);
  const lid = [...fin.source].filter((s) => s < 0).length;
  assert.ok(lid > 0);
  const out = mapFinished({ ...model, paint: { colour: paint.faceMaterial, codes: paint.codes } }, fin);
  assert.equal(out.nearest, lid);
  // the lid's colours come from the walls (there is nothing facing up near it), and it has UVs and a material
  for (let t = 0; t < fin.source.length; t++) {
    if (fin.source[t] >= 0) { assert.equal(out.paint!.colour[t], paint.faceMaterial[fin.source[t]]); continue; }
    assert.ok([1, 2].includes(out.paint!.colour[t]));
    assert.ok(Number.isFinite(out.uvs![t * 6]));
  }
});

test('the base is its own material, in colour 1', async () => {
  const mesh = boxes(1, [0, 0, 0, 10, 10, 10]);
  const model = modelOf(mesh);
  const paint = new PaintModel(mesh);
  paint.fillAll(3);
  const fin = await makeWatertight(mesh, null, { base: 'square' });
  const out = mapFinished({ ...model, paint: { colour: paint.faceMaterial, codes: paint.codes }, baseMaterial: 7 }, fin);
  assert.equal(out.nearest, 0);
  let base = 0;
  for (let t = 0; t < fin.source.length; t++) {
    if (fin.source[t] !== BASE) { assert.equal(out.paint!.colour[t], 3); continue; }
    base++;
    assert.equal(out.faceMaterial[t], 7);
    assert.equal(out.paint!.colour[t], 0);
    assert.equal(out.faceGroup[t], 1);
  }
  assert.ok(base >= 10);
});

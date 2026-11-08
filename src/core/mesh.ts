// The mesh the app paints, and the small geometry helpers everything shares.
// Pure: no DOM, so the worker, the page and the tests use the same code.

/** Triangles over shared vertices. */
export interface IndexedMesh {
  /** xyz per vertex, flat */
  positions: Float32Array;
  /** 3 vertex indices per triangle, flat */
  triangles: Uint32Array;
}

export type V3 = [number, number, number];

export function faceCount(mesh: IndexedMesh): number {
  return mesh.triangles.length / 3;
}

/** The box round the vertices the triangles use. */
export function bounds(mesh: IndexedMesh): { min: V3; max: V3 } {
  const P = mesh.positions, T = mesh.triangles;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < T.length; i++) {
    const v = T[i] * 3;
    for (let d = 0; d < 3; d++) {
      const x = P[v + d];
      if (x < min[d]) min[d] = x;
      if (x > max[d]) max[d] = x;
    }
  }
  if (!T.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Area of every triangle. */
export function faceAreas(mesh: IndexedMesh): Float64Array {
  const P = mesh.positions, T = mesh.triangles, n = T.length / 3;
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[f] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return out;
}

/**
 * Applies a 3x3 linear map (row-major) and then a shift to every vertex, in
 * place. A map that mirrors (negative determinant) also turns every triangle
 * round, so the faces still face outwards; `turned` is told which corners
 * swapped so data kept per corner (UVs) can follow.
 */
export function transformInPlace(mesh: IndexedMesh, m: number[], shift: V3 = [0, 0, 0]): boolean {
  const P = mesh.positions;
  for (let v = 0; v < P.length; v += 3) {
    const x = P[v], y = P[v + 1], z = P[v + 2];
    P[v] = m[0] * x + m[1] * y + m[2] * z + shift[0];
    P[v + 1] = m[3] * x + m[4] * y + m[5] * z + shift[1];
    P[v + 2] = m[6] * x + m[7] * y + m[8] * z + shift[2];
  }
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (det >= 0) return false;
  const T = mesh.triangles;
  for (let i = 0; i < T.length; i += 3) { const t = T[i + 1]; T[i + 1] = T[i + 2]; T[i + 2] = t; }
  return true;
}

/** Swaps corners 1 and 2 of every triangle's per-corner data (`width` numbers per corner), after a mirror. */
export function swapCorners<T extends Float32Array | Uint8Array>(data: T, width: number): T {
  const per = width * 3;
  for (let i = 0; i < data.length; i += per) {
    for (let k = 0; k < width; k++) {
      const a = i + width + k, b = i + 2 * width + k;
      const t = data[a]; data[a] = data[b]; data[b] = t;
    }
  }
  return data;
}

/**
 * Joins vertices that lie in the same place (within `tolerance`, default a
 * millionth of the model's size), so a model split along its UV seams becomes
 * one surface again; triangles whose corners merge are dropped. Returns the
 * welded mesh and, for each triangle kept, the triangle it was.
 */
export function weld(mesh: IndexedMesh, tolerance?: number): { mesh: IndexedMesh; kept: Uint32Array } {
  const P = mesh.positions, T = mesh.triangles, nv = P.length / 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.length; i++) { const x = P[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
  const span = Number.isFinite(hi - lo) && hi > lo ? hi - lo : 1;
  const eps = tolerance ?? span * 1e-6;
  const inv = 1 / eps;
  // open addressing over the quantised positions
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Int32Array(nv * 3);
  const remap = new Uint32Array(nv);
  const out: number[] = [];
  let count = 0;
  for (let v = 0; v < nv; v++) {
    const qx = Math.round(P[v * 3] * inv) | 0, qy = Math.round(P[v * 3 + 1] * inv) | 0, qz = Math.round(P[v * 3 + 2] * inv) | 0;
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & (size - 1);
    for (;;) {
      const at = table[h];
      if (at < 0) {
        table[h] = count;
        keys[count * 3] = qx; keys[count * 3 + 1] = qy; keys[count * 3 + 2] = qz;
        out.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        remap[v] = count++;
        break;
      }
      if (keys[at * 3] === qx && keys[at * 3 + 1] === qy && keys[at * 3 + 2] === qz) { remap[v] = at; break; }
      h = (h + 1) & (size - 1);
    }
  }
  const tris = new Uint32Array(T.length);
  const kept = new Uint32Array(T.length / 3);
  let nt = 0;
  for (let f = 0; f < T.length / 3; f++) {
    const a = remap[T[f * 3]], b = remap[T[f * 3 + 1]], c = remap[T[f * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    tris[nt * 3] = a; tris[nt * 3 + 1] = b; tris[nt * 3 + 2] = c;
    kept[nt++] = f;
  }
  return { mesh: { positions: Float32Array.from(out), triangles: tris.slice(0, nt * 3) }, kept: kept.slice(0, nt) };
}

/** Picks the entries of per-triangle data (`width` values per triangle) for the triangles kept. */
export function pickFaces<T extends Float32Array | Uint8Array | Uint16Array | Uint32Array>(data: T, width: number, kept: Uint32Array): T {
  const Ctor = data.constructor as new (n: number) => T;
  const out = new Ctor(kept.length * width);
  for (let i = 0; i < kept.length; i++) {
    const from = kept[i] * width, to = i * width;
    for (let k = 0; k < width; k++) out[to + k] = data[from + k];
  }
  return out;
}

/** Drops vertices no triangle uses. */
export function compact(mesh: IndexedMesh): IndexedMesh {
  const P = mesh.positions, T = mesh.triangles;
  const map = new Int32Array(P.length / 3).fill(-1);
  const pos: number[] = [];
  const tris = new Uint32Array(T.length);
  for (let i = 0; i < T.length; i++) {
    const v = T[i];
    if (map[v] < 0) { map[v] = pos.length / 3; pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
    tris[i] = map[v];
  }
  return { positions: Float32Array.from(pos), triangles: tris };
}

/** Edges used by only one triangle, and edges used by more than two: how far the mesh is from a closed solid. */
export function openEdges(mesh: IndexedMesh): { open: number; overused: number } {
  const T = mesh.triangles;
  const count = new Map<number, number>();
  const nv = mesh.positions.length / 3;
  for (let f = 0; f < T.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const a = T[f * 3 + k], b = T[f * 3 + ((k + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let open = 0, overused = 0;
  for (const c of count.values()) { if (c === 1) open++; else if (c > 2) overused++; }
  return { open, overused };
}

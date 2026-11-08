// The model made watertight (finish.ts) with everything the model had: each
// of its triangles takes the UVs, vertex colours, material and paint of the
// model's triangle it is a piece of, so its textures show on it as before,
// it can be painted from them again, and paint done by hand stays where it
// was. A triangle the same as the model's keeps its paint exactly (its code
// copied); a piece of one is painted again from the paint over it, split
// where that changes colour, as finely as the paint was; a surface finishing
// made (the lid over an opening, a part rebuilt from voxels, a bridge over a
// gap) takes all that from the nearest of the model's surface facing the
// same way, as Dark STL paints its finished model. Pure.

import type { IndexedMesh } from './mesh.ts';
import { BASE } from './finish.ts';
import { pointTriangle2 } from './paint-model.ts';
import { CORNERS, collapse, decodePaint, encodePaint, forEachLeaf, majority, splitLong, type Bary, type PaintNode } from './paint-tree.ts';

/** The model as it was finished. */
export interface FinishSource {
  mesh: IndexedMesh;
  /** 6 per triangle */
  uvs: Float32Array | null;
  /** 9 per triangle */
  vertexColours: Uint8Array | null;
  /** the material of each triangle */
  faceMaterial: ArrayLike<number>;
  faceGroup: ArrayLike<number>;
  /** its paint: each triangle's colour, and the slicer code (state = colour + 1) of those painted in part */
  paint?: { colour: Uint8Array; codes: Map<number, string> } | null;
  /** the material the base finishing added is in (default 0); it is painted colour 1 */
  baseMaterial?: number;
}

export interface FinishedModel {
  /** the finished mesh, a triangle the same as the model's turned to start at the same corner */
  mesh: IndexedMesh;
  uvs: Float32Array | null;
  vertexColours: Uint8Array | null;
  faceMaterial: Uint16Array;
  faceGroup: Uint32Array;
  paint: { colour: Uint8Array; codes: Map<number, string> } | null;
  /** triangles that took everything from the nearest of the model's surface (finishing made them) */
  nearest: number;
}

/** a surface only takes from one whose normal is within about 70° of its own, or its reverse (Dark STL's) */
const FACING = 0.3;
/** pieces of paint copied are split down to this, mm */
const MIN_EDGE = 0.05;
const MAX_DEPTH = 16;

const stateOf = (m: number) => m + 1;
const colourOf = (s: number) => Math.max(0, s - 1);

/** The finished mesh with the model's UVs, colours, materials and paint on it. `source`: each triangle's model triangle, −1, or BASE. */
export function mapFinished(src: FinishSource, finished: { mesh: IndexedMesh; source: Int32Array }, progress?: (fraction: number) => void): FinishedModel {
  const P = src.mesh.positions, T = src.mesh.triangles;
  const Q = finished.mesh.positions, U = Uint32Array.from(finished.mesh.triangles);
  const n = U.length / 3;
  const source = Int32Array.from(finished.source);
  const normals = triangleNormals(P, T);
  // a surface finishing made: the model's nearest triangle facing the same way
  let nearest = 0;
  let index: SurfaceIndex | null = null, qn: Float32Array | null = null;
  for (let t = 0; t < n; t++) {
    if (source[t] >= 0 || source[t] === BASE) continue;
    if (progress && (nearest & 32767) === 0) progress((0.6 * t) / n);
    index ??= new SurfaceIndex(P, T, normals);
    qn ??= triangleNormals(Q, U);
    const a = U[t * 3] * 3, b = U[t * 3 + 1] * 3, c = U[t * 3 + 2] * 3;
    source[t] = index.nearest((Q[a] + Q[b] + Q[c]) / 3, (Q[a + 1] + Q[b + 1] + Q[c + 1]) / 3, (Q[a + 2] + Q[b + 2] + Q[c + 2]) / 3, qn[t * 3], qn[t * 3 + 1], qn[t * 3 + 2]);
    nearest++;
  }
  const exact = Uint8Array.from(finished.source, (s) => (s >= 0 ? 1 : 0));
  // each corner as weights of its model triangle's corners (projected into its plane)
  const B = new Float64Array(n * 9);
  const same = new Uint8Array(n);
  const w = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    const s = source[t];
    if (s === BASE) continue;
    for (let i = 0; i < 3; i++) {
      const q = U[t * 3 + i] * 3;
      bary(P, T, s, Q[q], Q[q + 1], Q[q + 2], w);
      B[t * 9 + i * 3] = w[0]; B[t * 9 + i * 3 + 1] = w[1]; B[t * 9 + i * 3 + 2] = w[2];
    }
    if (!exact[t]) continue;
    // the model's own triangle: turned to start where it does, so its paint code fits as it is
    const corner = [-1, -1, -1];
    let ok = true;
    for (let i = 0; i < 3 && ok; i++) {
      let k = -1;
      for (let j = 0; j < 3; j++) if (Math.abs(B[t * 9 + i * 3 + j] - 1) < 1e-5) k = j;
      if (k < 0 || Math.abs(B[t * 9 + i * 3 + ((k + 1) % 3)]) > 1e-5 || Math.abs(B[t * 9 + i * 3 + ((k + 2) % 3)]) > 1e-5) ok = false;
      else corner[i] = k;
    }
    // the corners in the same turn (an even order) and none twice
    if (!ok || new Set(corner).size < 3 || (corner[1] - corner[0] + 3) % 3 !== 1) continue;
    const r = corner.indexOf(0);
    const v = [U[t * 3], U[t * 3 + 1], U[t * 3 + 2]];
    for (let k = 0; k < 3; k++) U[t * 3 + k] = v[(r + k) % 3];
    B.fill(0, t * 9, t * 9 + 9);
    B[t * 9] = 1; B[t * 9 + 4] = 1; B[t * 9 + 8] = 1;
    same[t] = 1;
  }
  // per corner: the model's, mixed by the weights
  let uvs: Float32Array | null = null;
  if (src.uvs) {
    const UV = src.uvs;
    uvs = new Float32Array(n * 6);
    for (let t = 0; t < n; t++) {
      const s = source[t];
      if (s === BASE) continue;
      for (let i = 0; i < 3; i++) for (let d = 0; d < 2; d++) {
        let x = 0;
        for (let k = 0; k < 3; k++) x += B[t * 9 + i * 3 + k] * UV[s * 6 + k * 2 + d];
        uvs[t * 6 + i * 2 + d] = x;
      }
    }
  }
  let vertexColours: Uint8Array | null = null;
  if (src.vertexColours) {
    const C = src.vertexColours;
    vertexColours = new Uint8Array(n * 9);
    for (let t = 0; t < n; t++) {
      const s = source[t];
      if (s === BASE) { vertexColours.fill(255, t * 9, t * 9 + 9); continue; }
      for (let i = 0; i < 3; i++) for (let d = 0; d < 3; d++) {
        let x = 0;
        for (let k = 0; k < 3; k++) x += B[t * 9 + i * 3 + k] * C[s * 9 + k * 3 + d];
        vertexColours[t * 9 + i * 3 + d] = Math.max(0, Math.min(255, Math.round(x)));
      }
    }
  }
  const faceMaterial = new Uint16Array(n), faceGroup = new Uint32Array(n);
  let groups = 0;
  for (let f = 0; f < src.faceGroup.length; f++) groups = Math.max(groups, src.faceGroup[f] + 1);
  for (let t = 0; t < n; t++) {
    const s = source[t];
    if (s === BASE) { faceMaterial[t] = src.baseMaterial ?? 0; faceGroup[t] = groups; continue; }
    faceMaterial[t] = src.faceMaterial[s] ?? 0;
    faceGroup[t] = src.faceGroup[s] ?? 0;
  }
  // the paint
  let paint: FinishedModel['paint'] = null;
  if (src.paint) {
    const { colour: C, codes } = src.paint;
    const colour = new Uint8Array(n);
    const out = new Map<number, string>();
    const trees = new Map<number, PaintNode | null>();
    const treeOf = (s: number) => {
      let tr = trees.get(s);
      if (tr === undefined) { tr = decodePaint(codes.get(s)!, colourOf); trees.set(s, tr); if (trees.size > 4096) trees.delete(trees.keys().next().value!); }
      return tr;
    };
    const xyz = new Float64Array(9);
    for (let t = 0; t < n; t++) {
      const s = source[t];
      if (progress && (t & 32767) === 0) progress(0.6 + (0.4 * t) / n);
      if (s === BASE) continue;
      const code = codes.get(s);
      if (!code) { colour[t] = C[s]; continue; }
      if (same[t]) { out.set(t, code); colour[t] = C[s]; continue; }
      const tree = treeOf(s);
      if (!tree) { colour[t] = C[s]; continue; }
      const Bt = B.subarray(t * 9, t * 9 + 9);
      if (!exact[t]) {
        // one colour: the paint where the middle is nearest
        const m: Bary = [0, 0, 0];
        for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) m[k] += Bt[i * 3 + k] / 3;
        colour[t] = colourAtPoint(tree, clampBary(m));
        continue;
      }
      for (let i = 0; i < 3; i++) for (let d = 0; d < 3; d++) xyz[i * 3 + d] = Q[U[t * 3 + i] * 3 + d];
      const mine = paintPiece(tree, Bt, xyz);
      if (collapse(mine)) colour[t] = mine.material;
      else { out.set(t, encodePaint(mine, stateOf)); colour[t] = majority(mine); }
    }
    paint = { colour, codes: out };
  }
  return { mesh: { positions: Q, triangles: U }, uvs, vertexColours, faceMaterial, faceGroup, paint, nearest };
}

/** The unit normal of every triangle. */
function triangleNormals(P: ArrayLike<number>, T: ArrayLike<number>): Float32Array {
  const n = T.length / 3, out = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    out[f * 3] = x / l; out[f * 3 + 1] = y / l; out[f * 3 + 2] = z / l;
  }
  return out;
}

/** A point's weights of triangle `s`'s corners, the point first moved square into its plane. */
function bary(P: ArrayLike<number>, T: ArrayLike<number>, s: number, x: number, y: number, z: number, out: number[]): void {
  const a = T[s * 3] * 3, b = T[s * 3 + 1] * 3, c = T[s * 3 + 2] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  const px = x - P[a], py = y - P[a + 1], pz = z - P[a + 2];
  const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
  const d20 = px * ux + py * uy + pz * uz, d21 = px * vx + py * vy + pz * vz;
  const den = d00 * d11 - d01 * d01;
  if (!(Math.abs(den) > 1e-30)) { out[0] = out[1] = out[2] = 1 / 3; return; }
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  out[0] = 1 - v - w; out[1] = v; out[2] = w;
}

function clampBary(w: Bary): Bary {
  const a = Math.max(0, w[0]), b = Math.max(0, w[1]), c = Math.max(0, w[2]);
  const s = a + b + c || 1;
  return [a / s, b / s, c / s];
}

/** The colour of a tree's leaf holding the point `w` (weights of its triangle's corners). */
function colourAtPoint(tree: PaintNode, w: Bary): number {
  let n = tree;
  while (n.children) {
    let best = n.children[0], most = -Infinity;
    for (const c of n.children) { const k = inside(c.v, w); if (k > most) { most = k; best = c; } }
    n = best;
  }
  return n.material;
}

/** How far inside the triangle with corners `v` (weights) the point `w` lies: its smallest weight of them. */
function inside(v: [Bary, Bary, Bary], w: Bary): number {
  const x0 = v[0][1], y0 = v[0][2], x1 = v[1][1], y1 = v[1][2], x2 = v[2][1], y2 = v[2][2];
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-18) return -Infinity;
  const px = w[1] - x0, py = w[2] - y0;
  const l1 = (px * (y2 - y0) - (x2 - x0) * py) / det, l2 = ((x1 - x0) * py - px * (y1 - y0)) / det;
  return Math.min(1 - l1 - l2, l1, l2);
}

/**
 * Paint for a piece of a painted triangle: a tree over the piece, split where
 * the paint under it changes colour, down to MIN_EDGE. `B` holds the piece's
 * corners as weights of the painted triangle's (3 × 3), `xyz` their places.
 */
function paintPiece(tree: PaintNode, B: ArrayLike<number>, xyz: ArrayLike<number>): PaintNode {
  // the painted triangle's leaves, as 2D triangles (their corners' first two weights)
  const xy: number[] = [], mat: number[] = [];
  forEachLeaf(tree, (l) => { for (const c of l.v) xy.push(c[0], c[1]); mat.push(l.material); });
  const L = Float64Array.from(xy);
  const root: PaintNode = { v: CORNERS, material: 0 };
  const q = new Float64Array(6);
  const p = new Float64Array(9);
  const walk = (node: PaintNode, depth: number, near: number[]) => {
    // the node's corners in the painted triangle
    for (let i = 0; i < 3; i++) {
      const v = node.v[i];
      q[i * 2] = v[0] * B[0] + v[1] * B[3] + v[2] * B[6];
      q[i * 2 + 1] = v[0] * B[1] + v[1] * B[4] + v[2] * B[7];
    }
    // the leaves under it (only those under its parent can be)
    const under: number[] = [];
    let found = 0;
    for (const i of near) if (!separates(L, i * 6, q, 0) && !separates(q, 0, L, i * 6)) { under.push(i); found |= 1 << mat[i]; }
    if ((found & (found - 1)) === 0) { node.material = found ? 31 - Math.clz32(found) : centre(); return; }
    for (let i = 0; i < 3; i++) for (let d = 0; d < 3; d++) p[i * 3 + d] = node.v[i][0] * xyz[d] + node.v[i][1] * xyz[3 + d] + node.v[i][2] * xyz[6 + d];
    const len = (i: number, j: number) => Math.hypot(p[j * 3] - p[i * 3], p[j * 3 + 1] - p[i * 3 + 1], p[j * 3 + 2] - p[i * 3 + 2]);
    const l: [number, number, number] = [len(0, 1), len(1, 2), len(2, 0)];
    const most = Math.max(l[0], l[1], l[2]);
    if (most < MIN_EDGE || depth >= MAX_DEPTH) { node.material = centre(); return; }
    // the long sides, as the slicers split a sliver
    splitLong(node, [l[0] >= most / 2, l[1] >= most / 2, l[2] >= most / 2]);
    for (const c of node.children!) walk(c, depth + 1, under);
    function centre() {
      return colourAtPoint(tree, clampBary([(q[0] + q[2] + q[4]) / 3, (q[1] + q[3] + q[5]) / 3, 1 - (q[0] + q[2] + q[4] + q[1] + q[3] + q[5]) / 3]));
    }
  };
  walk(root, 0, Array.from(mat, (_, i) => i));
  return root;
}

/** Whether a side of triangle `a` (6 numbers from `i`) separates it from triangle `b` (from `j`); touching along a side counts. */
function separates(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): boolean {
  for (let e = 0; e < 3; e++) {
    const s = i + e * 2, t = i + ((e + 1) % 3) * 2;
    const nx = a[t + 1] - a[s + 1], ny = a[s] - a[t];
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const pa = a[i + k * 2] * nx + a[i + k * 2 + 1] * ny, pb = b[j + k * 2] * nx + b[j + k * 2 + 1] * ny;
      if (pa < amin) amin = pa;
      if (pa > amax) amax = pa;
      if (pb < bmin) bmin = pb;
      if (pb > bmax) bmax = pb;
    }
    const eps = 1e-10 * (Math.abs(nx) + Math.abs(ny));
    if (amax <= bmin + eps || bmax <= amin + eps) return true;
  }
  return false;
}

/** The model's triangles in a grid of cells, to find the one nearest a point. */
class SurfaceIndex {
  private cells = new Map<number, number[]>();
  /** triangles too big to put in every cell they cross: looked at every time */
  private big: number[] = [];
  private lo: number[];
  private h: number;
  private dims: number[];
  private reach: number;
  private P: ArrayLike<number>;
  private T: ArrayLike<number>;
  private N: Float32Array;
  private stamp: Int32Array;
  private query = 0;

  constructor(P: ArrayLike<number>, T: ArrayLike<number>, N: Float32Array) {
    this.P = P; this.T = T; this.N = N;
    const n = T.length / 3;
    this.stamp = new Int32Array(n);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < T.length; i++) for (let d = 0; d < 3; d++) { const x = P[T[i] * 3 + d]; if (x < lo[d]) lo[d] = x; if (x > hi[d]) hi[d] = x; }
    const span = [0, 1, 2].map((d) => Math.max(hi[d] - lo[d], 1e-6));
    // cells about a triangle across, so each holds a few
    let edges = 0;
    for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) {
      const a = T[f * 3 + k] * 3, b = T[f * 3 + ((k + 1) % 3)] * 3;
      edges += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    }
    this.h = Math.max(edges / Math.max(1, 3 * n), Math.max(...span) / 256);
    this.lo = lo;
    this.dims = span.map((x) => Math.max(1, Math.ceil(x / this.h)));
    this.reach = Math.max(...span) * 0.05;
    for (let f = 0; f < n; f++) {
      const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) { const x = P[T[f * 3 + k] * 3 + d]; if (x < a[d]) a[d] = x; if (x > b[d]) b[d] = x; }
      const i0 = this.cell(a[0], a[1], a[2]), i1 = this.cell(b[0], b[1], b[2]);
      if ((i1[0] - i0[0] + 1) * (i1[1] - i0[1] + 1) * (i1[2] - i0[2] + 1) > 512) { this.big.push(f); continue; }
      for (let i = i0[0]; i <= i1[0]; i++) for (let j = i0[1]; j <= i1[1]; j++) for (let k = i0[2]; k <= i1[2]; k++) {
        const key = (i * this.dims[1] + j) * this.dims[2] + k;
        let l = this.cells.get(key);
        if (!l) this.cells.set(key, (l = []));
        l.push(f);
      }
    }
  }

  private cell(x: number, y: number, z: number): number[] {
    const p = [x, y, z];
    return [0, 1, 2].map((d) => Math.min(this.dims[d] - 1, Math.max(0, Math.floor((p[d] - this.lo[d]) / this.h))));
  }

  /** The triangle nearest the point that faces about the way `n` does (either way round), else the nearest. */
  nearest(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const P = this.P, T = this.T, N = this.N, stamp = this.stamp;
    const q = ++this.query;
    const c = this.cell(x, y, z);
    let best = -1, bestD = Infinity, any = -1, anyD = Infinity;
    const look = (f: number) => {
      if (stamp[f] === q) return;
      stamp[f] = q;
      const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, cc = T[f * 3 + 2] * 3;
      const d = pointTriangle2(x, y, z, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[cc], P[cc + 1], P[cc + 2]);
      if (d < anyD) { anyD = d; any = f; }
      if (d < bestD && Math.abs(N[f * 3] * nx + N[f * 3 + 1] * ny + N[f * 3 + 2] * nz) > FACING) { bestD = d; best = f; }
    };
    for (const f of this.big) look(f);
    const most = Math.max(...this.dims);
    for (let ring = 0; ring <= most; ring++) {
      // everything nearer than the ring's inside has been seen
      const near = Math.max(0, ring - 1) * this.h;
      if (best >= 0 && near * near > bestD) break;
      if (best < 0 && any >= 0 && near > this.reach && near * near > anyD) break;
      for (let i = Math.max(0, c[0] - ring); i <= Math.min(this.dims[0] - 1, c[0] + ring); i++) {
        for (let j = Math.max(0, c[1] - ring); j <= Math.min(this.dims[1] - 1, c[1] + ring); j++) {
          const edge = Math.abs(i - c[0]) === ring || Math.abs(j - c[1]) === ring;
          for (let k = Math.max(0, c[2] - ring); k <= Math.min(this.dims[2] - 1, c[2] + ring); k++) {
            // only the ring's own shell: inside it has been looked at
            if (!edge && Math.abs(k - c[2]) !== ring) { k = c[2] + ring - 1; continue; }
            const l = this.cells.get((i * this.dims[1] + j) * this.dims[2] + k);
            if (l) for (const f of l) look(f);
          }
        }
      }
    }
    return best >= 0 && Math.sqrt(bestD) <= Math.sqrt(anyD) + this.reach ? best : Math.max(0, any);
  }
}

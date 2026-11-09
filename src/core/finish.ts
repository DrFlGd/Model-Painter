// Finishing a model for printing, from Dark STL's finish.py and cut.py's
// make_solid: the model wrapped into one watertight solid with nothing left
// inside it. Game models are built from parts that overlap (an arm pushed into
// a sleeve, armour plates over a body, a head into a hood) and from open
// surfaces (capes, single-sided cloth); a slicer given them as they are prints
// walls where parts cross, or fails on the open edges. Here:
//
// 1. Each connected part is made solid: a closed one as it is, small openings
//    (a neck, a sleeve end) closed with a fan, an open surface (a cape)
//    thickened into a shell, and whatever is still broken rebuilt from voxels.
//    The parts are united, so where they cross only the outside stays, exactly
//    as it was.
// 2. Hollows sealed inside the model (between a body and a closed coat over
//    it) are filled, so no inside surfaces are left.
// 3. Optionally, gaps narrower than a width are bridged (the slit between a
//    sleeve and the arm in it): the model as voxels, closed, and the bridges
//    kept under the real surface where there is no gap.
// 4. Optionally, loose bits smaller than a share of the model are removed.
//
// Every triangle of the result says where it came from: the model's triangle
// it is a piece of (lying in its plane, or behind it on the back of a
// thickened cape), or none for a surface finishing made (a fan, a part
// rebuilt from voxels, a bridge), so paint and textures can follow it
// (finish-map.ts). Sizes in millimetres. Pure apart from manifold's
// WebAssembly.

import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { manifold } from './solid.ts';
import { weld, type IndexedMesh } from './mesh.ts';
import { blobs, blur, dilateBall, erodeBall, fieldSdf, fillHoles, grid, stepCross, type Grid } from './voxels.ts';

export interface FinishSettings {
  /** open surfaces are thickened to this, mm */
  sheet: number;
  /** fill space sealed inside the model */
  fillHollows: boolean;
  /** bridge gaps up to this wide, mm (0: off) */
  closeGaps: number;
  /** remove loose bits smaller than this % of the biggest piece's volume (0: keep all) */
  loose: number;
  /** cut this much off the bottom, so it stands on a flat face, mm (0: off) */
  flatten: number;
  /** a base for it to stand on */
  base: 'none' | 'round' | 'square';
  /** the base's thickness, mm */
  baseHeight: number;
  /** how far the base reaches past the model's foot, mm */
  baseMargin: number;
}

export const FINISH_DEFAULTS: FinishSettings = { sheet: 1.2, fillHollows: true, closeGaps: 0, loose: 0, flatten: 0, base: 'none', baseHeight: 3, baseMargin: 3 };

/** `Finished.source` for a triangle of the base */
export const BASE = -2;
/** how far the model sinks into its base, so the bottom of it all joins on, mm */
const SINK = 0.5;

export interface Finished {
  mesh: IndexedMesh;
  /** for each triangle, the model's triangle it is a piece of (in its plane, or behind it on a thickened sheet), −1 for a surface finishing made, BASE for the base */
  source: Int32Array;
  notes: string[];
  /** mm³ */
  volume: number;
  /** separate solids in it */
  shells: number;
  hollows: number;
  gapVolume: number;
  looseRemoved: number;
}

export type Progress = (fraction: number, text: string) => void;

/** voxels for closing gaps: about 290 a side */
export const MAX_CELLS = 24_000_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** Where the result's triangles came from: each solid made from the model's triangles is known by its manifold ID. */
export class Origins {
  /** faceID → the model's triangle (−1 for one finishing made) */
  private ids: number[] = [];
  private mine = new Set<number>();
  m: ManifoldToplevel;
  constructor(m: ManifoldToplevel) { this.m = m; }

  /**
   * A solid from triangles, each with the model's triangle it lies on (or −1);
   * null when it is not a clean closed surface. With `oneFace`, all its
   * triangles are one face (they come from none of the model's), so it can
   * be simplified across them.
   */
  solid(positions: ArrayLike<number>, triangles: ArrayLike<number>, source: ArrayLike<number> | number, oneFace = false): Manifold | null {
    const n = triangles.length / 3;
    const faceID = new Uint32Array(n);
    if (oneFace) { faceID.fill(this.ids.length); this.ids.push(typeof source === 'number' ? source : -1); }
    else for (let t = 0; t < n; t++) { faceID[t] = this.ids.length; this.ids.push(typeof source === 'number' ? source : source[t]); }
    // the solid's own ID marks its triangles in whatever is made from it (originalID() reads −1 for a mesh made here)
    const id = this.m.Manifold.reserveIDs(1);
    const mesh = new this.m.Mesh({
      numProp: 3, vertProperties: Float32Array.from(positions), triVerts: Uint32Array.from(triangles), faceID,
      runOriginalID: Uint32Array.of(id), runIndex: Uint32Array.of(0, n * 3),
    });
    let s: Manifold;
    try { s = new this.m.Manifold(mesh); } catch { return null; }
    if (s.status() !== 'NoError' || s.isEmpty() || s.volume() < 0) { s.delete(); return null; }
    this.mine.add(id);
    return s;
  }

  /** A surface made from voxels (a levelSet) as one face, simplified by up to `tolerance`; the one given is used up. */
  smooth(s: Manifold, tolerance: number): Manifold {
    const g = s.getMesh();
    s.delete();
    const one = this.solid(g.vertProperties.length === g.numVert * 3 ? g.vertProperties : positionsOf(g), g.triVerts, -1, true);
    if (!one) throw new Error('a surface made from voxels is not closed');
    const out = one.simplify(tolerance);
    one.delete();
    return out;
  }

  /** The mesh of a solid and, for each triangle, the model's triangle it lies on (or −1); `other` for a triangle of no solid made here (a cut face, a peg). */
  read(s: Manifold, other = -1): { mesh: IndexedMesh; source: Int32Array } {
    const g = s.getMesh();
    const nv = g.numVert, np = g.numProp, nt = g.triVerts.length / 3;
    const positions = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) for (let d = 0; d < 3; d++) positions[v * 3 + d] = g.vertProperties[v * np + d];
    const source = new Int32Array(nt).fill(other);
    const runs = g.runOriginalID?.length ?? 0;
    for (let r = 0; r < runs; r++) {
      if (!this.mine.has(g.runOriginalID[r])) continue;
      for (let t = g.runIndex[r] / 3; t < g.runIndex[r + 1] / 3; t++) source[t] = this.ids[g.faceID[t]] ?? -1;
    }
    return { mesh: { positions, triangles: Uint32Array.from(g.triVerts) }, source };
  }
}

/** A manifold mesh's positions alone, when it carries more numbers per vertex. */
export function positionsOf(g: { numVert: number; numProp: number; vertProperties: Float32Array }): Float32Array {
  const out = new Float32Array(g.numVert * 3);
  for (let v = 0; v < g.numVert; v++) for (let d = 0; d < 3; d++) out[v * 3 + d] = g.vertProperties[v * g.numProp + d];
  return out;
}

// ---------------------------------------------------------------- surfaces

/** Union-find over `n` items. */
function finder(n: number) {
  const up = new Int32Array(n);
  for (let i = 0; i < n; i++) up[i] = i;
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  return { find, join: (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) up[x] = y; } };
}

/** The connected part each triangle belongs to, joined only through shared edges (surfaces that only touch at a corner stay apart). */
export function edgeParts(triangles: ArrayLike<number>): Int32Array {
  const n = triangles.length / 3;
  const u = finder(n);
  const first = new Map<number, number>();
  for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) {
    const a = triangles[f * 3 + k], b = triangles[f * 3 + ((k + 1) % 3)];
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    const g = first.get(key);
    if (g === undefined) first.set(key, f); else u.join(f, g);
  }
  const out = new Int32Array(n);
  for (let f = 0; f < n; f++) out[f] = u.find(f);
  return out;
}

/** The connected part (by shared corners) each triangle belongs to. */
function cornerParts(triangles: ArrayLike<number>, vertices: number): Int32Array {
  const u = finder(vertices);
  for (let f = 0; f < triangles.length / 3; f++) { u.join(triangles[f * 3], triangles[f * 3 + 1]); u.join(triangles[f * 3], triangles[f * 3 + 2]); }
  const out = new Int32Array(triangles.length / 3);
  for (let f = 0; f < out.length; f++) out[f] = u.find(triangles[f * 3]);
  return out;
}

export function signedVolume(P: ArrayLike<number>, T: ArrayLike<number>): number {
  let v = 0;
  for (let f = 0; f < T.length / 3; f++) {
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

function area(P: ArrayLike<number>, T: ArrayLike<number>): number {
  let s = 0;
  for (let f = 0; f < T.length / 3; f++) s += triArea(P, T[f * 3], T[f * 3 + 1], T[f * 3 + 2]);
  return s;
}

function triArea(P: ArrayLike<number>, i: number, j: number, k: number): number {
  const ux = P[j * 3] - P[i * 3], uy = P[j * 3 + 1] - P[i * 3 + 1], uz = P[j * 3 + 2] - P[i * 3 + 2];
  const vx = P[k * 3] - P[i * 3], vy = P[k * 3 + 1] - P[i * 3 + 1], vz = P[k * 3 + 2] - P[i * 3 + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** A part as its own vertices: positions, triangles, and the model's triangle each came from. */
interface Part { P: number[]; T: number[]; src: number[] }

function partOf(P: ArrayLike<number>, T: ArrayLike<number>, faces: ArrayLike<number>, src: ArrayLike<number>): Part {
  const map = new Map<number, number>();
  const out: Part = { P: [], T: [], src: [] };
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    for (let k = 0; k < 3; k++) {
      const v = T[f * 3 + k];
      let w = map.get(v);
      if (w === undefined) { w = map.size; map.set(v, w); out.P.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
      out.T.push(w);
    }
    out.src.push(src[f]);
  }
  return out;
}

/** The parts of a list of triangles, apart where they only touch at corners. */
function partsOf(P: ArrayLike<number>, T: ArrayLike<number>, faces: number[], src: ArrayLike<number>): Part[] {
  const sub: number[] = [];
  for (const f of faces) sub.push(T[f * 3], T[f * 3 + 1], T[f * 3 + 2]);
  const labels = edgeParts(sub);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i++) { let g = groups.get(labels[i]); if (!g) groups.set(labels[i], (g = [])); g.push(faces[i]); }
  return [...groups.values()].map((g) => partOf(P, T, g, src));
}

/**
 * The parts of a list of triangles where solids that touch along an edge (two
 * boxes sharing an edge, a plate's side on a body's) are taken apart: at an
 * edge with more than two triangles, each triangle is paired with the next one
 * round the edge on the side its solid lies, as the solids' surfaces meet
 * there, and parts join only across those pairs.
 */
function pairedParts(P: ArrayLike<number>, T: ArrayLike<number>, faces: number[], src: ArrayLike<number>): Part[] {
  const u = finder(faces.length);
  // per edge (low vertex first): the triangles on it, as [triangle << 2 | corner opposite, forward]
  const at = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i++) for (let k = 0; k < 3; k++) {
    const a = T[faces[i] * 3 + k], b = T[faces[i] * 3 + ((k + 1) % 3)];
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let l = at.get(key);
    if (!l) at.set(key, (l = []));
    l.push(i * 4 + ((k + 2) % 3), a < b ? 1 : 0);
  }
  const id = (e: number) => e >> 2;
  for (const [key, l] of at) {
    const n = l.length / 2;
    if (n === 2) { if (l[1] !== l[3]) u.join(id(l[0]), id(l[2])); continue; }
    if (n < 2) continue;
    const a = Math.floor(key / 4294967296), b = key - a * 4294967296;
    const d = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    for (let q = 0; q < 3; q++) d[q] /= dl;
    // a frame square to the edge
    const ref = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const dot = ref[0] * d[0] + ref[1] * d[1] + ref[2] * d[2];
    const e1 = [ref[0] - dot * d[0], ref[1] - dot * d[1], ref[2] - dot * d[2]];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]);
    for (let q = 0; q < 3; q++) e1[q] /= l1;
    const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const round: { angle: number; i: number; forward: boolean }[] = [];
    for (let j = 0; j < n; j++) {
      const i = id(l[j * 2]), c = T[faces[i] * 3 + (l[j * 2] & 3)];
      const w = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      round.push({ angle: Math.atan2(w[0] * e2[0] + w[1] * e2[1] + w[2] * e2[2], w[0] * e1[0] + w[1] * e1[1] + w[2] * e1[2]), i, forward: l[j * 2 + 1] === 1 });
    }
    round.sort((x, y) => x.angle - y.angle);
    // a triangle running b → a faces away from its solid turning forwards round the edge: the solid's other side
    // there is a triangle running a → b further on, the next one not taken by a solid nested between them
    // (matched like brackets, starting round the edge where none is open)
    let depth = 0, low = 0, start = 0;
    for (let j = 0; j < n; j++) { depth += round[j].forward ? -1 : 1; if (depth < low) { low = depth; start = j + 1; } }
    const open: number[] = [];
    for (let q = 0; q < n; q++) {
      const e = round[(start + q) % n];
      if (!e.forward) open.push(e.i);
      else if (open.length) u.join(open.pop()!, e.i);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i++) { const r = u.find(i); let g = groups.get(r); if (!g) groups.set(r, (g = [])); g.push(faces[i]); }
  return [...groups.values()].map((g) => partOf(P, T, g, src));
}

/** For each directed side (a → b) of the triangles: how often it occurs, and how often its reverse does. */
function sideCounts(T: number[]) {
  const n = T.length / 3;
  const key = (a: number, b: number) => a * 4294967296 + b;
  const count = new Map<number, number>();
  for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) { const h = key(T[f * 3 + k], T[f * 3 + ((k + 1) % 3)]); count.set(h, (count.get(h) ?? 0) + 1); }
  const same = new Int32Array(n * 3), reverse = new Int32Array(n * 3);
  for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) {
    const a = T[f * 3 + k], b = T[f * 3 + ((k + 1) % 3)];
    same[f * 3 + k] = count.get(key(a, b)) ?? 0;
    reverse[f * 3 + k] = count.get(key(b, a)) ?? 0;
  }
  return { same, reverse };
}

/** The open edges walked into loops (each as its vertices), or null when a vertex starts two of them. */
function openLoops(T: number[], reverse: Int32Array): number[][] | null {
  const next = new Map<number, number>();
  for (let s = 0; s < reverse.length; s++) {
    if (reverse[s]) continue;
    const f = Math.floor(s / 3), k = s % 3;
    const a = T[f * 3 + k], b = T[f * 3 + ((k + 1) % 3)];
    if (next.has(a)) return null;
    next.set(a, b);
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    if (v !== start) return null;
    loops.push(loop);
  }
  return loops;
}

/** Each loop closed with a fan of triangles to a new vertex at its middle: the part with them, and their area. */
function fillLoops(p: Part, loops: number[][]): { part: Part; area: number } {
  const out: Part = { P: p.P.slice(), T: p.T.slice(), src: p.src.slice() };
  let total = 0;
  for (const loop of loops) {
    const c = [0, 0, 0];
    for (const v of loop) for (let d = 0; d < 3; d++) c[d] += p.P[v * 3 + d] / loop.length;
    const centre = out.P.length / 3;
    out.P.push(c[0], c[1], c[2]);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      // the open side a → b belongs to a triangle already, so the new one runs b → a
      out.T.push(b, a, centre);
      out.src.push(-1);
      total += triArea(out.P, b, a, centre);
    }
  }
  return { part: out, area: total };
}

/** An open surface as a shell `t` thick: the surface, a copy moved inwards facing the other way, and a strip along the open edges. */
function thicken(p: Part, reverse: Int32Array, t: number): Part {
  const nv = p.P.length / 3, nf = p.T.length / 3;
  const N = new Float64Array(nv * 3);
  for (let f = 0; f < nf; f++) {
    const i = p.T[f * 3], j = p.T[f * 3 + 1], k = p.T[f * 3 + 2];
    const ux = p.P[j * 3] - p.P[i * 3], uy = p.P[j * 3 + 1] - p.P[i * 3 + 1], uz = p.P[j * 3 + 2] - p.P[i * 3 + 2];
    const vx = p.P[k * 3] - p.P[i * 3], vy = p.P[k * 3 + 1] - p.P[i * 3 + 1], vz = p.P[k * 3 + 2] - p.P[i * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const v of [i, j, k]) { N[v * 3] += cx; N[v * 3 + 1] += cy; N[v * 3 + 2] += cz; }
  }
  const out: Part = { P: p.P.slice(), T: p.T.slice(), src: p.src.slice() };
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
    out.P.push(p.P[v * 3] - (N[v * 3] / l) * t, p.P[v * 3 + 1] - (N[v * 3 + 1] / l) * t, p.P[v * 3 + 2] - (N[v * 3 + 2] / l) * t);
  }
  // the back is the front's triangle again (facing the other way), so it takes the front's paint
  for (let f = 0; f < nf; f++) { out.T.push(p.T[f * 3 + 2] + nv, p.T[f * 3 + 1] + nv, p.T[f * 3] + nv); out.src.push(p.src[f]); }
  for (let s = 0; s < reverse.length; s++) {
    if (reverse[s]) continue;
    const f = Math.floor(s / 3), k = s % 3;
    const a = p.T[f * 3 + k], b = p.T[f * 3 + ((k + 1) % 3)];
    out.T.push(b, a, a + nv, b, a + nv, b + nv);
    out.src.push(-1, -1);
  }
  return out;
}

/** A small, repeatable random number generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A broken part rebuilt from voxels: its surface marked in a grid, enclosed
 * space filled, and the surface of that taken again. Loses detail finer than
 * the grid, so it is only the last resort.
 */
function voxelSolid(o: Origins, p: Part, sheet: number): Manifold | null {
  const P = p.P, T = p.T;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < P.length / 3; v++) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], P[v * 3 + d]); hi[d] = Math.max(hi[d], P[v * 3 + d]); }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const h = Math.max(sheet / 2, span / 160, 1e-3);
  const pad = 3;
  const origin = lo.map((x) => x - pad * h);
  const shape = [0, 1, 2].map((d) => Math.ceil((hi[d] - lo[d]) / h) + 2 * pad + 1);
  const g = grid(shape[0], shape[1], shape[2]);
  const mark = (x: number, y: number, z: number) => {
    const i = Math.min(shape[0] - 1, Math.max(0, Math.round((x - origin[0]) / h)));
    const j = Math.min(shape[1] - 1, Math.max(0, Math.round((y - origin[1]) / h)));
    const k = Math.min(shape[2] - 1, Math.max(0, Math.round((z - origin[2]) / h)));
    g.data[(i * g.ny + j) * g.nz + k] = 1;
  };
  const rnd = random(0);
  for (let f = 0; f < T.length / 3; f++) {
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    const ar = triArea(P, T[f * 3], T[f * 3 + 1], T[f * 3 + 2]);
    const longest = Math.max(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]), Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2]));
    // enough points to cover the triangle, and its length too when it is a sliver narrower than a cell
    const per = Math.min(200_000, Math.max(1, Math.ceil(Math.max((ar / (h * h)) * 4, (longest / h) * 2))));
    for (let s = 0; s < per; s++) {
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      mark(P[a] + r1 * (P[b] - P[a]) + r2 * (P[c] - P[a]), P[a + 1] + r1 * (P[b + 1] - P[a + 1]) + r2 * (P[c + 1] - P[a + 1]), P[a + 2] + r1 * (P[b + 2] - P[a + 2]) + r2 * (P[c + 2] - P[a + 2]));
    }
  }
  for (let v = 0; v < P.length / 3; v++) mark(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  const solidGrid = fillHoles(stepCross(g, Math.max(1, Math.round(sheet / 2 / h))));
  const field = blur(Float32Array.from(solidGrid.data), g.nx, g.ny, g.nz, 0.8);
  // here a cell's value sits at its corner (origin + i h), not its middle
  const sdf = fieldSdf(field, g.nx, g.ny, g.nz, origin.map((x) => x - h / 2), h);
  const end = origin.map((x, d) => x + (shape[d] - 1) * h);
  const s = o.m.Manifold.levelSet(sdf, { min: origin as [number, number, number], max: end as [number, number, number] }, h * 1.2);
  if (s.status() !== 'NoError' || s.isEmpty()) { s.delete(); return null; }
  // a tenth of a cell is far finer than the voxels' own detail, and takes most of their triangles away
  return o.smooth(s, h * 0.1);
}

type How = 'closed' | 'filled' | 'thickened';

/** One connected part as a solid, and how; null when it is not a clean surface (left to the voxels). */
function partSolid(o: Origins, p: Part, sheet: number): { how: How; solid: Manifold } | null {
  const { same, reverse } = sideCounts(p.T);
  for (let s = 0; s < same.length; s++) if (same[s] !== 1 || reverse[s] > 1) return null;
  let open = false;
  for (let s = 0; s < reverse.length; s++) if (!reverse[s]) { open = true; break; }
  if (!open) {
    let T = p.T;
    if (signedVolume(p.P, T) < 0) T = flip(T);
    const solid = o.solid(p.P, T, p.src);
    return solid ? { how: 'closed', solid } : null;
  }
  const loops = openLoops(p.T, reverse);
  const whole = area(p.P, p.T);
  if (loops) {
    const { part: q, area: fillArea } = fillLoops(p, loops);
    const vol = signedVolume(q.P, q.T);
    // small openings are closed; a big one means an open surface (a cape), thickened instead
    if (fillArea < 0.3 * whole && Math.abs(vol) > fillArea * sheet * 0.5) {
      const solid = o.solid(q.P, vol < 0 ? flip(q.T) : q.T, q.src);
      if (solid) return { how: 'filled', solid };
    }
  }
  const t = thicken(p, reverse, sheet);
  const solid = o.solid(t.P, t.T, t.src);
  return solid ? { how: 'thickened', solid } : null;
}

const flip = (T: number[]) => { const out = T.slice(); for (let f = 0; f < out.length; f += 3) { const x = out[f]; out[f] = out[f + 2]; out[f + 2] = x; } return out; };

/**
 * The model as one closed solid (manifold), in millimetres. `groups` (a
 * number per triangle, the model's sub-mesh or material) splits a part whose
 * pieces only touch at a few welded points, so each can stay as it is.
 */
async function makeSolid(o: Origins, mesh: IndexedMesh, groups: ArrayLike<number> | null, sheet: number, progress?: Progress): Promise<{ solid: Manifold; notes: string[]; parts: number }> {
  if (!mesh.triangles.length) throw new Error('There is nothing to finish: the model has no triangles.');
  const { mesh: w, kept } = weld(mesh, 1e-4);
  const P = w.positions, T0 = w.triangles;
  // the same triangle twice (two-sided cloth is often one side and its mirror) is kept once
  const seen = new Set<string>();
  const faces: number[] = [];
  for (let f = 0; f < T0.length / 3; f++) {
    const k = [T0[f * 3], T0[f * 3 + 1], T0[f * 3 + 2]].sort((a, b) => a - b).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    faces.push(f);
  }
  const src = Int32Array.from(kept); // welded triangle → the model's
  const sub: number[] = [];
  for (const f of faces) sub.push(T0[f * 3], T0[f * 3 + 1], T0[f * 3 + 2]);
  const labels = edgeParts(sub);
  const byPart = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i++) { let g = byPart.get(labels[i]); if (!g) byPart.set(labels[i], (g = [])); g.push(faces[i]); }
  const solids: Manifold[] = [];
  const count = { closed: 0, filled: 0, thickened: 0, rebuilt: 0, dropped: 0 };
  const parts = [...byPart.values()];
  for (let pi = 0; pi < parts.length; pi++) {
    if (progress && pi % 16 === 0) progress(pi / parts.length, `Making the model solid: part ${pi + 1} of ${parts.length}`);
    const sel = parts[pi];
    const made: { how: How | 'rebuilt'; solid: Manifold }[] = [];
    const first = partSolid(o, partOf(P, T0, sel, src), sheet);
    if (first) made.push(first);
    else {
      const kinds = groups ? new Set(sel.map((f) => groups[src[f]])) : new Set([0]);
      if (kinds.size > 1) {
        // sub-meshes that only touch at a few welded points (an armour plate resting on a body) make one
        // tangled part; each on its own is often clean, and keeps its detail
        for (const k of kinds) {
          for (const q of partsOf(P, T0, sel.filter((f) => groups![src[f]] === k), src)) {
            const r = partSolid(o, q, sheet);
            if (r) { made.push(r); continue; }
            const v = voxelSolid(o, q, sheet);
            if (v) made.push({ how: 'rebuilt', solid: v }); else count.dropped++;
          }
        }
      }
      if (!made.length) {
        // pieces that meet only along tangled edges (boxes sharing an edge, a side there twice): each on its
        // own may be a clean solid
        const split = pairedParts(P, T0, sel, src);
        if (split.length > 1) {
          const tries = split.map((q) => partSolid(o, q, sheet));
          if (tries.every((r) => r && r.how !== 'thickened')) for (const r of tries) made.push(r!);
          else for (const r of tries) r?.solid.delete();
        }
      }
      if (!made.length) {
        const v = voxelSolid(o, partOf(P, T0, sel, src), sheet);
        if (v) made.push({ how: 'rebuilt', solid: v }); else count.dropped++;
      }
    }
    for (const m of made) { count[m.how]++; solids.push(m.solid); }
    if (pi % 16 === 15) await idle();
  }
  if (!solids.length) throw new Error("None of the model's parts could be made solid.");
  progress?.(0.95, 'Joining the parts into one solid');
  const solid = solids.length > 1 ? o.m.Manifold.union(solids) : solids[0];
  if (solids.length > 1) for (const s of solids) s.delete();
  const notes: string[] = [];
  if (count.filled) notes.push(`${plural(count.filled, 'part')} had openings, closed flat.`);
  if (count.thickened) notes.push(`${plural(count.thickened, 'open surface')} thickened to ${sheet} mm.`);
  if (count.rebuilt) notes.push(`${plural(count.rebuilt, 'broken part')} rebuilt from voxels, with less detail.`);
  if (count.dropped) notes.push(`${plural(count.dropped, 'part')} couldn't be made solid and ${count.dropped === 1 ? 'was' : 'were'} left out.`);
  return { solid, notes, parts: solids.length };
}

const idle = () => new Promise((r) => setTimeout(r, 0));

/** The solid with every hollow sealed inside it filled: the solid, how many, and their volume. */
function fillHollows(o: Origins, s: Manifold): { solid: Manifold; hollows: number; volume: number } {
  const { mesh, source } = o.read(s);
  const labels = cornerParts(mesh.triangles, mesh.positions.length / 3);
  const shells = new Map<number, number[]>();
  for (let f = 0; f < labels.length; f++) { let g = shells.get(labels[f]); if (!g) shells.set(labels[f], (g = [])); g.push(f); }
  let inner = 0;
  const outer: Manifold[] = [];
  for (const faces of shells.values()) {
    const p = partOf(mesh.positions, mesh.triangles, faces, source);
    // a hollow inside the solid is bounded by a surface facing inwards: its volume is negative
    if (signedVolume(p.P, p.T) < 0) { inner++; continue; }
    const m = o.solid(p.P, p.T, p.src);
    if (m) outer.push(m);
  }
  if (!inner || !outer.length) { for (const m of outer) m.delete(); return { solid: s, hollows: 0, volume: 0 }; }
  const filled = outer.length > 1 ? o.m.Manifold.union(outer) : outer[0];
  if (outer.length > 1) for (const m of outer) m.delete();
  const volume = Math.max(0, filled.volume() - s.volume());
  s.delete();
  return { solid: filled, hollows: inner, volume };
}

/** The cell size gaps up to `gap` mm are closed on for a model `span` mm big, or null when it is too big for gaps that narrow. */
export function gapCell(span: number[], gap: number): number | null {
  const sp = span.map((x) => Math.max(x, 1e-6));
  let h = gap / 4;
  if (sp.reduce((a, x) => a * (x / h + 1), 1) > MAX_CELLS) h = Math.cbrt((sp[0] * sp[1] * sp[2]) / MAX_CELLS);
  return h <= gap / 2 ? h : null;
}

/** The narrowest gaps that can be closed on a model `span` mm big, in mm. */
export function narrowestGap(span: number[]): number {
  const sp = span.map((x) => Math.max(x, 1e-6));
  return Math.ceil(2 * Math.cbrt((sp[0] * sp[1] * sp[2]) / MAX_CELLS) * 10) / 10;
}

/** The solid as cells of size `h`: a cell is set where its middle is inside (each layer the solid's cross-section through the cells' middles). */
function occupancy(s: Manifold, h: number, pad: number): { g: Grid; origin: number[] } {
  const bb = s.boundingBox();
  const lo = [...bb.min], hi = [...bb.max];
  const origin = lo.map((x) => x - pad * h);
  const shape = [0, 1, 2].map((d) => Math.ceil((hi[d] - lo[d]) / h) + 2 * pad + 1);
  const g = grid(shape[0], shape[1], shape[2]);
  const xs: number[] = [];
  for (let k = 0; k < g.nz; k++) {
    const z = origin[2] + (k + 0.5) * h;
    if (z <= lo[2] || z >= hi[2]) continue;
    const cs = s.slice(z);
    const polys = cs.toPolygons();
    cs.delete();
    for (let j = 0; j < g.ny; j++) {
      const y = origin[1] + (j + 0.5) * h;
      xs.length = 0;
      for (const poly of polys) {
        for (let e = 0; e < poly.length; e++) {
          const [x0, y0] = poly[e], [x1, y1] = poly[(e + 1) % poly.length];
          if ((y0 > y) !== (y1 > y)) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      // even-odd across all the outlines: holes stay holes
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - origin[0]) / h - 0.5));
        const i1 = Math.min(g.nx - 1, Math.floor((xs[q + 1] - origin[0]) / h - 0.5));
        for (let i = i0; i <= i1; i++) g.data[(i * g.ny + j) * g.nz + k] = 1;
      }
    }
  }
  return { g, origin };
}

/** The solid with gaps up to `gap` mm wide bridged: the solid, the volume added, and a note when it could not be done. */
async function closeGaps(o: Origins, s: Manifold, gap: number, progress?: Progress): Promise<{ solid: Manifold; volume: number; note: string | null }> {
  const bb = s.boundingBox();
  const span = [0, 1, 2].map((d) => bb.max[d] - bb.min[d]);
  const h = gapCell(span, gap);
  if (h === null) {
    return { solid: s, volume: 0, note: `Gaps weren't closed: the model is too big (${Math.round(Math.max(...span))} mm) to find gaps ${gap} mm wide. Gaps from ${narrowestGap(span)} mm can be closed on it.` };
  }
  const r = Math.max(1, Math.ceil(gap / 2 / h));
  progress?.(0.1, 'Wrapping the model in voxels');
  await idle();
  const { g, origin } = occupancy(s, h, r + 4);
  progress?.(0.3, 'Finding the gaps');
  await idle();
  const closed = fillHoles(erodeBall(dilateBall(g, r), r));
  const gaps = grid(g.nx, g.ny, g.nz);
  let any = false;
  for (let c = 0; c < g.data.length; c++) if (closed.data[c] && !g.data[c]) { gaps.data[c] = 1; any = true; }
  if (!any) return { solid: s, volume: 0, note: null };
  // the bridges: the gaps grown into the model on either side, so they are thick enough to hold on, but kept
  // two cells under the outside the closing makes, so they only show in a gap
  const grown = stepCross(gaps, 3), inner = stepCross(closed, 2, true);
  const bridge = grid(g.nx, g.ny, g.nz);
  for (let c = 0; c < g.data.length; c++) bridge.data[c] = grown.data[c] && inner.data[c] ? 1 : 0;
  const found = blobs(bridge);
  const made: Manifold[] = [];
  for (let n = 0; n < found.length; n++) {
    if (progress && n % 8 === 0) { progress(0.45 + (0.4 * n) / found.length, `Bridging the gaps: ${n + 1} of ${found.length}`); await idle(); }
    const b = found[n];
    const lo = b.lo.map((x) => Math.max(0, x - 2)), hi = b.hi.map((x, d) => Math.min(x + 3, [g.nx, g.ny, g.nz][d]));
    const sx = hi[0] - lo[0], sy = hi[1] - lo[1], sz = hi[2] - lo[2];
    const local = new Float32Array(sx * sy * sz);
    for (const c of b.cells) {
      const k = c % g.nz, j = ((c - k) / g.nz) % g.ny, i = Math.floor(c / (g.ny * g.nz));
      local[((i - lo[0]) * sy + (j - lo[1])) * sz + (k - lo[2])] = 1;
    }
    const field = blur(local, sx, sy, sz, 0.7);
    const at = lo.map((x, d) => origin[d] + x * h);
    const blob = o.m.Manifold.levelSet(fieldSdf(field, sx, sy, sz, at, h),
      { min: at.map((x) => x - h) as [number, number, number], max: at.map((x, d) => x + ([sx, sy, sz][d] + 1) * h) as [number, number, number] }, h);
    // only bridges that hold on to the model (a stray speck of the grid isn't one)
    let keep = false;
    if (blob.status() === 'NoError' && !blob.isEmpty()) {
      const meet = o.m.Manifold.intersection(blob, s);
      keep = meet.volume() > 0;
      meet.delete();
    }
    if (keep) made.push(o.smooth(blob, h * 0.1)); else blob.delete();
  }
  if (!made.length) return { solid: s, volume: 0, note: null };
  progress?.(0.88, 'Joining the bridges to the model');
  const out = o.m.Manifold.union([s, ...made]);
  const volume = Math.max(0, out.volume() - s.volume());
  for (const m of made) m.delete();
  s.delete();
  return { solid: out, volume, note: null };
}

/** The solid without separate bits smaller than `percent` of the biggest: the solid and how many went. */
function removeLoose(o: Origins, s: Manifold, percent: number): { solid: Manifold; removed: number } {
  const parts = s.decompose();
  if (parts.length < 2 || percent <= 0) { for (const p of parts) p.delete(); return { solid: s, removed: 0 }; }
  const vols = parts.map((p) => p.volume());
  const least = (Math.max(...vols) * percent) / 100;
  const kept = parts.filter((_, i) => vols[i] >= least);
  if (kept.length === parts.length) { for (const p of parts) p.delete(); return { solid: s, removed: 0 }; }
  const out = kept.length > 1 ? o.m.Manifold.compose(kept) : kept[0];
  for (const p of parts) if (p !== out) p.delete();
  s.delete();
  return { solid: out, removed: parts.length - kept.length };
}

/**
 * A base under the solid: round or square, round its feet (what of it is in
 * the lowest tenth of its height, seen from above) with the margin, the model
 * sunk SINK into it so what nearly touches the plate joins on too.
 */
function addBase(o: Origins, s: Manifold, settings: FinishSettings): { solid: Manifold; note: string } {
  const bb = s.boundingBox();
  const z0 = bb.min[2];
  const low = s.trimByPlane([0, 0, -1], -(z0 + Math.max(0.5, (bb.max[2] - z0) * 0.1)));
  const shadow = low.project();
  const pts: number[][] = shadow.toPolygons().flat();
  shadow.delete(); low.delete();
  if (!pts.length) pts.push([bb.min[0], bb.min[1]], [bb.max[0], bb.max[1]]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const margin = Math.max(0, settings.baseMargin), height = Math.max(0.4, settings.baseHeight);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let shape: Manifold, note: string;
  if (settings.base === 'round') {
    let r = 0;
    for (const [x, y] of pts) r = Math.max(r, Math.hypot(x - cx, y - cy));
    r += margin;
    const segments = Math.max(48, Math.min(256, Math.round((2 * Math.PI * r) / 0.6)));
    shape = o.m.Manifold.cylinder(height + SINK, r, r, segments).translate([cx, cy, z0 - height]);
    note = `A round base ${(2 * r).toFixed(1)} mm across and ${height} mm thick added under it.`;
  } else {
    const w = x1 - x0 + 2 * margin, d = y1 - y0 + 2 * margin;
    shape = o.m.Manifold.cube([w, d, height + SINK]).translate([x0 - margin, y0 - margin, z0 - height]);
    note = `A square base ${w.toFixed(1)} × ${d.toFixed(1)} mm and ${height} mm thick added under it.`;
  }
  // the base's own triangles say they are the base
  const g = shape.getMesh();
  shape.delete();
  const base = o.solid(g.numProp === 3 ? g.vertProperties : positionsOf(g), g.triVerts, BASE);
  if (!base) return { solid: s, note: "The base couldn't be made." };
  const out = o.m.Manifold.union(s, base);
  s.delete(); base.delete();
  return { solid: out, note };
}

const cm3 = (mm3: number) => { const c = mm3 / 1000; return c >= 100 ? Math.round(c).toLocaleString('en') : c.toPrecision(3).replace(/\.?0+$/, ''); };

/** The model as one watertight solid with nothing inside it. See the notes at the top. */
export async function makeWatertight(mesh: IndexedMesh, groups: ArrayLike<number> | null, settings: Partial<FinishSettings> = {}, progress?: Progress): Promise<Finished> {
  const s = { ...FINISH_DEFAULTS, ...settings };
  const m = await manifold();
  const o = new Origins(m);
  const gaps = s.closeGaps > 0;
  const sub = (lo: number, hi: number): Progress | undefined => (progress ? (f, t) => progress(lo + (hi - lo) * f, t) : undefined);
  const made = await makeSolid(o, mesh, groups, s.sheet, sub(0, gaps ? 0.55 : 0.85));
  let solid = made.solid;
  const notes = made.notes.slice();
  if (made.parts > 1) notes.push(`${made.parts} parts joined into one; the surfaces inside one another removed.`);
  let hollows = 0;
  if (s.fillHollows) {
    progress?.(gaps ? 0.56 : 0.86, 'Filling hollows inside the model');
    await idle();
    const r = fillHollows(o, solid);
    solid = r.solid;
    hollows = r.hollows;
    if (r.hollows) notes.push(`${plural(r.hollows, 'hollow')} sealed inside the model filled (${cm3(r.volume)} cm³).`);
  }
  let gapVolume = 0;
  if (gaps) {
    const r = await closeGaps(o, solid, s.closeGaps, sub(0.6, 0.95));
    solid = r.solid;
    gapVolume = r.volume;
    if (r.note) notes.push(r.note);
    else if (r.volume > 0) notes.push(`Gaps up to ${s.closeGaps} mm wide closed (${cm3(r.volume)} cm³ added).`);
    else notes.push(`No gaps up to ${s.closeGaps} mm wide were found.`);
    if (s.fillHollows) {
      // bridging seals off pockets (and specks of space where a bridge meets the surface)
      const f = fillHollows(o, solid);
      solid = f.solid;
      hollows += f.hollows;
    }
  }
  let looseRemoved = 0;
  if (s.loose > 0) {
    const r = removeLoose(o, solid, s.loose);
    solid = r.solid;
    looseRemoved = r.removed;
    if (r.removed) notes.push(`${plural(r.removed, 'loose bit')} smaller than ${s.loose}% of the model removed.`);
  }
  if (s.flatten > 0) {
    const bb = solid.boundingBox();
    if (s.flatten >= bb.max[2] - bb.min[2]) throw new Error(`Cutting ${s.flatten} mm off the bottom would leave nothing: the model is ${(bb.max[2] - bb.min[2]).toFixed(1)} mm tall.`);
    const cut = solid.trimByPlane([0, 0, 1], bb.min[2] + s.flatten);
    solid.delete();
    solid = cut;
    notes.push(`The bottom ${s.flatten} mm cut off, so it stands on a flat face.`);
  }
  if (s.base !== 'none') {
    const r = addBase(o, solid, s);
    solid = r.solid;
    notes.push(r.note);
  }
  const pieces = solid.decompose();
  const shells = pieces.length;
  for (const p of pieces) p.delete();
  if (shells > 1) notes.push(`${shells} separate pieces don't touch the rest; each is watertight.`);
  progress?.(0.98, 'Done');
  const { mesh: out, source } = o.read(solid);
  const volume = solid.volume();
  solid.delete();
  return { mesh: out, source, notes, volume, shells, hollows, gapVolume, looseRemoved };
}

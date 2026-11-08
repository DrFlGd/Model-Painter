// Painting a model from its colour textures for multi-colour printing: a
// port of Dark STL's paint.py (DrFlGd/Dark-STL, src/darkstl/paint.py).
//
// A slicer with several filaments prints a model in colours from paint on its
// triangles, kept per triangle as a small tree: the triangle is split at its
// edge midpoints, the pieces again, and so on, and every leaf names a
// filament. A colour border can therefore run anywhere across a triangle
// without adding geometry, which is what makes a model painted from a
// texture look like the texture rather than like its triangles.
//
// 1. The textures are reduced to a palette of a few colours (a slicer holds 4
//    to 16 filaments), chosen by k-means in Oklab over the texels the
//    model's surface really covers, weighted by the area each covers
//    (`suggestPalette`), or given. Only flat texels (whose neighbours share
//    their colour) are learned from when there are enough, so the blend along
//    an edge between two colours never takes a filament of its own.
// 2. Each texture is reduced to the palette (`reduce`) and cleaned of specks
//    that would print as single dots of filament.
// 3. Every triangle is sampled over the reduced texture; one that is not all
//    one colour is split, and so on, until each piece is one colour, is
//    smaller than the feature size, or the depth limit is reached. Only the
//    sides longer than the feature size are split, as the slicers' brushes
//    do, so a thin sliver halves along its length.
// 4. Each tree is written as the slicers' code (paint-tree.ts).
//
// The settings follow the Prepare image dialog's (colours, keep or drop each
// colour, smoothing, specks, exposure, contrast, saturation), plus Dark STL's
// colour tolerance and smallest share. The mesh is in millimetres at print
// size, so the feature size is in millimetres too. Pure: runs in the worker.

import type { IndexedMesh } from './mesh.ts';
import { CUBE_CELLS, cube, cubeKey, oklab, parseHex, type RGB } from './colour.ts';
import { CodeWriter, codeMajority } from './paint-tree.ts';

export const MAX_COLOURS = 16;
/** textures are read at most this big: a 0.5 mm feature on a 150 mm print is 300 texels */
export const MAX_TEXTURE = 2048;
/** pieces of paint above which the slicer is warned to be slow */
export const MANY_LEAVES = 3_000_000;
const FLAT_DISTANCE = 0.04; // Oklab distance under which neighbouring texels count as one flat colour
const FLAT_SHARE = 0.25; // the palette is learned from flat texels when they cover at least this share of the surface
const LATTICE = [1, 2, 3, 4, 6, 8, 11, 16]; // sample lattices per piece: n * n points
const PALETTE_LATTICE = [1, 2, 3, 4, 6, 8, 11, 16, 23, 32, 45, 64, 90, 128];
const PALETTE_SAMPLES = 8_000_000; // samples per texture for the palette at most

/** An RGBA picture, rows from the top. */
export interface Picture { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

/** What a material is painted from. */
export type ColourSource =
  /** its texture, times `tint` (glTF's base colour factor) when given */
  | { kind: 'texture'; picture: Picture; tint?: RGB }
  /** one flat colour (a material with no texture, or its texture left out) */
  | { kind: 'colour'; rgb: RGB }
  /** the model's vertex colours */
  | { kind: 'vertex' }
  /** not painted: the first colour */
  | { kind: 'none' };

export interface PaintInput {
  mesh: IndexedMesh;
  /** UV of each triangle corner, 6 per triangle, V down the picture */
  uvs: Float32Array | null;
  faceMaterial: ArrayLike<number>;
  /** RGB of each triangle corner, 9 per triangle */
  vertexColours?: Uint8Array | null;
  /** material → what it is painted from (missing: not painted) */
  sources: Map<number, ColourSource>;
}

export interface TextureSettings {
  /** palette size when the palette is chosen from the textures */
  colours: number;
  /** "#rrggbb" per colour, as the user set them; null = chosen from the textures */
  palette: string[] | null;
  /** suggested colours (by their place in the suggestion) left out: their texels take the nearest colour kept */
  drop: number[];
  /** suggested colours closer than this (Oklab distance × 100) are merged into one */
  tolerance: number;
  /** % of the surface: suggested colours covering less are left out */
  minShare: number;
  /** stops of light, −2..2 */
  exposure: number;
  /** −1..1 */
  contrast: number;
  /** −1 (grey) .. 1 */
  saturation: number;
  /** passes of a 3 × 3 majority filter over the reduced textures, 0..3 */
  smoothing: number;
  /** patches of one colour smaller than this many texels take the colour round them */
  speck: number;
  /** smallest colour feature kept, mm */
  feature: number;
  /** levels of splits of a triangle */
  maxDepth: number;
}

export const DEFAULT_SETTINGS: TextureSettings = {
  colours: 4, palette: null, drop: [], tolerance: 0, minShare: 0,
  exposure: 0, contrast: 0, saturation: 0, smoothing: 1, speck: 4, feature: 0.5, maxDepth: 12,
};

export interface Suggestion {
  /** the suggested colours, most used first */
  palette: RGB[];
  /** share of the surface each takes */
  coverage: number[];
}

export interface PaintResult {
  palette: RGB[];
  /** share of the surface each colour takes */
  coverage: number[];
  /** colour of each triangle (for a split one, the colour covering most of it) */
  faceMaterial: Uint8Array;
  /** slicer code of each split triangle (state = colour + 1); whole triangles have none */
  codes: Map<number, string>;
  splitFaces: number;
  leaves: number;
  depth: number;
  unpainted: number;
  notes: string[];
}

export type Progress = (fraction: number, message: string) => void;

// ---------------------------------------------------------------------------
// colours

/** The colour cube as the settings' exposure, contrast and saturation change it (Prepare image's `adjust`, folded into the cube's colours). */
function adjustedCube(s: TextureSettings): { rgb: Float32Array; lab: Float32Array } {
  const ex = 2 ** s.exposure, ct = 1 + s.contrast, sat = 1 + s.saturation;
  if (ex === 1 && ct === 1 && sat === 1) return cube();
  const id = `${ex.toFixed(4)}|${ct.toFixed(4)}|${sat.toFixed(4)}`;
  let hit = exCache.get(id);
  if (hit) return hit;
  const base = cube();
  const rgb = new Float32Array(CUBE_CELLS * 3), lab = new Float32Array(CUBE_CELLS * 3);
  for (let c = 0; c < CUBE_CELLS; c++) {
    let r = base.rgb[c * 3], g = base.rgb[c * 3 + 1], b = base.rgb[c * 3 + 2];
    r = Math.min(1, Math.max(0, (r * ex - 0.5) * ct + 0.5));
    g = Math.min(1, Math.max(0, (g * ex - 0.5) * ct + 0.5));
    b = Math.min(1, Math.max(0, (b * ex - 0.5) * ct + 0.5));
    if (sat !== 1) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = Math.min(1, Math.max(0, y + (r - y) * sat)); g = Math.min(1, Math.max(0, y + (g - y) * sat)); b = Math.min(1, Math.max(0, y + (b - y) * sat));
    }
    rgb[c * 3] = r; rgb[c * 3 + 1] = g; rgb[c * 3 + 2] = b;
    oklab(r, g, b, lab, c * 3);
  }
  hit = { rgb, lab };
  if (exCache.size > 6) exCache.delete(exCache.keys().next().value!);
  exCache.set(id, hit);
  return hit;
}
const exCache = new Map<string, { rgb: Float32Array; lab: Float32Array }>();

/** The nearest palette colour of every cube cell, after the settings' adjustments. */
function lutFor(palette: RGB[], s: TextureSettings): Uint8Array {
  const { lab } = adjustedCube(s);
  const k = palette.length;
  const plab = new Float32Array(k * 3);
  palette.forEach((c, i) => oklab(c[0] / 255, c[1] / 255, c[2] / 255, plab, i * 3));
  const lut = new Uint8Array(CUBE_CELLS);
  for (let c = 0; c < CUBE_CELLS; c++) {
    const L = lab[c * 3], A = lab[c * 3 + 1], B = lab[c * 3 + 2];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < k; i++) {
      const d = (L - plab[i * 3]) ** 2 + (A - plab[i * 3 + 1]) ** 2 + (B - plab[i * 3 + 2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    lut[c] = best;
  }
  return lut;
}

// ---------------------------------------------------------------------------
// pictures

/** Averages a picture down by a whole factor so its longer side is at most `max`. */
export function shrink(p: Picture, max = MAX_TEXTURE): Picture {
  const f = Math.ceil(Math.max(p.width, p.height) / max);
  if (f <= 1) return p;
  const w = Math.floor(p.width / f), h = Math.floor(p.height / f);
  const out = new Uint8Array(w * h * 4);
  const n = f * f;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < f; dy++) {
      let i = ((y * f + dy) * p.width + x * f) * 4;
      for (let dx = 0; dx < f; dx++, i += 4) { r += p.data[i]; g += p.data[i + 1]; b += p.data[i + 2]; a += p.data[i + 3]; }
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  return { width: w, height: h, data: out };
}

/** The cube cell of every texel (times the tint). */
function texelKeys(p: Picture, tint?: RGB): Int32Array {
  const n = p.width * p.height, out = new Int32Array(n), d = p.data;
  const tr = tint ? tint[0] / 255 : 1, tg = tint ? tint[1] / 255 : 1, tb = tint ? tint[2] / 255 : 1;
  for (let i = 0; i < n; i++) out[i] = cubeKey((d[i * 4] * tr) | 0, (d[i * 4 + 1] * tg) | 0, (d[i * 4 + 2] * tb) | 0);
  return out;
}

/** Whether each texel's four neighbours (wrapping) all lie within FLAT_DISTANCE of it in Oklab. */
function flatTexels(keys: Int32Array, w: number, h: number, lab: Float32Array): Uint8Array {
  const flat = new Uint8Array(w * h).fill(1), lim = FLAT_DISTANCE * FLAT_DISTANCE;
  const close = (i: number, j: number) => {
    const a = keys[i] * 3, b = keys[j] * 3;
    return (lab[a] - lab[b]) ** 2 + (lab[a + 1] - lab[b + 1]) ** 2 + (lab[a + 2] - lab[b + 2]) ** 2 <= lim;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const right = y * w + ((x + 1) % w), down = ((y + 1) % h) * w + x;
    if (!close(i, right)) { flat[i] = 0; flat[right] = 0; }
    if (!close(i, down)) { flat[i] = 0; flat[down] = 0; }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// sampling

/** n * n corner weights spread evenly over a triangle (the centroids of its n-level regular split). */
function lattice(n: number): Float32Array {
  if (n === 1) return Float32Array.from([1 / 3, 1 / 3, 1 / 3]);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i + j <= n - 1) { const a = (i + 1 / 3) / n, b = (j + 1 / 3) / n; pts.push(a, b, 1 - a - b); }
    if (i + j <= n - 2) { const a = (i + 2 / 3) / n, b = (j + 2 / 3) / n; pts.push(a, b, 1 - a - b); }
  }
  return Float32Array.from(pts);
}
const lattices = new Map<number, Float32Array>();
const latticeOf = (n: number) => { let l = lattices.get(n); if (!l) lattices.set(n, (l = lattice(n))); return l; };

/** The lattice for a piece covering that many texels: about two samples per texel, 256 at most. */
function latticeFor(texelArea: number): number {
  const want = Math.ceil(Math.sqrt(Math.max(texelArea, 0) * 2));
  for (const n of LATTICE) if (want <= n) return n;
  return LATTICE[LATTICE.length - 1];
}

const wrap = (v: number) => v - Math.floor(v);

/** Faces of each painted material. */
function facesBySource(input: PaintInput): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const n = input.mesh.triangles.length / 3;
  for (let f = 0; f < n; f++) {
    const m = input.faceMaterial[f];
    const src = input.sources.get(m);
    if (!src || src.kind === 'none') continue;
    if (src.kind === 'texture' && !input.uvs) continue;
    if (src.kind === 'vertex' && !input.vertexColours) continue;
    let list = out.get(m);
    if (!list) out.set(m, (list = []));
    list.push(f);
  }
  return out;
}

function faceArea(P: Float32Array, T: Uint32Array, f: number): number {
  const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

// ---------------------------------------------------------------------------
// palette

/**
 * Weighted k-means with k-means++ seeding, the best (least spread) of a few
 * seedings so a small change to the model can't swing the palette; centres
 * (k × 3) sorted by the weight they hold.
 */
function kmeans(points: Float32Array, weights: Float64Array, k: number): Float32Array {
  let best: { centres: Float32Array; spread: number } | null = null;
  for (const seed of [7, 1013, 50021]) {
    const r = kmeansOnce(points, weights, k, 40, seed);
    if (!best || r.spread < best.spread - 1e-12) best = r;
  }
  return best!.centres;
}

function kmeansOnce(points: Float32Array, weights: Float64Array, k: number, iterations: number, seed: number): { centres: Float32Array; spread: number } {
  const n = weights.length;
  k = Math.min(k, n);
  let rng = seed >>> 0;
  const random = () => { rng = (rng + 0x6d2b79f5) >>> 0; let t = rng; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = weights[i] / total;
  const pick = (p: Float64Array) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += p[i];
    let r = random() * sum;
    for (let i = 0; i < n; i++) { r -= p[i]; if (r <= 0) return i; }
    return n - 1;
  };
  const centres = new Float32Array(k * 3);
  const first = pick(w);
  centres.set(points.subarray(first * 3, first * 3 + 3), 0);
  const d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) d2[i] = dist2(points, i, centres, 0);
  const p = new Float64Array(n);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) { p[i] = d2[i] * w[i]; sum += p[i]; }
    if (sum <= 0) { for (let j = c; j < k; j++) centres.copyWithin(j * 3, (c - 1) * 3, c * 3); break; }
    const at = pick(p);
    centres.set(points.subarray(at * 3, at * 3 + 3), c * 3);
    for (let i = 0; i < n; i++) d2[i] = Math.min(d2[i], dist2(points, i, centres, c));
  }
  const label = new Int32Array(n);
  const sums = new Float64Array(k * 3), held = new Float64Array(k);
  for (let it = 0; it < iterations; it++) {
    assign(points, centres, k, label);
    sums.fill(0); held.fill(0);
    for (let i = 0; i < n; i++) {
      const l = label[i];
      held[l] += w[i];
      sums[l * 3] += points[i * 3] * w[i]; sums[l * 3 + 1] += points[i * 3 + 1] * w[i]; sums[l * 3 + 2] += points[i * 3 + 2] * w[i];
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (held[c] <= 0) continue;
      for (let d = 0; d < 3; d++) {
        const v = sums[c * 3 + d] / held[c];
        moved = Math.max(moved, Math.abs(v - centres[c * 3 + d]));
        centres[c * 3 + d] = v;
      }
    }
    if (moved < 1e-6) break;
  }
  assign(points, centres, k, label);
  held.fill(0);
  let spread = 0;
  for (let i = 0; i < n; i++) { held[label[i]] += w[i]; spread += w[i] * dist2(points, i, centres, label[i]); }
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => held[b] - held[a] || a - b);
  const out = new Float32Array(k * 3);
  order.forEach((c, i) => out.set(centres.subarray(c * 3, c * 3 + 3), i * 3));
  return { centres: out, spread };
}

function dist2(a: Float32Array, i: number, b: Float32Array, j: number): number {
  return (a[i * 3] - b[j * 3]) ** 2 + (a[i * 3 + 1] - b[j * 3 + 1]) ** 2 + (a[i * 3 + 2] - b[j * 3 + 2]) ** 2;
}

function assign(points: Float32Array, centres: Float32Array, k: number, label: Int32Array) {
  const n = label.length;
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) { const d = dist2(points, i, centres, c); if (d < bd) { bd = d; best = c; } }
    label[i] = best;
  }
}

/**
 * Merges k-means centres closer than `tolerance` (Oklab distance): the less
 * used joins the more used, then the centres settle again over the colours,
 * until none are that close.
 */
function mergeClose(points: Float32Array, weights: Float64Array, centres: Float32Array, tolerance: number): Float32Array {
  const n = weights.length;
  const label = new Int32Array(n);
  for (let round = 0; round < 8; round++) {
    const k = centres.length / 3;
    assign(points, centres, k, label);
    const held = new Float64Array(k);
    for (let i = 0; i < n; i++) held[label[i]] += weights[i];
    const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => held[b] - held[a]);
    const kept: number[] = [];
    for (const i of order) {
      if (held[i] <= 0) continue;
      if (kept.every((j) => Math.sqrt(dist2(centres, i, centres, j)) >= tolerance)) kept.push(i);
    }
    if (kept.length === k) return centres;
    let next = new Float32Array(kept.length * 3);
    kept.forEach((c, i) => next.set(centres.subarray(c * 3, c * 3 + 3), i * 3));
    for (let it = 0; it < 10; it++) {
      const kk = next.length / 3;
      assign(points, next, kk, label);
      const sums = new Float64Array(kk * 3), hold = new Float64Array(kk);
      for (let i = 0; i < n; i++) {
        const l = label[i];
        hold[l] += weights[i];
        for (let d = 0; d < 3; d++) sums[l * 3 + d] += points[i * 3 + d] * weights[i];
      }
      const upd = new Float32Array(kk * 3);
      let moved = 0;
      for (let c = 0; c < kk; c++) for (let d = 0; d < 3; d++) {
        upd[c * 3 + d] = hold[c] > 0 ? sums[c * 3 + d] / hold[c] : next[c * 3 + d];
        moved = Math.max(moved, Math.abs(upd[c * 3 + d] - next[c * 3 + d]));
      }
      next = upd;
      if (moved < 1e-6) break;
    }
    centres = next;
  }
  return centres;
}

/** How much of the surface (by area) falls in each cube cell, all of it and its flat texels only. */
function surfaceHistogram(input: PaintInput, s: TextureSettings, progress?: Progress): { hist: Float64Array; flat: Float64Array } {
  const hist = new Float64Array(CUBE_CELLS), flatHist = new Float64Array(CUBE_CELLS);
  const { lab } = adjustedCube(s);
  const P = input.mesh.positions, T = input.mesh.triangles, UV = input.uvs;
  const groups = facesBySource(input);
  let done = 0;
  for (const [m, faces] of groups) {
    progress?.(0.02 + 0.18 * (done++ / groups.size), 'Reading the colours');
    const src = input.sources.get(m)!;
    if (src.kind === 'colour') {
      const k = cubeKey(src.rgb[0], src.rgb[1], src.rgb[2]);
      let a = 0;
      for (const f of faces) a += faceArea(P, T, f);
      hist[k] += a; flatHist[k] += a;
      continue;
    }
    if (src.kind === 'vertex') {
      const C = input.vertexColours!, L = latticeOf(2);
      for (const f of faces) {
        const a = faceArea(P, T, f) / 4;
        for (let i = 0; i < 4; i++) {
          const w0 = L[i * 3], w1 = L[i * 3 + 1], w2 = L[i * 3 + 2];
          const k = cubeKey(C[f * 9] * w0 + C[f * 9 + 3] * w1 + C[f * 9 + 6] * w2 | 0, C[f * 9 + 1] * w0 + C[f * 9 + 4] * w1 + C[f * 9 + 7] * w2 | 0, C[f * 9 + 2] * w0 + C[f * 9 + 5] * w1 + C[f * 9 + 8] * w2 | 0);
          hist[k] += a; flatHist[k] += a;
        }
      }
      continue;
    }
    if (src.kind !== 'texture' || !UV) continue;
    const pic = shrink(src.picture);
    const W = pic.width, H = pic.height;
    const keys = texelKeys(pic, src.tint);
    const flat = flatTexels(keys, W, H, lab);
    // about one sample per texel each triangle covers, within PALETTE_SAMPLES for the whole texture
    const want = new Float64Array(faces.length);
    let total = 0;
    faces.forEach((f, i) => {
      const ax = UV[f * 6] * W, ay = UV[f * 6 + 1] * H, bx = UV[f * 6 + 2] * W, by = UV[f * 6 + 3] * H, cx = UV[f * 6 + 4] * W, cy = UV[f * 6 + 5] * H;
      want[i] = Math.sqrt(Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2);
      total += Math.min(Math.ceil(want[i]), 128) ** 2;
    });
    const scale = total > PALETTE_SAMPLES ? Math.sqrt(PALETTE_SAMPLES / total) : 1;
    faces.forEach((f, i) => {
      const need = Math.ceil(want[i] * scale);
      let n = PALETTE_LATTICE[PALETTE_LATTICE.length - 1];
      for (const v of PALETTE_LATTICE) if (need <= v) { n = v; break; }
      const L = latticeOf(n), count = L.length / 3;
      const weight = faceArea(P, T, f) / count;
      const u0 = UV[f * 6], v0 = UV[f * 6 + 1], u1 = UV[f * 6 + 2], v1 = UV[f * 6 + 3], u2 = UV[f * 6 + 4], v2 = UV[f * 6 + 5];
      for (let j = 0; j < count; j++) {
        const a = L[j * 3], b = L[j * 3 + 1], c = L[j * 3 + 2];
        const x = Math.min(W - 1, (wrap(a * u0 + b * u1 + c * u2) * W) | 0);
        const y = Math.min(H - 1, (wrap(a * v0 + b * v1 + c * v2) * H) | 0);
        const t = y * W + x, k = keys[t];
        hist[k] += weight;
        if (flat[t]) flatHist[k] += weight;
      }
    });
  }
  return { hist, flat: flatHist };
}

/**
 * The colours that best stand for the model's textures over its surface:
 * k-means in Oklab over the texels the surface covers, each weighted by the
 * area it covers. Colours closer than the tolerance are merged and colours
 * covering less than the smallest share are left out, so there can be fewer
 * than asked for. Most used first.
 */
export function suggestPalette(input: PaintInput, settings: Partial<TextureSettings> = {}, progress?: Progress): Suggestion {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const colours = Math.min(Math.max(Math.round(s.colours), 1), MAX_COLOURS);
  const { hist, flat } = surfaceHistogram(input, s, progress);
  let sumAll = 0, sumFlat = 0, flatCells = 0;
  for (let c = 0; c < CUBE_CELLS; c++) { sumAll += hist[c]; sumFlat += flat[c]; if (flat[c] > 0) flatCells++; }
  if (sumAll <= 0) throw new Error('Nothing on this model has a colour to paint from: give its materials a texture or a colour.');
  // learn from the flat texels when there are enough of them (a noisy texture has few, and then all count)
  const learn = sumFlat >= FLAT_SHARE * sumAll && flatCells >= colours ? flat : hist;
  const { rgb, lab } = adjustedCube(s);
  const used: number[] = [];
  for (let c = 0; c < CUBE_CELLS; c++) if (learn[c] > 0) used.push(c);
  const pts = new Float32Array(used.length * 3), wts = new Float64Array(used.length);
  used.forEach((c, i) => { pts.set(lab.subarray(c * 3, c * 3 + 3), i * 3); wts[i] = learn[c]; });
  progress?.(0.2, 'Choosing the colours');
  let centres = kmeans(pts, wts, colours);
  if (s.tolerance > 0 && centres.length > 3) centres = mergeClose(pts, wts, centres, s.tolerance / 100);
  // each centre becomes the real texel colour nearest it, so the palette holds colours that are in the model
  const k = centres.length / 3;
  let palette: RGB[] = [];
  for (let c = 0; c < k; c++) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < used.length; i++) { const d = dist2(pts, i, centres, c); if (d < bd) { bd = d; best = i; } }
    const cell = used[best];
    palette.push([Math.round(rgb[cell * 3] * 255), Math.round(rgb[cell * 3 + 1] * 255), Math.round(rgb[cell * 3 + 2] * 255)]);
  }
  palette = palette.filter((c, i) => palette.findIndex((d) => d[0] === c[0] && d[1] === c[1] && d[2] === c[2]) === i);
  // the share of the surface each colour takes counts every texel, flat or not
  const shares = (pal: RGB[]) => {
    const cov = new Float64Array(pal.length);
    const plab = new Float32Array(pal.length * 3);
    pal.forEach((c, i) => oklab(c[0] / 255, c[1] / 255, c[2] / 255, plab, i * 3));
    let sum = 0;
    for (let c = 0; c < CUBE_CELLS; c++) {
      if (!(hist[c] > 0)) continue;
      let best = 0, bd = Infinity;
      for (let i = 0; i < pal.length; i++) {
        const d = (lab[c * 3] - plab[i * 3]) ** 2 + (lab[c * 3 + 1] - plab[i * 3 + 1]) ** 2 + (lab[c * 3 + 2] - plab[i * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cov[best] += hist[c]; sum += hist[c];
    }
    return Array.from(cov, (v) => v / Math.max(sum, 1e-12));
  };
  let coverage = shares(palette);
  const least = s.minShare / 100;
  while (least > 0 && palette.length > 1 && Math.min(...coverage) < least) {
    palette.splice(coverage.indexOf(Math.min(...coverage)), 1); // its texels go to the nearest colour left
    coverage = shares(palette);
  }
  const order = palette.map((_, i) => i).sort((a, b) => coverage[b] - coverage[a] || a - b);
  return { palette: order.map((i) => palette[i]), coverage: order.map((i) => coverage[i]) };
}

/** The palette the settings paint with: theirs, or the suggestion without the colours left out. */
export function chosenPalette(s: TextureSettings, suggestion: Suggestion | null): RGB[] {
  if (s.palette && s.palette.length) return s.palette.slice(0, MAX_COLOURS).map(parseHex);
  if (!suggestion) throw new Error('No colours to paint with');
  const drop = new Set(s.drop);
  const kept = suggestion.palette.filter((_, i) => !drop.has(i));
  return kept.length ? kept : suggestion.palette.slice(0, 1);
}

// ---------------------------------------------------------------------------
// reducing the textures

/**
 * Every texel's nearest palette colour (Oklab), after the adjustments, then
 * cleaned: smoothing passes of a 3 × 3 majority filter and patches smaller
 * than the speck size merged into the colour round them (the texture
 * repeats, so both wrap round its edges). Returns the colour index per texel.
 */
export function reduce(pic: Picture, palette: RGB[], s: TextureSettings, tint?: RGB, lut?: Uint8Array): Uint8Array {
  lut ??= lutFor(palette, s);
  const keys = texelKeys(pic, tint);
  const out = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i++) out[i] = lut[keys[i]];
  return clean(out, pic.width, pic.height, palette.length, s.smoothing, s.speck);
}

/** Smoothing and speck removal over a map of colour indices, wrapping round its edges. */
export function clean(labels: Uint8Array, w: number, h: number, k: number, passes: number, speck: number): Uint8Array {
  let cur = labels;
  const votes = new Int32Array(k);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      const ym = ((y + h - 1) % h) * w, y0 = y * w, yp = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) {
        const xm = (x + w - 1) % w, xp = (x + 1) % w;
        votes.fill(0);
        votes[cur[ym + xm]]++; votes[cur[ym + x]]++; votes[cur[ym + xp]]++;
        votes[cur[y0 + xm]]++; votes[cur[y0 + x]]++; votes[cur[y0 + xp]]++;
        votes[cur[yp + xm]]++; votes[cur[yp + x]]++; votes[cur[yp + xp]]++;
        const own = cur[y0 + x];
        let best = own, bv = votes[own];
        for (let c = 0; c < k; c++) if (votes[c] > bv) { bv = votes[c]; best = c; }
        if (bv >= 5) next[y0 + x] = best;
      }
    }
    cur = next;
  }
  if (speck > 1) {
    const comp = new Int32Array(w * h).fill(-1);
    const stack: number[] = [], members: number[] = [];
    const border = new Int32Array(k);
    let id = 0;
    for (let s0 = 0; s0 < w * h; s0++) {
      if (comp[s0] >= 0) continue;
      const lab = cur[s0];
      members.length = 0;
      border.fill(0);
      comp[s0] = id;
      stack.push(s0);
      while (stack.length) {
        const p = stack.pop()!;
        members.push(p);
        const x = p % w, y = (p - x) / w;
        const ns = [y * w + ((x + w - 1) % w), y * w + ((x + 1) % w), ((y + h - 1) % h) * w + x, ((y + 1) % h) * w + x];
        for (const n of ns) {
          if (cur[n] === lab) { if (comp[n] < 0) { comp[n] = id; stack.push(n); } }
          else border[cur[n]]++;
        }
        if (members.length >= speck) {
          // big enough: finish marking it without counting more
          while (stack.length) {
            const q = stack.pop()!;
            const qx = q % w, qy = (q - qx) / w;
            for (const n of [qy * w + ((qx + w - 1) % w), qy * w + ((qx + 1) % w), ((qy + h - 1) % h) * w + qx, ((qy + 1) % h) * w + qx]) {
              if (cur[n] === lab && comp[n] < 0) { comp[n] = id; stack.push(n); }
            }
          }
          members.length = speck; // marks it as kept
        }
      }
      if (members.length < speck) {
        let to = -1, most = 0;
        for (let c = 0; c < k; c++) if (border[c] > most) { most = border[c]; to = c; }
        if (to >= 0) for (const p of members) cur[p] = to;
      }
      id++;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// painting

/** Paints every triangle from its material's colours, reduced to the palette the settings ask for. */
export function paintModel(input: PaintInput, settings: Partial<TextureSettings> = {}, suggestion: Suggestion | null = null, progress?: Progress): PaintResult {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const groups = facesBySource(input);
  if (!groups.size) throw new Error('Nothing on this model has a colour to paint from: give its materials a texture or a colour.');
  if (!s.palette?.length && !suggestion) suggestion = suggestPalette(input, s, progress);
  const palette = chosenPalette(s, suggestion);
  const k = palette.length;
  const lut = lutFor(palette, s);
  const P = input.mesh.positions, T = input.mesh.triangles, UV = input.uvs;
  const n = T.length / 3;
  const faceMaterial = new Uint8Array(n);
  const codes = new Map<number, string>();
  const held = new Float64Array(k);
  const counts = new Int32Array(k);
  const writer = new CodeWriter();
  const feature2 = s.feature * s.feature;
  let splitFaces = 0, leaves = 0, deepest = 0, done = 0;
  const MAXD = 40;
  const share = new Float64Array(MAXD);
  // corners of the piece at each depth, as weights of the triangle's corners (9 per depth)
  const W = new Float64Array(MAXD * 9);
  // each depth's children corners (up to four children, 9 each) and its a, b, c, ab, bc, ca
  const KIDS = new Float64Array(MAXD * 36), PTS = new Float64Array(MAXD * 18);
  const LAYOUT = [[], [[0, 1, 4], [4, 2, 0]], [[0, 3, 5], [3, 1, 5], [1, 2, 5]], [[0, 3, 5], [3, 1, 4], [4, 2, 5], [3, 4, 5]]];
  const SHARES = [[], [0.5, 0.5], [0.25, 0.25, 0.5], [0.25, 0.25, 0.25, 0.25]];
  const xyz = new Float64Array(9);
  const C = input.vertexColours;
  // the triangle being painted
  let index: Uint8Array | null = null, tw = 1, th = 1;
  let ax = 0, bx = 0, cx = 0, u0 = 0, v0 = 0, u1 = 0, v1 = 0, u2 = 0, v2 = 0, face = 0, area = 0, first = -1, mixed = false;
  // what sampling a piece found
  let sColour = 0, sWrong = 0, sBig = false;
  const sample = (o: number) => {
    const pu0 = W[o] * u0 + W[o + 1] * u1 + W[o + 2] * u2, pv0 = W[o] * v0 + W[o + 1] * v1 + W[o + 2] * v2;
    const pu1 = W[o + 3] * u0 + W[o + 4] * u1 + W[o + 5] * u2, pv1 = W[o + 3] * v0 + W[o + 4] * v1 + W[o + 5] * v2;
    const pu2 = W[o + 6] * u0 + W[o + 7] * u1 + W[o + 8] * u2, pv2 = W[o + 6] * v0 + W[o + 7] * v1 + W[o + 8] * v2;
    const nl = index ? latticeFor(Math.abs((pu1 - pu0) * (pv2 - pv0) - (pu2 - pu0) * (pv1 - pv0)) * tw * th / 2) : 4;
    const L = latticeOf(nl), cnt = L.length / 3;
    counts.fill(0);
    for (let j = 0; j < cnt; j++) {
      const wa = L[j * 3], wb = L[j * 3 + 1], wc = L[j * 3 + 2];
      if (index) {
        const x = Math.min(tw - 1, (wrap(wa * pu0 + wb * pu1 + wc * pu2) * tw) | 0);
        const y = Math.min(th - 1, (wrap(wa * pv0 + wb * pv1 + wc * pv2) * th) | 0);
        counts[index[y * tw + x]]++;
      } else {
        // vertex colours: the sample's weights of the triangle's corners
        const r0 = wa * W[o] + wb * W[o + 3] + wc * W[o + 6], r1 = wa * W[o + 1] + wb * W[o + 4] + wc * W[o + 7], r2 = wa * W[o + 2] + wb * W[o + 5] + wc * W[o + 8];
        const q = face * 9;
        counts[lut[cubeKey(C![q] * r0 + C![q + 3] * r1 + C![q + 6] * r2 | 0, C![q + 1] * r0 + C![q + 4] * r1 + C![q + 7] * r2 | 0, C![q + 2] * r0 + C![q + 5] * r1 + C![q + 8] * r2 | 0)]]++;
      }
    }
    let best = 0;
    for (let i = 1; i < k; i++) if (counts[i] > counts[best]) best = i;
    sColour = best; sWrong = cnt - counts[best]; sBig = nl > 1 || !index;
  };
  const visit = (d: number): void => {
    const o = d * 9;
    sample(o);
    const colour = sColour;
    for (let q = 0; q < 3; q++) for (let e = 0; e < 3; e++) xyz[q * 3 + e] = W[o + q * 3] * P[ax + e] + W[o + q * 3 + 1] * P[bx + e] + W[o + q * 3 + 2] * P[cx + e];
    const l0 = (xyz[3] - xyz[0]) ** 2 + (xyz[4] - xyz[1]) ** 2 + (xyz[5] - xyz[2]) ** 2 >= feature2;
    const l1 = (xyz[6] - xyz[3]) ** 2 + (xyz[7] - xyz[4]) ** 2 + (xyz[8] - xyz[5]) ** 2 >= feature2;
    const l2 = (xyz[0] - xyz[6]) ** 2 + (xyz[1] - xyz[7]) ** 2 + (xyz[2] - xyz[8]) ** 2 >= feature2;
    const sides = (l0 ? 1 : 0) + (l1 ? 1 : 0) + (l2 ? 1 : 0);
    if (!(sWrong > 0 && sBig && sides > 0 && d < s.maxDepth && d < MAXD - 1)) {
      writer.leaf(colour + 1);
      held[colour] += area * share[d];
      leaves++;
      if (first < 0) first = colour; else if (colour !== first) mixed = true;
      if (d > deepest) deepest = d;
      return;
    }
    // the special side, numbered as the slicers number sides (side i lies opposite corner i): for one side the side
    // split, for two the side kept; three always have special side 0
    const special = sides === 1 ? (l0 ? 2 : l1 ? 0 : 1) : sides === 2 ? (!l0 ? 2 : !l1 ? 0 : 1) : 0;
    writer.split(sides, special);
    const pb = d * 18;
    for (let q = 0; q < 3; q++) for (let e = 0; e < 3; e++) PTS[pb + q * 3 + e] = W[o + ((special + q) % 3) * 3 + e];
    for (let e = 0; e < 3; e++) {
      PTS[pb + 9 + e] = (PTS[pb + e] + PTS[pb + 3 + e]) / 2;
      PTS[pb + 12 + e] = (PTS[pb + 3 + e] + PTS[pb + 6 + e]) / 2;
      PTS[pb + 15 + e] = (PTS[pb + 6 + e] + PTS[pb + e]) / 2;
    }
    const layout = LAYOUT[sides], parts = SHARES[sides], kb = d * 36;
    for (let i = 0; i < layout.length; i++) {
      const kk = layout[i];
      for (let q = 0; q < 3; q++) for (let e = 0; e < 3; e++) KIDS[kb + i * 9 + q * 3 + e] = PTS[pb + kk[q] * 3 + e];
    }
    // children last to first, as the code is read
    for (let i = layout.length - 1; i >= 0; i--) {
      for (let j = 0; j < 9; j++) W[o + 9 + j] = KIDS[kb + i * 9 + j];
      share[d + 1] = share[d] * parts[i];
      visit(d + 1);
    }
  };
  for (const [m, faces] of groups) {
    progress?.(0.25 + 0.7 * (done++ / groups.size), `Painting material ${done} of ${groups.size}`);
    const src = input.sources.get(m)!;
    if (src.kind === 'colour') {
      const c = lut[cubeKey(src.rgb[0], src.rgb[1], src.rgb[2])];
      for (const f of faces) { faceMaterial[f] = c; held[c] += faceArea(P, T, f); leaves++; }
      continue;
    }
    index = null; tw = 1; th = 1;
    if (src.kind === 'texture') {
      const pic = shrink(src.picture);
      tw = pic.width; th = pic.height;
      index = reduce(pic, palette, s, src.tint, lut);
    }
    for (const f of faces) {
      face = f;
      area = faceArea(P, T, f);
      ax = T[f * 3] * 3; bx = T[f * 3 + 1] * 3; cx = T[f * 3 + 2] * 3;
      if (UV) { u0 = UV[f * 6]; v0 = UV[f * 6 + 1]; u1 = UV[f * 6 + 2]; v1 = UV[f * 6 + 3]; u2 = UV[f * 6 + 4]; v2 = UV[f * 6 + 5]; }
      writer.reset();
      first = -1; mixed = false;
      W.set([1, 0, 0, 0, 1, 0, 0, 0, 1], 0);
      share[0] = 1;
      visit(0);
      if (mixed) {
        const code = writer.toString();
        codes.set(f, code);
        splitFaces++;
        faceMaterial[f] = codeMajority(code, k + 1) - 1;
      } else faceMaterial[f] = first < 0 ? 0 : first;
    }
  }
  const unpainted = n - [...groups.values()].reduce((sum, l) => sum + l.length, 0);
  const notes: string[] = [];
  if (unpainted) notes.push(`${unpainted.toLocaleString()} triangles have nothing to paint them from; they take the first colour.`);
  if (leaves > MANY_LEAVES) notes.push(`The paint has ${(leaves / 1e6).toFixed(1)} million pieces, which can make the slicer slow: a larger smallest feature, fewer colours or more smoothing would mean fewer.`);
  let total = 0;
  for (let i = 0; i < k; i++) total += held[i];
  const coverage = Array.from(held, (v) => v / Math.max(total, 1e-12));
  progress?.(0.97, 'Painted');
  return { palette, coverage, faceMaterial, codes, splitFaces, leaves, depth: deepest, unpainted, notes };
}

/**
 * A reduced texture as a picture in the palette's colours (for the preview
 * of what painting will give, on the model and in the Prepare dialog).
 */
export function reducedPicture(labels: Uint8Array, w: number, h: number, palette: RGB[], drop?: Set<number>): Picture {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < labels.length; i++) {
    const c = palette[labels[i]] ?? [0, 0, 0];
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = drop?.has(labels[i]) ? 0 : 255;
  }
  return { width: w, height: h, data };
}

/** The share of a reduced texture each colour takes. */
export function labelShares(labels: Uint8Array, k: number): number[] {
  const c = new Float64Array(k);
  for (let i = 0; i < labels.length; i++) c[labels[i]]++;
  return Array.from(c, (v) => v / Math.max(labels.length, 1));
}

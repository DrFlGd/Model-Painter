// Voxel grids for finishing a model (finish.ts): a 3D grid of on/off cells and
// the few image operations closing gaps and rebuilding broken parts need,
// after scipy.ndimage as Dark STL's finish.py uses them. Cells are stored
// x-major, z fastest: cell (i, j, k) is at (i * ny + j) * nz + k. Pure.

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  data: Uint8Array;
}

export const grid = (nx: number, ny: number, nz: number): Grid => ({ nx, ny, nz, data: new Uint8Array(nx * ny * nz) });

const INF = 1e20;

/** Squared distance transform along one line of `n` values `f` (0 at seeds, INF elsewhere), into `d` (Felzenszwalb and Huttenlocher). */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const meet = (q: number, p: number) => ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
  for (let q = 1; q < n; q++) {
    let s = meet(q, v[k]);
    while (s <= z[k]) { k--; s = meet(q, v[k]); }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** For every cell, the squared distance (in cells) to the nearest cell where `seed` is set (INF when there is none). */
export function distance2(g: Grid, seed: (on: number) => boolean = (on) => on !== 0): Float32Array {
  const { nx, ny, nz, data } = g;
  const out = new Float32Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = seed(data[i]) ? 0 : INF;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  // along z
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const base = (i * ny + j) * nz;
    for (let k = 0; k < nz; k++) f[k] = out[base + k];
    edt1(f, nz, d, v, z);
    for (let k = 0; k < nz; k++) out[base + k] = d[k];
  }
  // along y
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) f[j] = out[(i * ny + j) * nz + k];
    edt1(f, ny, d, v, z);
    for (let j = 0; j < ny; j++) out[(i * ny + j) * nz + k] = d[j];
  }
  // along x
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) f[i] = out[(i * ny + j) * nz + k];
    edt1(f, nx, d, v, z);
    for (let i = 0; i < nx; i++) out[(i * ny + j) * nz + k] = d[i];
  }
  return out;
}

/** The cells within a ball of radius `r` cells of a set cell (the ball a little rounder than strict at small radii: x² + y² + z² ≤ r² + r). */
export function dilateBall(g: Grid, r: number): Grid {
  const d = distance2(g);
  const out = grid(g.nx, g.ny, g.nz), lim = r * r + r;
  for (let i = 0; i < d.length; i++) out.data[i] = d[i] <= lim ? 1 : 0;
  return out;
}

/** The cells whose whole ball of radius `r` is set; cells past the grid's edge count as unset. */
export function erodeBall(g: Grid, r: number): Grid {
  const { nx, ny, nz } = g;
  const d = distance2(g, (on) => on === 0);
  const out = grid(nx, ny, nz), lim = r * r + r;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const c = (i * ny + j) * nz + k;
    if (!g.data[c]) continue;
    const edge = Math.min(i + 1, nx - i, j + 1, ny - j, k + 1, nz - k);
    out.data[c] = d[c] > lim && edge * edge > lim ? 1 : 0;
  }
  return out;
}

/** Grows (or with `erode`, shrinks) the set by one cell across faces, `times` times (scipy's default cross, iterated). Cells past the edge count as unset. */
export function stepCross(g: Grid, times: number, erode = false): Grid {
  const { nx, ny, nz } = g;
  let cur = g.data;
  for (let t = 0; t < times; t++) {
    const next = new Uint8Array(cur.length);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const c = (i * ny + j) * nz + k;
      const nb = (di: number, dj: number, dk: number) => {
        const a = i + di, b = j + dj, e = k + dk;
        if (a < 0 || b < 0 || e < 0 || a >= nx || b >= ny || e >= nz) return 0;
        return cur[(a * ny + b) * nz + e];
      };
      if (erode) next[c] = cur[c] && nb(1, 0, 0) && nb(-1, 0, 0) && nb(0, 1, 0) && nb(0, -1, 0) && nb(0, 0, 1) && nb(0, 0, -1) ? 1 : 0;
      else next[c] = cur[c] || nb(1, 0, 0) || nb(-1, 0, 0) || nb(0, 1, 0) || nb(0, -1, 0) || nb(0, 0, 1) || nb(0, 0, -1) ? 1 : 0;
    }
    cur = next;
  }
  return { nx, ny, nz, data: cur };
}

/** The set with every enclosed space filled: the unset cells not joined (across faces) to the grid's edge are set. */
export function fillHoles(g: Grid): Grid {
  const { nx, ny, nz, data } = g;
  const outside = new Uint8Array(data.length);
  const stack: number[] = [];
  const push = (i: number, j: number, k: number) => {
    const c = (i * ny + j) * nz + k;
    if (!data[c] && !outside[c]) { outside[c] = 1; stack.push(c); }
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { push(i, j, 0); push(i, j, nz - 1); }
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) { push(i, 0, k); push(i, ny - 1, k); }
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) { push(0, j, k); push(nx - 1, j, k); }
  while (stack.length) {
    const c = stack.pop()!;
    const k = c % nz, j = ((c - k) / nz) % ny, i = Math.floor(c / (ny * nz));
    if (i > 0) push(i - 1, j, k);
    if (i < nx - 1) push(i + 1, j, k);
    if (j > 0) push(i, j - 1, k);
    if (j < ny - 1) push(i, j + 1, k);
    if (k > 0) push(i, j, k - 1);
    if (k < nz - 1) push(i, j, k + 1);
  }
  const out = grid(nx, ny, nz);
  for (let c = 0; c < data.length; c++) out.data[c] = outside[c] ? 0 : 1;
  return out;
}

export interface Blob {
  /** the blob's cells */
  cells: Uint32Array;
  /** its box of cells, inclusive */
  lo: [number, number, number];
  hi: [number, number, number];
}

/** The separate pieces of the set (joined across faces), each with its box. */
export function blobs(g: Grid): Blob[] {
  const { nx, ny, nz, data } = g;
  const seen = new Uint8Array(data.length);
  const out: Blob[] = [];
  for (let s = 0; s < data.length; s++) {
    if (!data[s] || seen[s]) continue;
    const cells: number[] = [];
    const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-1, -1, -1];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const k = c % nz, j = ((c - k) / nz) % ny, i = Math.floor(c / (ny * nz));
      if (i < lo[0]) lo[0] = i; if (i > hi[0]) hi[0] = i;
      if (j < lo[1]) lo[1] = j; if (j > hi[1]) hi[1] = j;
      if (k < lo[2]) lo[2] = k; if (k > hi[2]) hi[2] = k;
      const visit = (a: number, b: number, e: number) => {
        if (a < 0 || b < 0 || e < 0 || a >= nx || b >= ny || e >= nz) return;
        const n = (a * ny + b) * nz + e;
        if (data[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      };
      visit(i - 1, j, k); visit(i + 1, j, k); visit(i, j - 1, k); visit(i, j + 1, k); visit(i, j, k - 1); visit(i, j, k + 1);
    }
    out.push({ cells: Uint32Array.from(cells), lo, hi });
  }
  return out;
}

/** A Gaussian blur of a field of `nx` × `ny` × `nz` values (scipy's gaussian_filter: kernel to 4 sigma, edges mirrored). */
export function blur(field: Float32Array, nx: number, ny: number, nz: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.round(4 * sigma));
  const w = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { w[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += w[i + radius]; }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  // scipy's 'reflect': d c b a | a b c d | d c b a
  const at = (q: number, n: number) => {
    const p = 2 * n;
    let r = ((q % p) + p) % p;
    if (r >= n) r = p - 1 - r;
    return r;
  };
  let src = Float32Array.from(field), dst = new Float32Array(field.length);
  const m = Math.max(nx, ny, nz);
  const line = new Float64Array(m);
  const pass = (n: number, count: number, index: (line: number, q: number) => number) => {
    for (let l = 0; l < count; l++) {
      for (let q = 0; q < n; q++) line[q] = src[index(l, q)];
      for (let q = 0; q < n; q++) {
        let s = 0;
        for (let t = -radius; t <= radius; t++) s += w[t + radius] * line[at(q + t, n)];
        dst[index(l, q)] = s;
      }
    }
    [src, dst] = [dst, src];
  };
  pass(nz, nx * ny, (l, q) => l * nz + q);
  pass(ny, nx * nz, (l, q) => { const i = Math.floor(l / nz), k = l % nz; return (i * ny + q) * nz + k; });
  pass(nx, ny * nz, (l, q) => { const j = Math.floor(l / nz), k = l % nz; return (q * ny + j) * nz + k; });
  return src;
}

/**
 * The value of a field of cell values at a point, trilinear between cell
 * centres, less one half (so 0 is the surface of a field of 1s inside):
 * Manifold.levelSet's signed distance, from Dark STL's _field_sdf. Outside the
 * grid it is −0.5.
 */
export function fieldSdf(field: Float32Array, nx: number, ny: number, nz: number, origin: ArrayLike<number>, h: number): (p: [number, number, number]) => number {
  const inv = 1 / h;
  const ox = origin[0] + h / 2, oy = origin[1] + h / 2, oz = origin[2] + h / 2;
  return (p) => {
    const gx = (p[0] - ox) * inv, gy = (p[1] - oy) * inv, gz = (p[2] - oz) * inv;
    if (gx < 0 || gy < 0 || gz < 0) return -0.5;
    const i = Math.floor(gx), j = Math.floor(gy), k = Math.floor(gz);
    if (i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return -0.5;
    const fx = gx - i, fy = gy - j, fz = gz - k;
    const b = (i * ny + j) * nz + k, b2 = b + ny * nz;
    const c00 = field[b] + (field[b + 1] - field[b]) * fz;
    const c01 = field[b + nz] + (field[b + nz + 1] - field[b + nz]) * fz;
    const c10 = field[b2] + (field[b2 + 1] - field[b2]) * fz;
    const c11 = field[b2 + nz] + (field[b2 + nz + 1] - field[b2 + nz]) * fz;
    const c0 = c00 + (c01 - c00) * fy, c1 = c10 + (c11 - c10) * fy;
    return c0 + (c1 - c0) * fx - 0.5;
  };
}

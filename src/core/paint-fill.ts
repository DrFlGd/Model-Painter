// Region fills on a painted mesh, independent of the viewer: face adjacency,
// the rules a fill spreads by (the colour clicked, creases, how far the
// surface turns from where it started, or a whole connected part), and face
// normals for the tools that need to know which way a face looks.

import type { IndexedMesh } from './mesh.ts';

/** For each face, the up to three faces across its edges (−1 where an edge has no neighbour). */
export function faceAdjacency(mesh: IndexedMesh): Int32Array {
  const T = mesh.triangles;
  const n = T.length / 3;
  const adj = new Int32Array(n * 3).fill(-1);
  const byEdge = new Map<number, number>(); // edge key → face*3+side of the first face seen
  const key = (u: number, v: number) => (u < v ? u * 4294967296 + v : v * 4294967296 + u);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 3; k++) {
      const u = T[f * 3 + k], v = T[f * 3 + ((k + 1) % 3)];
      const e = key(u, v);
      const other = byEdge.get(e);
      if (other === undefined) { byEdge.set(e, f * 3 + k); continue; }
      adj[f * 3 + k] = other / 3 | 0;
      adj[other] = f;
      byEdge.delete(e);
    }
  }
  return adj;
}

/** Unit normal of every face, packed as xyz triples. */
export function faceNormals(mesh: IndexedMesh): Float32Array {
  const P = mesh.positions, T = mesh.triangles;
  const n = T.length / 3;
  const out = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    out[f * 3] = x / l; out[f * 3 + 1] = y / l; out[f * 3 + 2] = z / l;
  }
  return out;
}

/**
 * How a fill spreads from the triangle clicked:
 * - `colour`: over the connected area of the colour clicked, whatever its shape;
 * - `crease`: the same, but never across an edge that bends more than `angle`;
 * - `flat`: the same, but only over triangles that face within `angle` of the one clicked;
 * - `part`: over every triangle joined to it, whatever its colour.
 */
export type FillMode = 'colour' | 'crease' | 'flat' | 'part';
export interface FillRule { mode: FillMode; /** degrees, for `crease` and `flat` (default 40) */ angle?: number }

/**
 * Whether a fill by `rule` that started at `seed` may step from face `f` to
 * its neighbour `g`, as far as their directions go (the colour is checked
 * apart). A triangle with no area (no direction) never stops it.
 */
export function spreads(rule: FillRule, normals: Float32Array, seed: number): (f: number, g: number) => boolean {
  if (rule.mode !== 'crease' && rule.mode !== 'flat') return () => true;
  const cos = Math.cos((Math.min(180, rule.angle ?? 40) * Math.PI) / 180);
  const flat = (i: number) => normals[i * 3] === 0 && normals[i * 3 + 1] === 0 && normals[i * 3 + 2] === 0;
  const dot = (i: number, j: number) => normals[i * 3] * normals[j * 3] + normals[i * 3 + 1] * normals[j * 3 + 1] + normals[i * 3 + 2] * normals[j * 3 + 2];
  if (rule.mode === 'crease') return (f, g) => flat(f) || flat(g) || dot(f, g) >= cos;
  return (_f, g) => flat(seed) || flat(g) || dot(seed, g) >= cos;
}

/**
 * Faces more than half covered by a screen mask, from a per-pixel face map
 * (`ids[y * width + x]` = face index, or -1 for no face). `inMask(x, y)` says
 * which pixels the stamp or polygon covers. Faces with no pixel at all are too
 * small to see and are left alone.
 */
export function facesUnderMask(ids: Int32Array, width: number, height: number, inMask: (x: number, y: number) => boolean, faceCount: number): Uint32Array {
  const total = new Uint32Array(faceCount), hit = new Uint32Array(faceCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const f = ids[y * width + x];
      if (f < 0 || f >= faceCount) continue;
      total[f]++;
      if (inMask(x, y)) hit[f]++;
    }
  }
  const out: number[] = [];
  for (let f = 0; f < faceCount; f++) if (total[f] && hit[f] * 2 >= total[f]) out.push(f);
  return Uint32Array.from(out);
}

/** Point-in-polygon in screen space (even-odd rule). */
export function insidePolygon(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

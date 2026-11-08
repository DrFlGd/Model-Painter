// Region fills on a painted mesh, independent of the viewer: face adjacency,
// a bucket fill that spreads across edges until it meets another colour or a
// crease, and face normals for the tools that need to know which way a face
// looks.

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
 * The faces a bucket fill from `seed` reaches: connected across edges, all in
 * the seed's current colour, never across an edge that bends more than
 * `maxAngleDeg` (180 ignores creases, so only colour bounds the fill).
 */
export function floodRegion(adj: Int32Array, normals: Float32Array, faceMaterial: Uint8Array, seed: number, maxAngleDeg = 40): Uint32Array {
  const colour = faceMaterial[seed];
  const cosMax = Math.cos((Math.min(180, maxAngleDeg) * Math.PI) / 180);
  const seen = new Uint8Array(faceMaterial.length);
  const stack = [seed];
  const out: number[] = [];
  seen[seed] = 1;
  while (stack.length) {
    const f = stack.pop()!;
    out.push(f);
    for (let k = 0; k < 3; k++) {
      const g = adj[f * 3 + k];
      if (g < 0 || seen[g] || faceMaterial[g] !== colour) continue;
      const d = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
      if (d < cosMax) continue; // a crease
      seen[g] = 1;
      stack.push(g);
    }
  }
  return Uint32Array.from(out);
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

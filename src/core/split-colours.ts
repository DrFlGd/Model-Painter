// Splits a painted solid into one body per colour, for slicers and printers
// that want each colour as its own part rather than paint on one mesh. Each
// painted region becomes a skin `depth` mm deep under its faces (the region's
// faces, the same faces pushed inward along the surface normals, and walls
// along the region's edge), trimmed to the solid; the rest of the solid stays
// with the base colour. Skins never overlap each other or the base, so the
// parts print as one object. Pure, shared by the CLI and the browser app.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './mesh.ts';
import { fromManifold, manifold, toManifold } from './solid.ts';

export interface ColourPart {
  /** index into the materials the faces were painted with */
  material: number;
  mesh: IndexedMesh;
  volume: number;
}

export interface SplitResult {
  /** the base first, then one part per painted colour, in material order; colours with no faces are left out */
  parts: ColourPart[];
  /** which material is the base: the one covering the most surface unless given */
  base: number;
  warnings: string[];
}

export interface SplitOptions {
  /** how deep each colour reaches into the part, mm (default 1.2, a few layers) */
  depth?: number;
  /** the material that keeps everything not covered by another colour's skin; default the one covering the most surface */
  base?: number;
}

export async function splitByMaterial(mesh: IndexedMesh, faceMaterial: Uint8Array, materialCount: number, opts: SplitOptions = {}): Promise<SplitResult> {
  const { Manifold } = await manifold();
  const depth = opts.depth ?? 1.2;
  const n = mesh.triangles.length / 3;
  const counts = new Array<number>(materialCount).fill(0);
  const areas = new Array<number>(materialCount).fill(0);
  const P = mesh.positions, T = mesh.triangles;
  for (let t = 0; t < n; t++) {
    const m = faceMaterial[t];
    if (m >= materialCount) continue;
    counts[m]++;
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    areas[m] += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  // the colour covering most of the surface (not the most faces: paint inside faces makes many small ones)
  const base = opts.base ?? areas.indexOf(Math.max(...areas));
  const warnings: string[] = [];
  const solid = await toManifold(mesh);
  const skins: { material: number; solid: ManifoldT }[] = [];
  let taken: ManifoldT | null = null;
  for (let m = 0; m < materialCount; m++) {
    if (m === base || counts[m] === 0) continue;
    const faces: number[] = [];
    for (let t = 0; t < n; t++) if (faceMaterial[t] === m) faces.push(t);
    let skin = (await toManifold(skinMesh(mesh, faces, depth))).intersect(solid);
    if (taken) skin = skin.subtract(taken);
    const pieces = skin.decompose().filter((p) => p.volume() > 0.05);
    if (!pieces.length) { warnings.push(`colour ${m + 1} has no volume left; its faces were too few or too thin`); continue; }
    skin = pieces.length === 1 ? pieces[0] : Manifold.union(pieces);
    taken = taken ? taken.add(skin) : skin;
    skins.push({ material: m, solid: skin });
  }
  let core = taken ? solid.subtract(taken) : solid;
  const corePieces = core.decompose().filter((p) => p.volume() > 0.05);
  if (!corePieces.length) warnings.push('nothing is left for the base colour: the skins cover the whole part');
  else if (corePieces.length > 1) warnings.push(`the base is ${corePieces.length} separate pieces`);
  core = corePieces.length === 1 ? corePieces[0] : corePieces.length ? Manifold.union(corePieces) : core;
  const parts: ColourPart[] = [];
  if (corePieces.length) parts.push({ material: base, mesh: fromManifold(core), volume: core.volume() });
  for (const s of skins) parts.push({ material: s.material, mesh: fromManifold(s.solid), volume: s.solid.volume() });
  return { parts, base, warnings };
}

/**
 * Offset direction per vertex of the given faces: the area-weighted mean of
 * those faces' normals, lengthened so that moving a vertex by it moves each
 * of its face planes by one unit (at a square edge inside the region the
 * vertex goes 1.41 along the diagonal, so both faces move by exactly 1; on
 * the region's edge only the region's faces count, so the skin keeps its
 * full depth right up to its boundary). Capped at 2.5 for very sharp corners.
 */
export function vertexOffsets(mesh: IndexedMesh, faces: number[]): Float32Array {
  const P = mesh.positions, T = mesh.triangles;
  const N = new Float32Array(P.length);
  const F = new Float32Array(T.length); // unit normal per face
  for (const f of faces) {
    const t = f * 3;
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // twice the area, outward
    for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    F[t] = nx / l; F[t + 1] = ny / l; F[t + 2] = nz / l;
  }
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
    N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
  }
  // the smallest cosine between a vertex's offset direction and its face normals sets how far it must move
  const minDot = new Float32Array(P.length / 3).fill(1);
  for (const f of faces) {
    const t = f * 3;
    for (let k = 0; k < 3; k++) {
      const v = T[t + k];
      const d = N[v * 3] * F[t] + N[v * 3 + 1] * F[t + 1] + N[v * 3 + 2] * F[t + 2];
      if (d < minDot[v]) minDot[v] = d;
    }
  }
  for (let v = 0; v < minDot.length; v++) {
    const s = 1 / Math.max(minDot[v], 0.4);
    N[v * 3] *= s; N[v * 3 + 1] *= s; N[v * 3 + 2] *= s;
  }
  return N;
}

/**
 * A closed mesh under the given faces of `mesh`: those faces, the same faces
 * `depth` inward (reversed), and walls along the region's boundary. A vertex
 * where the region only touches itself (two fans of faces meeting at a point)
 * is duplicated per fan, so the result is always a proper 2-manifold.
 */
export function skinMesh(mesh: IndexedMesh, faces: number[], depth: number): IndexedMesh {
  const P = mesh.positions, T = mesh.triangles;
  const offsets = vertexOffsets(mesh, faces);
  // faces around each vertex of the region
  const around = new Map<number, number[]>();
  for (const f of faces) for (let k = 0; k < 3; k++) {
    const v = T[f * 3 + k];
    let list = around.get(v);
    if (!list) around.set(v, (list = []));
    list.push(f);
  }
  // each (vertex, fan) gets its own outer vertex; a fan is a set of the vertex's faces joined by shared edges
  const positions: number[] = [];
  const cornerVertex = new Map<string, number>(); // `${face}:${corner}` → outer vertex index
  for (const [v, fs] of around) {
    const parent = fs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const others = fs.map((f) => [0, 1, 2].map((k) => T[f * 3 + k]).filter((w) => w !== v));
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
      if (others[i].some((w) => others[j].includes(w))) parent[find(i)] = find(j);
    }
    const fanVertex = new Map<number, number>();
    fs.forEach((f, i) => {
      const root = find(i);
      let idx = fanVertex.get(root);
      if (idx === undefined) {
        idx = positions.length / 3;
        fanVertex.set(root, idx);
        positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
      for (let k = 0; k < 3; k++) if (T[f * 3 + k] === v) cornerVertex.set(`${f}:${k}`, idx);
    });
  }
  const outerCount = positions.length / 3;
  // the inner copy of every outer vertex, pushed in along the normal of the vertex it came from
  const source = new Int32Array(outerCount);
  for (const [key, idx] of cornerVertex) {
    const [f, k] = key.split(':').map(Number);
    source[idx] = T[f * 3 + k];
  }
  for (let i = 0; i < outerCount; i++) {
    const v = source[i] * 3;
    positions.push(P[v] - offsets[v] * depth, P[v + 1] - offsets[v + 1] * depth, P[v + 2] - offsets[v + 2] * depth);
  }
  const inner = (i: number) => i + outerCount;
  const tris: number[] = [];
  const directed = new Set<string>();
  const corner = (f: number, k: number) => cornerVertex.get(`${f}:${k}`)!;
  for (const f of faces) {
    const a = corner(f, 0), b = corner(f, 1), c = corner(f, 2);
    tris.push(a, b, c, inner(a), inner(c), inner(b));
    directed.add(`${a}>${b}`).add(`${b}>${c}`).add(`${c}>${a}`);
  }
  // walls on the edges that have no neighbour in the region
  for (const f of faces) {
    const vs = [corner(f, 0), corner(f, 1), corner(f, 2)];
    for (let k = 0; k < 3; k++) {
      const u = vs[k], v = vs[(k + 1) % 3];
      if (directed.has(`${v}>${u}`)) continue;
      tris.push(v, u, inner(u), v, inner(u), inner(v));
    }
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(tris) };
}

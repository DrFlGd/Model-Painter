// A model as the app paints it, whatever file it came from: one welded mesh
// (so paint and fills run across the UV seams the game split it along), the
// UV and colour of every triangle corner, a material per triangle and what
// each material is coloured with. The importers (import/*.ts) build one from
// their file with `ModelBuilder`, finding textures through a `FileSource`
// (the desktop's folders, the browser's dropped files, the tests' disk). Pure.

import type { IndexedMesh } from './mesh.ts';
import { pickFaces, weld } from './mesh.ts';
import type { RGB } from './colour.ts';

/** A picture file a material is coloured with: found (with its bytes) or only named. */
export interface TextureRef {
  /** the picture's file name, or the name the model gives it */
  name: string;
  /** where it was found, relative to the model's folder ('' for one inside the model file) */
  path: string;
  /** the file's bytes; null when it was not found */
  bytes: Uint8Array | null;
}

export interface ModelMaterial {
  name: string;
  /** its colour texture */
  texture?: TextureRef;
  /** its flat colour (the diffuse or base colour), 0..255 sRGB */
  colour?: RGB;
  /** the texture is multiplied by this (glTF's base colour factor) */
  tint?: RGB;
  /** how its texture was found, or why not */
  note?: string;
}

/** Slicer paint the file already had (a painted 3MF): every triangle's colour, the codes of those painted in part, and the colours. */
export interface ModelPaint {
  faceMaterial: Uint8Array;
  codes: Map<number, string>;
  palette: RGB[];
}

export interface ImportedModel {
  name: string;
  /** what the file was, for the status line ('glTF', 'Wavefront OBJ'...) */
  format: string;
  mesh: IndexedMesh;
  /** UV of every triangle corner (6 per triangle), V down the picture; null when the model has none */
  uvs: Float32Array | null;
  /** RGB of every triangle corner (9 per triangle); null when the model has none */
  vertexColours: Uint8Array | null;
  /** the material of every triangle */
  faceMaterial: Uint16Array;
  /** the part of the file every triangle is in (a mesh, an object): finishing makes each part solid on its own when they tangle */
  faceGroup: Uint32Array;
  materials: ModelMaterial[];
  paint?: ModelPaint;
  /** the unit the file's numbers are in, when it says or it can be told: a print is sized from it */
  units: 'mm' | 'cm' | 'm' | 'in' | 'unknown';
  notes: string[];
}

/** Where an importer reads the model and the files beside it. */
export interface FileSource {
  /** the model file's name */
  name: string;
  /** the model file */
  bytes: Uint8Array;
  /** a file by its path relative to the model's folder ('tex/a.png', '../a.mtl'), or null when it is not there */
  read(path: string): Promise<Uint8Array | null>;
  /** the files near the model, as paths relative to its folder: its folder and those below, and further when the source can */
  list(): Promise<string[]>;
}

export const PICTURE_EXTENSIONS = ['.dds', '.png', '.tga', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp', '.gif'];

export const extension = (name: string) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); };
export const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path;
export const stem = (name: string) => { const b = baseName(name); const i = b.lastIndexOf('.'); return i <= 0 ? b : b.slice(0, i); };
export const isPicture = (name: string) => PICTURE_EXTENSIONS.includes(extension(name));

/** Joins a relative path onto a folder (both with '/'), resolving '.' and '..'. */
export function joinPath(folder: string, rel: string): string {
  const parts = (folder ? folder.split('/') : []).concat(rel.replace(/\\/g, '/').split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); }
    else out.push(p);
  }
  return out.join('/');
}

/**
 * Finds a file a model names (as the model wrote it: a relative path, an
 * absolute path from the machine it was made on, or a bare name): at that
 * path, else by its file name anywhere near the model (the nearest first),
 * else, for a picture, by the same name with another picture extension (a
 * tool exported TGA where the model says PNG). Returns where it was found.
 */
export async function findFile(src: FileSource, wanted: string, from = '', listing?: string[]): Promise<{ path: string; bytes: Uint8Array } | null> {
  const clean = decodeURIComponent(wanted.trim()).replace(/\\/g, '/').replace(/^file:\/\//, '');
  if (!clean) return null;
  const isAbsolute = /^([a-z]:)?\//i.test(clean);
  if (!isAbsolute) {
    const path = joinPath(from, clean);
    const bytes = await src.read(path);
    if (bytes) return { path, bytes };
  }
  const files = listing ?? (await src.list());
  const name = baseName(clean).toLowerCase();
  const pictureStem = isPicture(name) ? stem(name) : null;
  let best: string | null = null, bestScore = Infinity;
  for (const f of files) {
    const b = baseName(f).toLowerCase();
    let score: number;
    if (b === name) score = 0;
    else if (pictureStem !== null && isPicture(b) && stem(b) === pictureStem) score = 1 + PICTURE_EXTENSIONS.indexOf(extension(b)) / 100;
    else continue;
    score += distance(from, f) * 2;
    if (score < bestScore) { bestScore = score; best = f; }
  }
  if (best === null) return null;
  const bytes = await src.read(best);
  return bytes ? { path: best, bytes } : null;
}

/** How many folders apart a file is from a folder. */
function distance(folder: string, file: string): number {
  const a = folder ? folder.split('/') : [], b = file.split('/').slice(0, -1);
  let common = 0;
  while (common < a.length && common < b.length && a[common].toLowerCase() === b[common].toLowerCase()) common++;
  return a.length - common + (b.length - common);
}

/** A texture's role from its name, by the suffixes games and tools give them (Dark STL's rules). */
export function textureRole(name: string): 'colour' | 'normal' | 'mask' | 'height' | 'other' {
  const s = stem(name);
  if (/(_|^)(n|nrm|nrml|nml|nor|norm|normal|normals|normalmap|nm|nmap|nrma|nrmr|nr)(_|\d*$)/i.test(s)) return 'normal';
  if (/(_|^)(d|dif|diff|diffuse|alb|albedo|c|col|color|colour|bc|basecolou?r|base_colou?r)(_|\d*$)/i.test(s)) return 'colour';
  if (/(_|^)(s|spec|specular|m|mask|msk|masks|g|gloss|orm|mra|rma|arm|mr|rm|r|rough|roughness|metal|metalness|metallic|ao|em|emissive)(_|\d*$)/i.test(s)) return 'mask';
  if (/(_|^)(h|height|disp|bump)(_|\d*$)/i.test(s)) return 'height';
  return 'other';
}

/** A growable typed array. */
class Grow<T extends Float32Array | Uint32Array | Uint8Array | Uint16Array> {
  data: T;
  length = 0;
  private Ctor: new (n: number) => T;
  constructor(Ctor: new (n: number) => T, size = 1024) { this.Ctor = Ctor; this.data = new Ctor(size); }
  reserve(n: number) {
    if (this.length + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + n) size *= 2;
    const d = new this.Ctor(size);
    d.set(this.data.subarray(0, this.length) as never);
    this.data = d;
  }
  push(v: number) { this.reserve(1); this.data[this.length++] = v; }
  done(): T { return this.data.slice(0, this.length) as T; }
}

export interface Primitive {
  /** xyz per vertex */
  positions: ArrayLike<number>;
  /** 3 vertex indices per triangle; missing: the vertices in threes */
  indices?: ArrayLike<number> | null;
  /** UV per vertex (V down the picture) */
  uvs?: ArrayLike<number> | null;
  /** RGB(A) per vertex, `colourWidth` numbers each, 0..1 floats or 0..255 */
  colours?: ArrayLike<number> | null;
  colourWidth?: number;
  colourScale?: number;
  /** a material for all of it, or one per triangle */
  material: number | ArrayLike<number>;
  /** the file's part it is in, or one per triangle; missing: a part of its own */
  group?: number | ArrayLike<number>;
  /** a 4 × 4 matrix (column-major, as glTF and three.js keep them) to place it */
  matrix?: ArrayLike<number> | null;
}

/** Gathers the triangles of a file's meshes, then welds them into the model. */
export class ModelBuilder {
  private pos = new Grow(Float32Array, 3 * 4096);
  private tri = new Grow(Uint32Array, 3 * 4096);
  private uv = new Grow(Float32Array, 6 * 4096);
  private col = new Grow(Uint8Array, 9 * 4096);
  private mat = new Grow(Uint16Array, 4096);
  private grp = new Grow(Uint32Array, 4096);
  private groups = 0;
  private anyUv = false;
  private anyColour = false;
  materials: ModelMaterial[] = [];
  notes: string[] = [];
  /** after `build`: for each triangle of the model, the triangle it was when added (counting every triangle added) */
  kept: Uint32Array | null = null;

  addMaterial(m: ModelMaterial): number { this.materials.push(m); return this.materials.length - 1; }

  get triangleCount(): number { return this.mat.length; }

  add(p: Primitive): void {
    const P = p.positions, nv = Math.floor(P.length / 3);
    if (!nv) return;
    const base = this.pos.length / 3;
    this.pos.reserve(nv * 3);
    const m = p.matrix;
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      if (m) {
        this.pos.push(m[0] * x + m[4] * y + m[8] * z + m[12]);
        this.pos.push(m[1] * x + m[5] * y + m[9] * z + m[13]);
        this.pos.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
      } else { this.pos.push(x); this.pos.push(y); this.pos.push(z); }
    }
    const mirrored = !!m && m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]) < 0;
    const I = p.indices;
    const nt = Math.floor((I ? I.length : nv) / 3);
    const at = (k: number) => (I ? I[k] : k);
    const U = p.uvs, C = p.colours, cw = p.colourWidth ?? 3, cs = p.colourScale ?? 255;
    if (U) this.anyUv = true;
    if (C) this.anyColour = true;
    this.tri.reserve(nt * 3); this.uv.reserve(nt * 6); this.col.reserve(nt * 9); this.mat.reserve(nt); this.grp.reserve(nt);
    const G = p.group ?? this.groups;
    for (let t = 0; t < nt; t++) {
      let a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
      if (a >= nv || b >= nv || c >= nv) continue;
      if (mirrored) { const s = b; b = c; c = s; }
      this.tri.push(base + a); this.tri.push(base + b); this.tri.push(base + c);
      for (const v of [a, b, c]) {
        if (U) { this.uv.push(U[v * 2]); this.uv.push(U[v * 2 + 1]); } else { this.uv.push(0); this.uv.push(0); }
        if (C) for (let k = 0; k < 3; k++) this.col.push(Math.max(0, Math.min(255, Math.round(C[v * cw + k] * (255 / cs)))));
        else { this.col.push(255); this.col.push(255); this.col.push(255); }
      }
      this.mat.push(typeof p.material === 'number' ? p.material : p.material[t] ?? 0);
      const g = typeof G === 'number' ? G : G[t] ?? 0;
      this.grp.push(g);
      if (g >= this.groups) this.groups = g + 1;
    }
  }

  /** The model: vertices in the same place joined, triangles that became lines dropped. */
  build(name: string, format: string, units: ImportedModel['units']): ImportedModel {
    if (!this.mat.length) throw new Error(`${name} has no triangles`);
    const raw: IndexedMesh = { positions: this.pos.done(), triangles: this.tri.done() };
    const { mesh, kept } = weld(raw);
    this.kept = kept;
    if (!kept.length) throw new Error(`${name} has no triangles with any area`);
    const dropped = this.mat.length - kept.length;
    if (dropped) this.notes.push(`${dropped.toLocaleString()} triangles with no area were left out.`);
    if (!this.materials.length) this.materials.push({ name: 'Model' });
    return {
      name, format, mesh, units, notes: this.notes, materials: this.materials,
      uvs: this.anyUv ? pickFaces(this.uv.done(), 6, kept) : null,
      vertexColours: this.anyColour ? pickFaces(this.col.done(), 9, kept) : null,
      faceMaterial: pickFaces(this.mat.done(), 1, kept),
      faceGroup: pickFaces(this.grp.done(), 1, kept),
    };
  }
}

/** Reads a whole text file, without a byte order mark. */
export function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

// FBX, Collada (DAE), 3DS and PLY models, read with three.js's loaders in
// the page (they need its DOM for embedded pictures) and made into the app's
// model like every other format. The loaders' own texture loading is
// stood in for while they parse: each texture a material asks for is only
// noted, and found beside the model through the FileSource as the other
// importers find theirs (or fetched, when the file embeds it).

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { addImporter } from '../core/import/index.ts';
import { baseName, findFile, ModelBuilder, stem, textureRole, type FileSource, type ImportedModel, type ModelMaterial } from '../core/model.ts';
import type { RGB } from '../core/colour.ts';

/** Y up (three.js) to Z up, column-major. */
const Y_TO_Z = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

/** A texture loader that loads nothing and notes what was asked for. */
class NoteLoader {
  path = '';
  ext: string;
  constructor(ext = '') { this.ext = ext; }
  setPath(p: string | undefined) { this.path = p ?? ''; return this; }
  setCrossOrigin() { return this; }
  load(url: string) { const t = new THREE.Texture(); t.userData.source = (this.path || '') + url; t.userData.ext = this.ext; return t; }
}

/** Runs a loader's parse with texture loading noted rather than done. */
function noting<T>(parse: (manager: THREE.LoadingManager) => T): T {
  const manager = new THREE.LoadingManager();
  for (const ext of ['tga', 'tif', 'tiff', 'dds', 'exr', 'hdr', 'ktx2', 'psd']) manager.addHandler(new RegExp(`\\.${ext}$`, 'i'), new NoteLoader(`.${ext}`) as unknown as THREE.Loader);
  const tex = THREE.TextureLoader.prototype.load, data = THREE.DataTextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (this: THREE.TextureLoader, url: string) { return NoteLoader.prototype.load.call(Object.assign(new NoteLoader(), { path: this.path }), url); } as typeof tex;
  THREE.DataTextureLoader.prototype.load = function (this: THREE.DataTextureLoader, url: string) { return NoteLoader.prototype.load.call(Object.assign(new NoteLoader('.tga'), { path: this.path }), url) as unknown as THREE.DataTexture; } as typeof data;
  try { return parse(manager); } finally {
    THREE.TextureLoader.prototype.load = tex;
    THREE.DataTextureLoader.prototype.load = data;
  }
}

const srgb = (c: THREE.Color): RGB => { const o = { r: 0, g: 0, b: 0 }; c.getRGB(o, THREE.SRGBColorSpace); return [Math.round(o.r * 255), Math.round(o.g * 255), Math.round(o.b * 255)]; };

/** Gathers a loaded scene's meshes into a model. */
async function fromScene(src: FileSource, root: THREE.Object3D, format: string, zUp: boolean, units: ImportedModel['units'], scale = 1): Promise<ImportedModel> {
  root.updateMatrixWorld(true);
  const builder = new ModelBuilder();
  const materials = new Map<THREE.Material, number>();
  const wanted = new Map<number, THREE.Texture>();
  const place = new THREE.Matrix4();
  let skipped = 0;
  const materialIndex = (m: THREE.Material | undefined): number => {
    if (!m) return builder.addMaterial({ name: 'Model' });
    let i = materials.get(m);
    if (i !== undefined) return i;
    const any = m as THREE.MeshStandardMaterial;
    const out: ModelMaterial = { name: m.name || `Material ${materials.size + 1}` };
    if (any.color) out.colour = srgb(any.color);
    i = builder.addMaterial(out);
    materials.set(m, i);
    // a texture's colours as they are: these formats' diffuse colour beside a texture is mostly an exporter's default grey
    if (any.map) wanted.set(i, any.map);
    return i;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) { if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine) skipped++; return; }
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (!pos) return;
    const uv = g.getAttribute('uv'), col = g.getAttribute('color');
    const index = g.getIndex();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const nt = (index ? index.count : pos.count) / 3;
    const perFace = new Uint16Array(nt).fill(materialIndex(mats[0]));
    for (const gr of g.groups) {
      const mi = materialIndex(mats[gr.materialIndex ?? 0] ?? mats[0]);
      for (let t = Math.floor(gr.start / 3); t < Math.min(nt, Math.floor((gr.start + gr.count) / 3)); t++) perFace[t] = mi;
    }
    // UVs with V up (three's) flipped down the picture; colours from linear back to sRGB
    let uvs: Float32Array | null = null;
    if (uv) { uvs = new Float32Array(uv.count * 2); for (let v = 0; v < uv.count; v++) { uvs[v * 2] = uv.getX(v); uvs[v * 2 + 1] = 1 - uv.getY(v); } }
    let colours: Float32Array | null = null;
    if (col) {
      colours = new Float32Array(col.count * 3);
      const c = new THREE.Color();
      for (let v = 0; v < col.count; v++) { c.setRGB(col.getX(v), col.getY(v), col.getZ(v)); const s = srgb(c); colours[v * 3] = s[0]; colours[v * 3 + 1] = s[1]; colours[v * 3 + 2] = s[2]; }
    }
    place.copy(mesh.matrixWorld);
    if (!zUp) place.premultiply(Y_TO_Z);
    if (scale !== 1) place.premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
    const p = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) { p[v * 3] = pos.getX(v); p[v * 3 + 1] = pos.getY(v); p[v * 3 + 2] = pos.getZ(v); }
    builder.add({ positions: p, indices: index ? (index.array as ArrayLike<number>) : null, uvs, colours, colourWidth: 3, colourScale: 255, material: perFace, matrix: place.elements });
  });
  if (skipped) builder.notes.push(`${skipped} parts that are lines or points were left out.`);
  // the textures, found beside the model (or taken out of it)
  const listing = await src.list();
  for (const [i, t] of wanted) {
    let url = String(t.userData.source ?? '');
    const m = builder.materials[i];
    // a texture that names no file of its own (an FBX texture with no video): by its name, as any picture
    if (!url || /(^|\/)undefined$/.test(url)) url = t.name ? `${t.name.replace(/^.*::/, '')}.png` : '';
    if (!url) continue;
    if (/^(blob|data):/.test(url)) {
      try {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        m.texture = { name: (t.name || m.name) + (t.userData.ext || ''), path: '', bytes };
        m.note = 'inside the model file';
      } catch { m.note = 'its texture inside the model could not be read'; }
      continue;
    }
    const found = await findFile(src, url, '', listing);
    m.texture = { name: baseName(url), path: found?.path ?? '', bytes: found?.bytes ?? null };
    if (!found) m.note = `${baseName(url)} wasn't found beside the model`;
    else if (textureRole(found.path) === 'normal') m.note = 'this looks like a normal map rather than colours';
  }
  return builder.build(stem(src.name), format, units);
}

/** An FBX file's UnitScaleFactor (centimetres per unit), from its text or its binary property, or null. */
export function fbxUnitScale(bytes: Uint8Array): number | null {
  const name = new TextEncoder().encode('UnitScaleFactor');
  outer: for (let i = 0; i + name.length < bytes.length; i++) {
    for (let k = 0; k < name.length; k++) if (bytes[i + k] !== name[k]) continue outer;
    let at = i + name.length;
    if (bytes[at] === 0x22) {
      // ASCII: P: "UnitScaleFactor", "double", "Number", "",1
      const line = new TextDecoder().decode(bytes.subarray(at, Math.min(bytes.length, at + 120))).split('\n')[0];
      const v = parseFloat(line.split(',').pop() ?? '');
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    // binary: the name, then string properties ('S', length, text), then the value ('D', a double)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let n = 0; n < 4 && bytes[at] === 0x53; n++) at += 5 + dv.getUint32(at + 1, true);
    if (bytes[at] === 0x44 && at + 9 <= bytes.length) { const v = dv.getFloat64(at + 1, true); return Number.isFinite(v) && v > 0 ? v : null; }
    return null;
  }
  return null;
}

async function importFbx(src: FileSource): Promise<ImportedModel> {
  const buffer = src.bytes.buffer.slice(src.bytes.byteOffset, src.bytes.byteOffset + src.bytes.byteLength) as ArrayBuffer;
  const group = noting((manager) => new FBXLoader(manager).parse(buffer, ''));
  // three.js reads the numbers as they are; the file says how many centimetres each is (one, unless it says otherwise)
  const cm = fbxUnitScale(src.bytes) ?? 1;
  return fromScene(src, group, 'FBX', false, 'mm', cm * 10);
}

async function importDae(src: FileSource): Promise<ImportedModel> {
  const text = new TextDecoder().decode(src.bytes);
  const result = noting((manager) => new ColladaLoader(manager).parse(text, ''));
  if (!result) throw new Error(`${src.name} isn't a Collada file three.js can read`);
  // the loader turns a Z-up file to Y up and scales by its unit (to metres)
  return fromScene(src, result.scene, 'Collada', false, 'm');
}

async function import3ds(src: FileSource): Promise<ImportedModel> {
  const buffer = src.bytes.buffer.slice(src.bytes.byteOffset, src.bytes.byteOffset + src.bytes.byteLength) as ArrayBuffer;
  const group = noting((manager) => new TDSLoader(manager).parse(buffer, ''));
  return fromScene(src, group, '3DS', true, 'unknown');
}

async function importPly(src: FileSource): Promise<ImportedModel> {
  const buffer = src.bytes.buffer.slice(src.bytes.byteOffset, src.bytes.byteOffset + src.bytes.byteLength) as ArrayBuffer;
  const head = new TextDecoder().decode(src.bytes.subarray(0, 4096));
  const faces = /element\s+face\s+(\d+)/.exec(head);
  if (!faces || faces[1] === '0') throw new Error(`${src.name} has no faces: it is a point cloud, which has no surface to paint`);
  const geometry = new PLYLoader().parse(buffer);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: 'Model' }));
  return fromScene(src, mesh, 'PLY', true, 'unknown');
}

export function registerThreeImporters(): void {
  addImporter('.fbx', 'FBX', importFbx);
  addImporter('.dae', 'Collada', importDae);
  addImporter('.3ds', '3DS', import3ds);
  addImporter('.ply', 'PLY', importPly);
}

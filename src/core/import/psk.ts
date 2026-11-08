// ActorX models (.psk skeletal meshes, .pskx static meshes), as UModel and
// FModel export Unreal games' models (a port of Dark STL's importers/psk.py).
// Unreal is left-handed, Z up, in centimetres: positions are mirrored in Y and
// read as centimetres, and faces wound to agree with the stored normals. A
// material's colour texture is found by name near the model, from its
// material file (UModel and FModel write `<material>.mat`, FModel
// `<material>.json`, UModel `<material>.props.txt`), else from pictures named
// like the material. Unreal's UVs have V down the picture, as kept here.

import { ModelBuilder, baseName, isPicture, stem, text, textureRole, type FileSource, type ImportedModel, type ModelMaterial } from '../model.ts';

const MATERIAL_FILES = ['.mat', '.json', '.props.txt'];

interface Psk {
  points: Float32Array;
  wedgePoint: Uint32Array;
  wedgeUv: Float32Array;
  faces: Uint32Array;
  faceMaterial: Uint8Array;
  materials: string[];
  normals: Float32Array | null;
  bones: number;
}

export function readPsk(bytes: Uint8Array, name = ''): Psk {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  let points: Float32Array | null = null, wedgePoint: Uint32Array | null = null, wedgeUv: Float32Array | null = null, wedgeMat: Uint8Array | null = null;
  let faces: Uint32Array | null = null, faceMaterial: Uint8Array | null = null, normals: Float32Array | null = null;
  const materials: string[] = [];
  let bones = 0;
  while (pos + 32 <= bytes.length) {
    let id = '';
    for (let i = 0; i < 20 && bytes[pos + i]; i++) id += String.fromCharCode(bytes[pos + i]);
    const size = dv.getInt32(pos + 24, true), count = dv.getInt32(pos + 28, true);
    pos += 32;
    const end = pos + size * count;
    if (size < 0 || count < 0 || end > bytes.length) throw new Error(`${name}: chunk ${id} runs past the end of the file`);
    if (id === 'PNTS0000' && size === 12) {
      points = new Float32Array(count * 3);
      for (let i = 0; i < count * 3; i++) points[i] = dv.getFloat32(pos + i * 4, true);
    } else if (id === 'VTXW0000') {
      if (size !== 16) throw new Error(`${name}: wedges of ${size} bytes aren't known`);
      wedgePoint = new Uint32Array(count); wedgeUv = new Float32Array(count * 2); wedgeMat = new Uint8Array(count);
      const wide = count > 65536;
      for (let i = 0; i < count; i++) {
        const o = pos + i * 16;
        wedgePoint[i] = wide ? dv.getUint32(o, true) : dv.getUint16(o, true);
        wedgeUv[i * 2] = dv.getFloat32(o + 4, true); wedgeUv[i * 2 + 1] = dv.getFloat32(o + 8, true);
        wedgeMat[i] = bytes[o + 12];
      }
    } else if (id === 'FACE0000' || id === 'FACE3200') {
      const wide = id === 'FACE3200';
      if (size !== (wide ? 18 : 12)) throw new Error(`${name}: faces of ${size} bytes aren't known`);
      faces = new Uint32Array(count * 3); faceMaterial = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const o = pos + i * size;
        for (let k = 0; k < 3; k++) faces[i * 3 + k] = wide ? dv.getUint32(o + k * 4, true) : dv.getUint16(o + k * 2, true);
        faceMaterial[i] = bytes[o + (wide ? 12 : 6)];
      }
    } else if (id === 'MATT0000' && size === 88) {
      for (let i = 0; i < count; i++) {
        let s = '';
        for (let k = 0; k < 64 && bytes[pos + i * 88 + k]; k++) s += String.fromCharCode(bytes[pos + i * 88 + k]);
        materials.push(s || `Material ${i}`);
      }
    } else if (id === 'REFSKELT' || id === 'REFSKEL0') bones = count;
    else if (id === 'VTXNORMS' && size === 12) {
      normals = new Float32Array(count * 3);
      for (let i = 0; i < count * 3; i++) normals[i] = dv.getFloat32(pos + i * 4, true);
    }
    pos = end;
  }
  if (!points || !wedgePoint || !wedgeUv || !faces) throw new Error(`${name} isn't an ActorX model (no points, wedges or faces)`);
  if (!faceMaterial) faceMaterial = new Uint8Array(faces.length / 3).map((_, f) => wedgeMat![faces![f * 3]] ?? 0);
  let most = -1;
  for (const m of faceMaterial) most = Math.max(most, m);
  for (let i = materials.length; i <= most; i++) materials.push(`Material ${i}`);
  return { points, wedgePoint, wedgeUv, faces, faceMaterial, materials, normals, bones };
}

// ---------------------------------------------------------------------------
// material files

/** A texture's name from however a material file refers to it (`Texture2D'/Game/A/T_X.T_X'`, a path, a file name, an object). */
export function textureName(ref: unknown): string {
  let r: unknown = ref;
  if (r && typeof r === 'object') { const o = r as Record<string, unknown>; r = o.ObjectName ?? o.ObjectPath ?? o.Name ?? ''; }
  let s = String(r).trim();
  const quoted = s.match(/'([^']*)'/);
  if (quoted) s = quoted[1];
  const leaf = s.replace(/\\/g, '/').split('/').pop() ?? '';
  const file = leaf.match(/^(.+)\.(png|tga|dds|jpe?g|bmp|tiff?)$/i);
  return file ? file[1] : leaf.split('.')[0];
}

function jsonTextures(obj: unknown, out: [string, string][]): void {
  if (Array.isArray(obj)) { for (const v of obj) jsonTextures(v, out); return; }
  if (!obj || typeof obj !== 'object') return;
  const o = obj as Record<string, unknown>;
  if ('ParameterInfo' in o && 'ParameterValue' in o) {
    const info = o.ParameterInfo as Record<string, unknown> | string;
    const param = typeof info === 'object' && info ? String(info.Name ?? '') : String(info);
    if (o.ParameterValue) out.push([param, textureName(o.ParameterValue)]);
  }
  for (const [key, value] of Object.entries(o)) {
    if (key === 'Textures' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [param, ref] of Object.entries(value)) if (ref && (typeof ref === 'string' || typeof ref === 'object')) out.push([param, textureName(ref)]);
    } else if (key === 'ReferencedTextures' && Array.isArray(value)) {
      for (const r of value) if (r) out.push(['', textureName(r)]);
    } else jsonTextures(value, out);
  }
}

/** (parameter, texture name) for each texture a material file names. */
export function materialTextures(fileName: string, source: string): [string, string][] {
  const low = fileName.toLowerCase();
  const out: [string, string][] = [];
  if (low.endsWith('.json')) { try { jsonTextures(JSON.parse(source), out); } catch { /* not JSON after all */ } }
  else if (low.endsWith('.props.txt')) {
    for (const m of source.matchAll(/ParameterInfo\s*=\s*\{\s*Name\s*=\s*"?([^\s,}"]+)[\s\S]*?ParameterValue\s*=\s*([^\s,}]+)/g)) out.push([m[1], textureName(m[2])]);
  } else {
    for (const line of source.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0 && line.slice(eq + 1).trim()) out.push([line.slice(0, eq).trim(), textureName(line.slice(eq + 1))]);
    }
  }
  return out.filter(([, t]) => t && !['none', 'null'].includes(t.toLowerCase()));
}

/** Whether a material parameter holds the colour texture. */
function colourParam(p: string): boolean | null {
  if (/detail.*norm|norm.*detail|height|displace|bump|norm|nrm|spec|gloss|mask|rough|metal/i.test(p)) return false;
  if (/diff|albedo|basecolor|base_color|colou?r|^p_d$|_dif$/i.test(p)) return true;
  return null;
}

const materialFileStem = (f: string) => { const b = baseName(f).toLowerCase(); for (const e of MATERIAL_FILES) if (b.endsWith(e)) return b.slice(0, -e.length); return null; };

/** The nearest of several files to the model's folder (fewest folders apart), DDS before other pictures. */
function nearest(paths: string[]): string {
  const order = ['.dds', '.png', '.tga', '.tif', '.tiff', '.bmp', '.jpg', '.jpeg'];
  const score = (p: string) => p.split('/').filter((s) => s === '..').length * 100 + p.split('/').length * 10 + (order.indexOf(p.slice(p.lastIndexOf('.')).toLowerCase()) + 1 || 9);
  return [...paths].sort((a, b) => score(a) - score(b))[0];
}

export async function importPsk(src: FileSource): Promise<ImportedModel> {
  const psk = readPsk(src.bytes, src.name);
  const builder = new ModelBuilder();
  const listing = await src.list();
  const pictures = new Map<string, string[]>(), matFiles = new Map<string, string[]>();
  for (const f of listing) {
    if (isPicture(f)) { const k = stem(f).toLowerCase(); (pictures.get(k) ?? pictures.set(k, []).get(k)!).push(f); continue; }
    const m = materialFileStem(f);
    if (m) (matFiles.get(m) ?? matFiles.set(m, []).get(m)!).push(f);
  }
  const missing: string[] = [];
  for (const name of psk.materials) {
    const out: ModelMaterial = { name };
    let listed: [string, string][] = [];
    const files = matFiles.get(name.toLowerCase());
    if (files) {
      const file = nearest(files);
      const bytes = await src.read(file);
      if (bytes) listed = materialTextures(file, text(bytes));
    }
    let guessed = false;
    if (!listed.length) {
      // no material file: pictures named like the material
      const base = name.toLowerCase().replace(/^(mi|m|mat|mic|material)_/, '');
      if (base) for (const [k] of pictures) {
        const core = k.replace(/^(t|tex|tx)_/, '');
        if (core.startsWith(base) && /^(_[a-z0-9]+)?$/.test(core.slice(base.length))) listed.push(['', k]);
      }
      guessed = listed.length > 0;
    }
    // the colour texture: a colour parameter, else one named as a colour texture, else (guessing) one not named as anything else
    let pick = listed.find(([p, t]) => colourParam(p) === true && pictures.has(t.toLowerCase()));
    pick ??= listed.find(([p, t]) => colourParam(p) !== false && textureRole(t) === 'colour' && pictures.has(t.toLowerCase()));
    if (!pick && guessed) pick = listed.find(([, t]) => textureRole(t) === 'other' && pictures.has(t.toLowerCase()));
    if (pick) {
      const path = nearest(pictures.get(pick[1].toLowerCase())!);
      out.texture = { name: baseName(path), path, bytes: await src.read(path) };
      out.note = files ? `from its material file` : `a picture named like it`;
    } else {
      const wanted = listed.find(([p, t]) => colourParam(p) === true || textureRole(t) === 'colour');
      if (wanted) { out.texture = { name: wanted[1], path: wanted[1], bytes: null }; out.note = `its texture ${wanted[1]} wasn't found`; missing.push(wanted[1]); }
    }
    builder.addMaterial(out);
  }
  if (missing.length) builder.notes.push(`Not found beside the model: ${missing.join(', ')}. Export the textures with it (as TGA, PNG or DDS), or choose them on the Textures tab.`);
  // the triangles: each wedge its own vertex
  const nw = psk.wedgePoint.length, np = psk.points.length / 3;
  const positions = new Float32Array(nw * 3);
  for (let w = 0; w < nw; w++) {
    const p = Math.min(psk.wedgePoint[w], np - 1);
    positions[w * 3] = psk.points[p * 3]; positions[w * 3 + 1] = psk.points[p * 3 + 1]; positions[w * 3 + 2] = psk.points[p * 3 + 2];
  }
  const faces = Uint32Array.from(psk.faces);
  const N = psk.normals;
  if (N && (N.length / 3 === np || N.length / 3 === nw)) {
    // wind each face to agree with its stored normals (the mirror below keeps that agreement)
    const perPoint = N.length / 3 === np;
    for (let f = 0; f < faces.length / 3; f++) {
      const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      if (a >= nw || b >= nw || c >= nw) continue;
      const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      let d = 0;
      for (const w of [a, b, c]) { const i = (perPoint ? Math.min(psk.wedgePoint[w], np - 1) : w) * 3; d += cx * N[i] + cy * N[i + 1] + cz * N[i + 2]; }
      if (d < 0) { faces[f * 3 + 1] = c; faces[f * 3 + 2] = b; }
    }
  }
  // Unreal → right-handed: mirror Y (which turns every face round as well)
  builder.add({ positions, indices: faces, uvs: psk.wedgeUv, material: psk.faceMaterial, matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  if (psk.bones) builder.notes.push('Its skeleton is not read: it is shown in the pose it was exported in.');
  return builder.build(stem(src.name), src.name.toLowerCase().endsWith('.pskx') ? 'ActorX static mesh' : 'ActorX skeletal mesh', 'cm');
}

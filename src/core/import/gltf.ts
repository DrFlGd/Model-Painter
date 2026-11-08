// glTF 2.0 models (.gltf with its .bin and pictures, or .glb): what Blender,
// FModel and most tools export, and what Dark STL's model packages hold. A
// port of Dark STL's importers/gltf.py, simplified to what painting needs.
//
// * Every mesh of the scene, placed where its node puts it (a skinned mesh in
//   its bind pose).
// * A material's base colour texture (or the older specular-glossiness
//   diffuse texture), times its base colour factor; a material without a
//   texture is its factor's colour. Pictures may be PNG, JPEG, WebP or DDS
//   (MSFT_texture_dds), inside the file or beside it.
// * glTF is Y up with V down the picture: positions turn to Z up, UVs are kept.

import { ModelBuilder, findFile, joinPath, stem, text, type FileSource, type ImportedModel, type ModelMaterial } from '../model.ts';
import type { RGB } from '../colour.ts';

const COMPONENT: Record<number, { size: number; read: (dv: DataView, o: number) => number; max: number }> = {
  5120: { size: 1, read: (d, o) => d.getInt8(o), max: 127 },
  5121: { size: 1, read: (d, o) => d.getUint8(o), max: 255 },
  5122: { size: 2, read: (d, o) => d.getInt16(o, true), max: 32767 },
  5123: { size: 2, read: (d, o) => d.getUint16(o, true), max: 65535 },
  5125: { size: 4, read: (d, o) => d.getUint32(o, true), max: 4294967295 },
  5126: { size: 4, read: (d, o) => d.getFloat32(o, true), max: 1 },
};
const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

export async function importGltf(src: FileSource): Promise<ImportedModel> {
  let gltf: Json, binary: Uint8Array | null = null;
  const bytes = src.bytes;
  if (isGlb(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 12;
    while (pos + 8 <= bytes.length) {
      const length = dv.getUint32(pos, true), kind = dv.getUint32(pos + 4, true);
      const chunk = bytes.subarray(pos + 8, pos + 8 + length);
      if (kind === 0x4e4f534a) gltf = JSON.parse(text(chunk));
      else if (kind === 0x004e4942) binary = chunk;
      pos += 8 + length;
    }
    if (!gltf) throw new Error(`${src.name} has no glTF description`);
  } else {
    try { gltf = JSON.parse(text(bytes)); } catch (e) { throw new Error(`${src.name} isn't a glTF file (${(e as Error).message})`); }
  }
  if (!gltf || typeof gltf !== 'object' || !gltf.asset) throw new Error(`${src.name} isn't a glTF file`);
  if (!String(gltf.asset.version ?? '2.0').startsWith('2')) throw new Error(`${src.name} is glTF ${gltf.asset.version}; only glTF 2 is read`);
  for (const ext of gltf.extensionsRequired ?? []) {
    if (ext === 'KHR_draco_mesh_compression' || ext === 'EXT_meshopt_compression') {
      throw new Error(`${src.name} is compressed (${ext}), which isn't read yet: export it again without compression`);
    }
  }
  const notes: string[] = [];
  const readUri = async (uri: string, what: string): Promise<Uint8Array | null> => {
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      const head = uri.slice(0, comma), payload = uri.slice(comma + 1);
      if (head.endsWith(';base64')) {
        const bin = atob(payload);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      return new TextEncoder().encode(decodeURIComponent(payload));
    }
    const found = await findFile(src, decodeURIComponent(uri), '');
    if (!found) notes.push(`${what} ${decodeURIComponent(uri)} wasn't found beside the model.`);
    return found?.bytes ?? null;
  };
  const buffers: (Uint8Array | null)[] = [];
  for (const [i, b] of (gltf.buffers ?? []).entries()) {
    if (b.uri === undefined) {
      if (!binary) throw new Error(`${src.name}: buffer ${i} has no data`);
      buffers.push(binary);
    } else buffers.push(await readUri(b.uri, 'Its data file'));
  }
  const view = (index: number): Uint8Array => {
    const v = gltf.bufferViews[index];
    const buf = buffers[v.buffer];
    if (!buf) throw new Error(`${src.name}: its data file is missing`);
    return buf.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  };
  /** an accessor's numbers, flat, as floats (normalized integers scaled to 0..1 or −1..1) */
  const accessor = (index: number): Float32Array | Uint32Array => {
    const a = gltf.accessors[index];
    const comp = COMPONENT[a.componentType], width = WIDTH[a.type];
    if (!comp || !width) throw new Error(`${src.name}: accessor ${index} has an unknown type`);
    const count = a.count;
    const integer = a.componentType !== 5126 && !a.normalized;
    const out = integer ? new Uint32Array(count * width) : new Float32Array(count * width);
    const scale = a.normalized ? 1 / comp.max : 1;
    if (a.bufferView !== undefined) {
      const v = gltf.bufferViews[a.bufferView];
      const data = view(a.bufferView);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const stride = v.byteStride || comp.size * width;
      const start = a.byteOffset ?? 0;
      for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) {
        const x = comp.read(dv, start + i * stride + k * comp.size) * scale;
        out[i * width + k] = a.normalized ? Math.max(x, -1) : x;
      }
    }
    if (a.sparse) {
      const s = a.sparse;
      const ic = COMPONENT[s.indices.componentType], idata = view(s.indices.bufferView);
      const idv = new DataView(idata.buffer, idata.byteOffset, idata.byteLength);
      const vdata = view(s.values.bufferView);
      const vdv = new DataView(vdata.buffer, vdata.byteOffset, vdata.byteLength);
      for (let i = 0; i < s.count; i++) {
        const at = ic.read(idv, (s.indices.byteOffset ?? 0) + i * ic.size);
        for (let k = 0; k < width; k++) out[at * width + k] = comp.read(vdv, (s.values.byteOffset ?? 0) + (i * width + k) * comp.size) * scale;
      }
    }
    return out;
  };

  // materials
  const builder = new ModelBuilder();
  const textures = new Map<number, Promise<{ name: string; path: string; bytes: Uint8Array | null } | null>>();
  const textureOf = (index: number | undefined) => {
    if (index === undefined) return Promise.resolve(null);
    let t = textures.get(index);
    if (!t) {
      t = (async () => {
        const tex = gltf.textures?.[index];
        if (!tex) return null;
        const source = tex.extensions?.MSFT_texture_dds?.source ?? tex.source ?? tex.extensions?.EXT_texture_webp?.source;
        const img = gltf.images?.[source];
        if (!img) return null;
        const name = img.name || (img.uri && !img.uri.startsWith('data:') ? decodeURIComponent(img.uri).replace(/\\/g, '/').split('/').pop() : `${stem(src.name)} picture ${source}`);
        if (img.bufferView !== undefined) return { name, path: '', bytes: view(img.bufferView).slice() };
        if (!img.uri) return { name, path: '', bytes: null };
        if (img.uri.startsWith('data:')) return { name, path: '', bytes: await readUri(img.uri, 'Its picture') };
        const found = await findFile(src, decodeURIComponent(img.uri), '');
        return { name, path: found?.path ?? joinPath('', decodeURIComponent(img.uri)), bytes: found?.bytes ?? null };
      })();
      textures.set(index, t);
    }
    return t;
  };
  const materialIndex = new Map<number, number>();
  const materialFor = async (index: number | undefined): Promise<number> => {
    const key = index ?? -1;
    const known = materialIndex.get(key);
    if (known !== undefined) return known;
    const m = index !== undefined ? gltf.materials?.[index] : undefined;
    const out: ModelMaterial = { name: m?.name || (index !== undefined ? `Material ${index}` : 'Model') };
    const pbr = m?.pbrMetallicRoughness;
    const sg = m?.extensions?.KHR_materials_pbrSpecularGlossiness;
    const factor: number[] | undefined = pbr?.baseColorFactor ?? sg?.diffuseFactor;
    const info = pbr?.baseColorTexture ?? sg?.diffuseTexture;
    const tint: RGB | undefined = factor && factor.slice(0, 3).some((v) => v < 0.999) ? factor.slice(0, 3).map((v) => Math.round(linearToSrgb(v) * 255)) as RGB : undefined;
    if (info) {
      const tex = await textureOf(info.index);
      if (tex) {
        out.texture = tex;
        if (!tex.bytes) out.note = `its texture ${tex.name} wasn't found`;
        if ((info.texCoord ?? 0) !== 0) out.note = `its texture uses the second UV set, which isn't read`;
      }
      if (tint) out.tint = tint;
    }
    // without a factor glTF's base colour is white
    out.colour = factor ? factor.slice(0, 3).map((v) => Math.round(linearToSrgb(v) * 255)) as RGB : [255, 255, 255];
    const i = builder.addMaterial(out);
    materialIndex.set(key, i);
    return i;
  };

  // the scene's meshes, placed
  const nodes: Json[] = gltf.nodes ?? [];
  const scenes: Json[] = gltf.scenes ?? [];
  let roots: number[];
  if (scenes.length) roots = scenes[gltf.scene ?? 0]?.nodes ?? scenes[0].nodes ?? [];
  else { const kids = new Set(nodes.flatMap((n) => n.children ?? [])); roots = nodes.map((_, i) => i).filter((i) => !kids.has(i)); }
  const placed: { mesh: number; matrix: number[] }[] = [];
  const seen = new Set<number>();
  const visit = (i: number, parent: number[]) => {
    if (seen.has(i) || !nodes[i]) return;
    seen.add(i);
    const world = mul(parent, nodeMatrix(nodes[i]));
    if (nodes[i].mesh !== undefined) placed.push({ mesh: nodes[i].mesh, matrix: world });
    for (const c of nodes[i].children ?? []) visit(c, world);
  };
  // Y up to Z up: (x, y, z) → (x, −z, y)
  const zUp = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  for (const r of roots) visit(r, zUp);
  if (!placed.length && !scenes.length) (gltf.meshes ?? []).forEach((_: Json, i: number) => placed.push({ mesh: i, matrix: zUp }));
  let skipped = 0;
  for (const { mesh, matrix } of placed) {
    for (const prim of gltf.meshes?.[mesh]?.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode < 4 || prim.attributes?.POSITION === undefined) { skipped++; continue; }
      if (prim.extensions?.KHR_draco_mesh_compression) { skipped++; continue; }
      const positions = accessor(prim.attributes.POSITION);
      const n = positions.length / 3;
      let indices: ArrayLike<number> = prim.indices !== undefined ? accessor(prim.indices) : Uint32Array.from({ length: n }, (_, i) => i);
      if (mode === 5) indices = strip(indices);
      else if (mode === 6) indices = fan(indices);
      const uvs = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0) : null;
      let colours: Float32Array | Uint32Array | null = null, width = 3;
      if (prim.attributes.COLOR_0 !== undefined) {
        colours = accessor(prim.attributes.COLOR_0);
        width = gltf.accessors[prim.attributes.COLOR_0].type === 'VEC4' ? 4 : 3;
        // vertex colours are linear in glTF
        for (let i = 0; i < colours.length; i++) if (i % width < 3) colours[i] = linearToSrgb(colours[i]);
      }
      const material = await materialFor(prim.material);
      builder.add({ positions, indices, uvs, colours, colourWidth: width, colourScale: 1, material, matrix });
    }
  }
  if (skipped) notes.push(`${skipped} parts that aren't triangles (or are compressed) were left out.`);
  builder.notes.push(...notes);
  return builder.build(stem(src.name), isGlb(bytes) ? 'glTF (GLB)' : 'glTF', 'm');
}

function strip(I: ArrayLike<number>): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i + 2 < I.length; i++) {
    if (i % 2 === 0) out.push(I[i], I[i + 1], I[i + 2]); else out.push(I[i + 1], I[i], I[i + 2]);
  }
  return Uint32Array.from(out);
}

function fan(I: ArrayLike<number>): Uint32Array {
  const out: number[] = [];
  for (let i = 1; i + 1 < I.length; i++) out.push(I[0], I[i], I[i + 1]);
  return Uint32Array.from(out);
}

/** A node's local matrix, column-major. */
function nodeMatrix(n: Json): number[] {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** a · b, column-major 4 × 4. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
}

const linearToSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * Math.max(0, v) : 1.055 * Math.min(1, v) ** (1 / 2.4) - 0.055);

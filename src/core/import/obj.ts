// Wavefront OBJ models with their MTL materials (a port of Dark STL's
// importers/wavefront.py). A material's `map_Kd` is its colour texture and
// `Kd` its flat colour; vertex colours (`v x y z r g b`) are read too.
// OBJ is Y up with V up the picture: positions turn to Z up and V is flipped.
// OBJ has no units: metres unless the model is too big for that.

import { ModelBuilder, findFile, joinPath, stem, text, type FileSource, type ImportedModel, type ModelMaterial } from '../model.ts';
import type { RGB } from '../colour.ts';

// options of MTL texture statements and how many values each takes at most
const MAP_OPTIONS: Record<string, number> = { '-blendu': 1, '-blendv': 1, '-bm': 1, '-boost': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1, '-mm': 2, '-texres': 1, '-type': 1, '-o': 3, '-s': 3, '-t': 3 };

/** The file a texture statement names, after its options. */
export function mapFile(rest: string): string {
  const tokens = rest.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length - 1 && MAP_OPTIONS[tokens[i]] !== undefined) {
    const option = tokens[i++], n = MAP_OPTIONS[option];
    // on/off, a channel letter or a kind of map: one word
    if (['-blendu', '-blendv', '-cc', '-clamp', '-imfchan', '-type'].includes(option)) { if (i < tokens.length - 1) i++; continue; }
    for (let k = 0; k < n && i < tokens.length - 1 && /^-?[\d.]+(e-?\d+)?$/i.test(tokens[i]); k++) i++;
  }
  return tokens.slice(i).join(' ');
}

interface Mtl { name: string; kd?: RGB; map?: string }

function parseMtl(src: string): Map<string, Mtl> {
  const out = new Map<string, Mtl>();
  let cur: Mtl | null = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.search(/\s/);
    const tag = (sp < 0 ? line : line.slice(0, sp)).toLowerCase(), rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (tag === 'newmtl') { cur = { name: rest }; out.set(rest, cur); }
    else if (!cur) continue;
    else if (tag === 'kd') {
      const v = rest.split(/\s+/).map(Number);
      if (v.length >= 3 && v.every(Number.isFinite)) cur.kd = v.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)) as RGB;
    } else if (tag === 'map_kd' || (tag === 'map_basecolor' && !cur.map)) cur.map = mapFile(rest);
  }
  return out;
}

export async function importObj(src: FileSource): Promise<ImportedModel> {
  const source = text(src.bytes);
  const v: number[] = [], vt: number[] = [], vc: number[] = [];
  let anyColour = false;
  const corners: number[] = []; // (v, vt) per triangle corner, 0-based, −1 for none
  const faceMaterial: number[] = [];
  const materialNames: string[] = [];
  const materialIds = new Map<string, number>();
  const mtllibs: string[] = [];
  let material = -1;
  let unitsPerMetre: number | null = null;
  const index = (tok: string | undefined, count: number) => {
    if (!tok) return -1;
    const i = parseInt(tok, 10);
    return Number.isNaN(i) ? -1 : i > 0 ? i - 1 : count + i;
  };
  let pending = '';
  const refs: [number, number][] = [];
  for (const raw of source.split(/\r?\n/)) {
    let line = pending + raw;
    if (line.endsWith('\\')) { pending = line.slice(0, -1) + ' '; continue; }
    pending = '';
    line = line.trim();
    if (!line) continue;
    if (line[0] === '#') {
      const m = line.match(/([\d.]+)\s+units per metre/);
      if (m) unitsPerMetre = parseFloat(m[1]);
      continue;
    }
    const sp = line.search(/\s/);
    const tag = sp < 0 ? line : line.slice(0, sp), rest = sp < 0 ? '' : line.slice(sp + 1);
    if (tag === 'v') {
      const n = rest.trim().split(/\s+/).map(Number);
      v.push(n[0] || 0, n[1] || 0, n[2] || 0);
      if (n.length >= 6) { anyColour = true; vc.push(n[3], n[4], n[5]); } else vc.push(1, 1, 1);
    } else if (tag === 'vt') {
      const n = rest.trim().split(/\s+/).map(Number);
      vt.push(n[0] || 0, 1 - (n[1] || 0)); // V up → V down
    } else if (tag === 'f') {
      refs.length = 0;
      const nv = v.length / 3, nt = vt.length / 2;
      for (const tok of rest.trim().split(/\s+/)) {
        const parts = tok.split('/');
        refs.push([index(parts[0], nv), index(parts[1], nt)]);
      }
      if (material < 0) { material = 0; if (!materialNames.length) { materialNames.push(''); materialIds.set('', 0); } }
      for (let k = 1; k + 1 < refs.length; k++) {
        corners.push(refs[0][0], refs[0][1], refs[k][0], refs[k][1], refs[k + 1][0], refs[k + 1][1]);
        faceMaterial.push(material);
      }
    } else if (tag === 'usemtl') {
      const name = rest.trim();
      let id = materialIds.get(name);
      if (id === undefined) { id = materialNames.length; materialIds.set(name, id); materialNames.push(name); }
      material = id;
    } else if (tag === 'mtllib') mtllibs.push(rest.trim());
  }
  if (!faceMaterial.length) throw new Error(`${src.name} has no faces`);
  // materials
  const builder = new ModelBuilder();
  const mtl = new Map<string, Mtl>();
  for (const lib of mtllibs) {
    let found = await findFile(src, lib, '');
    // a name with spaces may have been split into several libraries
    if (!found && /\s/.test(lib)) for (const part of lib.split(/\s+/)) { found = await findFile(src, part, ''); if (found) break; }
    if (!found) { builder.notes.push(`Its materials file ${lib} wasn't found beside it.`); continue; }
    const folder = found.path.includes('/') ? found.path.slice(0, found.path.lastIndexOf('/')) : '';
    for (const [k, m] of parseMtl(text(found.bytes))) {
      if (m.map) m.map = joinPath(folder, m.map.replace(/\\/g, '/'));
      mtl.set(k, m);
    }
  }
  if (!mtllibs.length) {
    // a model saved without its library may still have one of its own name beside it
    const own = await findFile(src, `${stem(src.name)}.mtl`, '');
    if (own) for (const [k, m] of parseMtl(text(own.bytes))) mtl.set(k, m);
  }
  const listing = await src.list();
  for (const name of materialNames) {
    const m = mtl.get(name);
    const out: ModelMaterial = { name: name || 'Model' };
    if (m?.kd) out.colour = m.kd;
    if (m?.map) {
      const found = await findFile(src, m.map, '', listing);
      out.texture = { name: m.map.split('/').pop()!, path: found?.path ?? m.map, bytes: found?.bytes ?? null };
      if (!found) out.note = `its texture ${m.map} wasn't found`;
    }
    builder.addMaterial(out);
  }
  // corners → per-vertex arrays of a triangle soup (each corner its own vertex), Y up → Z up
  const n = faceMaterial.length;
  const positions = new Float32Array(n * 9), uvs = vt.length ? new Float32Array(n * 6) : null;
  const colours = anyColour ? new Float32Array(n * 9) : null;
  const nv = v.length / 3;
  for (let c = 0; c < n * 3; c++) {
    let p = corners[c * 2];
    if (p < 0 || p >= nv) p = 0;
    positions[c * 3] = v[p * 3]; positions[c * 3 + 1] = -v[p * 3 + 2]; positions[c * 3 + 2] = v[p * 3 + 1];
    if (colours) { colours[c * 3] = vc[p * 3]; colours[c * 3 + 1] = vc[p * 3 + 1]; colours[c * 3 + 2] = vc[p * 3 + 2]; }
    const t = corners[c * 2 + 1];
    if (uvs && t >= 0 && t < vt.length / 2) { uvs[c * 2] = vt[t * 2]; uvs[c * 2 + 1] = vt[t * 2 + 1]; }
  }
  builder.add({ positions, uvs, colours, colourScale: 1, material: faceMaterial });
  const model = builder.build(stem(src.name), 'Wavefront OBJ', 'm');
  if (unitsPerMetre === 1000) model.units = 'mm';
  return model;
}

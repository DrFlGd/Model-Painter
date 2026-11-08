// 3MF models, plain or slicer projects (Bambu Studio, OrcaSlicer,
// PrusaSlicer, and this app's and Dark STL's painted exports), with the paint
// on their triangles (`paint_color`, `slic3rpe:mmu_segmentation`) and their
// colours (this app's palette, the slicer's filament colours, or the model's
// own material colours). Every printed part of the build becomes one mesh,
// placed as the build places it; holes and modifiers are left out.
//
// The XML is read straight from its bytes rather than as one string: a model
// painted from a texture holds millions of triangles, hundreds of megabytes
// of text. Pure.

import { unzip } from '../zip-read.ts';
import { decodePaint, encodePaint, codeSplits, walkCode } from '../paint-tree.ts';
import { ModelBuilder, stem, type FileSource, type ImportedModel } from '../model.ts';
import { parseHex, type RGB } from '../colour.ts';

/** 3MF transform: 12 numbers, row vectors (p' = p·M + t). */
type Xf = number[];
const IDENTITY: Xf = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface RawObject {
  id: string;
  type: string;
  name: string;
  positions: Float32Array | null;
  triangles: Uint32Array | null;
  /** paint code per triangle ('' = none) */
  codes: string[] | null;
  /** colour group index per triangle from pid/p1 (−1 none) */
  groupColour: Int32Array | null;
  pid?: string;
  pindex?: number;
  components: { objectId: string; path?: string; transform: Xf }[];
}

interface ModelFile {
  objects: Map<string, RawObject>;
  items: { objectId: string; path?: string; transform: Xf }[];
  groups: Map<string, string[]>;
  metadata: Map<string, string>;
}

// ---------------------------------------------------------------------------
// reading XML from its bytes

const LT = 60, GT = 62, SLASH = 47, QUOTE = 34, APOS = 39, EQ = 61;
const latin = (b: Uint8Array, s: number, e: number) => { let out = ''; for (let i = s; i < e; i++) out += String.fromCharCode(b[i]); return out; };
const utf8 = new TextDecoder();

/** A number written in the bytes from `s` to `e`. */
function num(b: Uint8Array, s: number, e: number): number {
  let i = s, sign = 1, v = 0;
  if (b[i] === 45) { sign = -1; i++; } else if (b[i] === 43) i++;
  while (i < e && b[i] >= 48 && b[i] <= 57) v = v * 10 + (b[i++] - 48);
  if (i < e && b[i] === 46) {
    i++;
    let f = 0.1;
    while (i < e && b[i] >= 48 && b[i] <= 57) { v += (b[i++] - 48) * f; f *= 0.1; }
  }
  if (i < e && (b[i] === 101 || b[i] === 69)) return sign * v * 10 ** Number(latin(b, i + 1, e));
  return sign * v;
}

/** Calls `attr` with each attribute of a tag: its name and where its value lies. */
function attributes(b: Uint8Array, s: number, e: number, attr: (name: string, vs: number, ve: number) => void) {
  let i = s;
  while (i < e) {
    while (i < e && b[i] <= 32) i++;
    const ns = i;
    while (i < e && b[i] !== EQ && b[i] > 32 && b[i] !== SLASH) i++;
    if (i >= e || b[i] !== EQ) { i++; continue; }
    const name = latin(b, ns, i);
    i++;
    while (i < e && b[i] <= 32) i++;
    const q = b[i];
    if (q !== QUOTE && q !== APOS) continue;
    const vs = ++i;
    while (i < e && b[i] !== q) i++;
    attr(name, vs, i);
    i++;
  }
}

function attrMap(b: Uint8Array, s: number, e: number): Record<string, string> {
  const out: Record<string, string> = {};
  attributes(b, s, e, (n, vs, ve) => { out[n] = unescape(utf8.decode(b.subarray(vs, ve))); });
  return out;
}

const unescape = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, k: string) => {
  const map: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[k.toLowerCase()]) return map[k.toLowerCase()];
  return String.fromCodePoint(k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});

function parseXf(s?: string): Xf {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 12 && n.every(Number.isFinite) ? n : IDENTITY;
}

/** first `a` then `b` */
function compose(a: Xf, b: Xf): Xf {
  const r: Xf = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

/** One .model file: its objects, build items, colour groups and metadata. */
function parseModel(b: Uint8Array): ModelFile {
  const objects = new Map<string, RawObject>();
  const items: ModelFile['items'] = [];
  const groups = new Map<string, string[]>();
  const metadata = new Map<string, string>();
  let obj: RawObject | null = null;
  let verts: number[] = [], tris: number[] = [], codes: string[] = [], gcol: number[] = [];
  let anyCode = false, anyGroup = false;
  let group: string[] | null = null;
  let metaName: string | null = null, metaStart = 0;
  let i = 0;
  const n = b.length;
  while (i < n) {
    const lt = b.indexOf(LT, i);
    if (lt < 0) break;
    const gt = b.indexOf(GT, lt);
    if (gt < 0) break;
    i = gt + 1;
    let s = lt + 1;
    const closing = b[s] === SLASH;
    if (closing) s++;
    if (b[s] === 63 || b[s] === 33) continue; // <? ?> and <! -->
    let ne = s;
    while (ne < gt && b[ne] > 32 && b[ne] !== SLASH) ne++;
    // the hot tags first, without making their names
    const c0 = b[s];
    if (!closing && c0 === 118 && ne - s === 6) { // vertex
      let x = 0, y = 0, z = 0;
      attributes(b, ne, gt, (name, vs, ve) => { const v = num(b, vs, ve); if (name === 'x') x = v; else if (name === 'y') y = v; else if (name === 'z') z = v; });
      verts.push(x, y, z);
      continue;
    }
    if (!closing && c0 === 116 && ne - s === 8) { // triangle
      let v1 = 0, v2 = 0, v3 = 0, code = '', pid: string | null = null, p1 = -1;
      attributes(b, ne, gt, (name, vs, ve) => {
        if (name === 'v1') v1 = num(b, vs, ve);
        else if (name === 'v2') v2 = num(b, vs, ve);
        else if (name === 'v3') v3 = num(b, vs, ve);
        else if (name === 'paint_color' || name === 'slic3rpe:mmu_segmentation') { if (!code) code = latin(b, vs, ve); }
        else if (name === 'pid') pid = latin(b, vs, ve);
        else if (name === 'p1') p1 = num(b, vs, ve);
      });
      tris.push(v1, v2, v3);
      codes.push(code);
      if (code) anyCode = true;
      if (p1 >= 0 || pid !== null) anyGroup = true;
      gcol.push(p1 >= 0 ? p1 : -1);
      continue;
    }
    const name = latin(b, s, ne);
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    if (closing) {
      if (local === 'object' && obj) {
        if (tris.length) {
          obj.positions = Float32Array.from(verts);
          obj.triangles = Uint32Array.from(tris);
          if (anyCode) obj.codes = codes;
          if (anyGroup) obj.groupColour = Int32Array.from(gcol);
        }
        objects.set(obj.id, obj);
        obj = null;
      } else if ((local === 'basematerials' || local === 'colorgroup')) group = null;
      else if (local === 'metadata' && metaName !== null) {
        metadata.set(metaName, unescape(utf8.decode(b.subarray(metaStart, lt))).trim());
        metaName = null;
      }
      continue;
    }
    const self = b[gt - 1] === SLASH;
    const a = attrMap(b, ne, self ? gt - 1 : gt);
    if (local === 'object') {
      obj = { id: a.id, type: a.type ?? 'model', name: a.name ?? '', positions: null, triangles: null, codes: null, groupColour: null, components: [] };
      if (a.pid !== undefined) { obj.pid = a.pid; obj.pindex = a.pindex !== undefined ? Number(a.pindex) : 0; }
      verts = []; tris = []; codes = []; gcol = []; anyCode = false; anyGroup = false;
      if (self) { objects.set(obj.id, obj); obj = null; }
    } else if (local === 'component' && obj) obj.components.push({ objectId: a.objectid, path: a['p:path'], transform: parseXf(a.transform) });
    else if (local === 'item') items.push({ objectId: a.objectid, path: a['p:path'], transform: parseXf(a.transform) });
    else if (local === 'basematerials' || local === 'colorgroup') { group = []; groups.set(a.id, group); if (self) group = null; }
    else if (local === 'base' && group) group.push(a.displaycolor ?? '#FFFFFF');
    else if (local === 'color' && group) group.push(a.color ?? '#FFFFFF');
    else if (local === 'metadata' && !obj && a.name !== undefined && !self) { metaName = a.name; metaStart = gt + 1; }
  }
  return { objects, items, groups, metadata };
}

// ---------------------------------------------------------------------------
// the slicers' settings

/** Per object id of the root model: its name, its own filament, its parts' filaments and kinds (Bambu/Orca model_settings.config). */
function bambuSettings(xml: string | undefined) {
  const objects = new Map<string, { extruder?: number; parts: Map<string, { extruder?: number; subtype?: string }> }>();
  if (!xml) return objects;
  for (const o of xml.matchAll(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const head = o[2].split('<part')[0];
    const ex = head.match(/<metadata key="extruder" value="(\d+)"/)?.[1];
    const parts = new Map<string, { extruder?: number; subtype?: string }>();
    for (const p of o[2].matchAll(/<part\s+id="(\d+)"(?:\s+subtype="(\w+)")?[^>]*>([\s\S]*?)<\/part>/g)) {
      const pe = p[3].match(/<metadata key="extruder" value="(\d+)"/)?.[1];
      parts.set(p[1], { extruder: pe ? Number(pe) : undefined, subtype: p[2] });
    }
    objects.set(o[1], { extruder: ex ? Number(ex) : undefined, parts });
  }
  return objects;
}

/** Per object (by its place in the root model, from 1), its filament and its volumes' kinds (PrusaSlicer Slic3r_PE_model.config). */
function prusaSettings(xml: string | undefined) {
  const objects = new Map<string, { extruder?: number; volumes: { first: number; last: number; extruder?: number; type?: string }[] }>();
  if (!xml) return objects;
  for (const o of xml.matchAll(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const head = o[2].split('<volume')[0];
    const ex = head.match(/key="extruder" value="(\d+)"/)?.[1];
    const volumes = [...o[2].matchAll(/<volume\s+firstid="(\d+)"\s+lastid="(\d+)"[^>]*>([\s\S]*?)<\/volume>/g)].map((v) => ({
      first: Number(v[1]), last: Number(v[2]),
      extruder: v[3].match(/key="extruder" value="(\d+)"/) ? Number(v[3].match(/key="extruder" value="(\d+)"/)![1]) : undefined,
      type: v[3].match(/key="volume_type" value="(\w+)"/)?.[1],
    }));
    objects.set(o[1], { extruder: ex ? Number(ex) : undefined, volumes });
  }
  return objects;
}

const hexList = (s: string) => [...s.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => parseHex(m[0]));

/** The filament colours a project's settings hold: Bambu/Orca's JSON, or PrusaSlicer's ini. */
function settingsColours(files: Map<string, Uint8Array>): RGB[] {
  const get = (end: string) => { for (const [k, v] of files) if (k.toLowerCase().endsWith(end)) return utf8.decode(v); return undefined; };
  const bambu = get('project_settings.config');
  const m = bambu?.match(/"filament_colour"\s*:\s*\[([^\]]*)\]/);
  if (m) return hexList(m[1]);
  const prusa = get('slic3r_pe.config');
  const e = prusa?.match(/;\s*extruder_colour\s*=\s*(.*)/)?.[1];
  const f = prusa?.match(/;\s*filament_colour\s*=\s*(.*)/)?.[1];
  // PrusaSlicer leaves an extruder's colour empty to use its filament's
  if (e || f) {
    const ex = (e ?? '').split(';'), fi = (f ?? '').split(';');
    return Array.from({ length: Math.max(ex.length, fi.length) }, (_, i) => /#[0-9a-f]{6}/i.test(ex[i] ?? '') ? parseHex(ex[i].trim()) : /#[0-9a-f]{6}/i.test(fi[i] ?? '') ? parseHex(fi[i].trim()) : [128, 128, 128] as RGB);
  }
  return [];
}

// ---------------------------------------------------------------------------

export async function import3mf(src: FileSource): Promise<ImportedModel> {
  const files = await unzip(src.bytes);
  const models = new Map<string, ModelFile>();
  let root = '';
  for (const [name, bytes] of files) {
    if (!name.toLowerCase().endsWith('.model')) continue;
    const path = '/' + name.replace(/^\/+/, '');
    const m = parseModel(bytes);
    models.set(path, m);
    if (m.items.length && (!root || path.toLowerCase() === '/3d/3dmodel.model')) root = path;
  }
  if (!root) throw new Error(`${src.name} has nothing to print in it`);
  const rootModel = models.get(root)!;
  const settingsFile = (end: string) => { for (const [k, v] of files) if (k.toLowerCase().endsWith(end)) return utf8.decode(v); return undefined; };
  const bambu = bambuSettings(settingsFile('model_settings.config'));
  const prusa = prusaSettings(settingsFile('slic3r_pe_model.config'));
  // the colours: this app's palette, Dark STL's, the slicer's filaments, the model's own colour group
  const own = rootModel.metadata.get('ModelPainter:Palette') ?? rootModel.metadata.get('DarkSTL:Palette');
  let palette: RGB[] = own ? hexList(own) : settingsColours(files);
  const builder = new ModelBuilder();
  const notes = builder.notes;
  let painted = false, groupColours: string[] | null = null;
  // per triangle added: its filament (0 = the object's), its code
  const faceFilament: number[] = [];
  const faceCode: (string | undefined)[] = [];
  let skipped = 0, mirroredPaint = false;
  const visit = (objectId: string, path: string, xf: Xf, top: string, depth: number) => {
    const file = models.get(path) ?? models.get(path.toLowerCase());
    const o = file?.objects.get(objectId);
    if (!o || depth > 16) throw new Error(`${src.name} names an object (${objectId}) it doesn't have`);
    if (o.positions && o.triangles) {
      const b = bambu.get(top)?.parts.get(objectId);
      const kind = b?.subtype ?? (o.type === 'other' ? 'negative_part' : 'normal_part');
      if (kind !== 'normal_part' && kind !== 'ModelPart') { skipped++; }
      else {
        const objectFilament = b?.extruder ?? bambu.get(top)?.extruder ?? prusa.get(top)?.extruder ?? 1;
        const nt = o.triangles.length / 3, nv = o.positions.length / 3;
        const group = o.pid !== undefined ? file!.groups.get(o.pid) : undefined;
        if (group && !groupColours) groupColours = group;
        const pv = prusa.get(top)?.volumes;
        const tris: number[] = [];
        for (let t = 0; t < nt; t++) {
          const a = o.triangles[t * 3], bb = o.triangles[t * 3 + 1], c = o.triangles[t * 3 + 2];
          if (a >= nv || bb >= nv || c >= nv) continue;
          tris.push(a, bb, c);
          let filament = objectFilament;
          const vol = pv?.find((v) => t >= v.first && t <= v.last);
          if (vol?.extruder) filament = vol.extruder;
          if (group) filament = (o.groupColour && o.groupColour[t] >= 0 ? o.groupColour[t] : o.pindex ?? 0) + 1;
          let code = o.codes?.[t] || undefined;
          if (code) {
            painted = true;
            if (!codeSplits(code)) { const tree = decodePaint(code); filament = tree && tree.material ? tree.material : filament; code = undefined; }
            else if (filament !== 1) {
              // unpainted leaves print in the object's filament
              const tree = decodePaint(code);
              if (tree) code = encodePaint(tree, (m) => (m === 0 ? filament : m));
            }
          }
          faceFilament.push(filament);
          faceCode.push(code);
        }
        // 3MF rows → a column-major 4 × 4
        const m = [xf[0], xf[1], xf[2], 0, xf[3], xf[4], xf[5], 0, xf[6], xf[7], xf[8], 0, xf[9], xf[10], xf[11], 1];
        const det = xf[0] * (xf[4] * xf[8] - xf[5] * xf[7]) - xf[1] * (xf[3] * xf[8] - xf[5] * xf[6]) + xf[2] * (xf[3] * xf[7] - xf[4] * xf[6]);
        if (det < 0 && o.codes?.some((c) => c && codeSplits(c))) mirroredPaint = true;
        builder.add({ positions: o.positions, indices: tris, material: 0, matrix: m });
      }
    }
    for (const c of o.components) visit(c.objectId, c.path ?? path, compose(c.transform, xf), top, depth + 1);
  };
  for (const item of rootModel.items) visit(item.objectId, item.path ?? root, item.transform, item.objectId, 0);
  if (skipped) notes.push(`${skipped} holes and modifiers were left out.`);
  if (mirroredPaint) notes.push('A part placed mirrored has paint inside its triangles, which comes in mirrored the wrong way round there.');
  if (!palette.length && groupColours) palette = (groupColours as string[]).map((c) => (/^#[0-9a-f]{6}/i.test(c) ? parseHex(c.slice(0, 7)) : [255, 255, 255] as RGB));
  builder.addMaterial({ name: stem(src.name), colour: palette[0] ?? [230, 230, 230] });
  const model = builder.build(stem(src.name), '3MF', 'mm');
  const kept = builder.kept!;
  let most = 1;
  for (const f of faceFilament) most = Math.max(most, f);
  for (const c of faceCode) if (c) walkCode(c, (_w, s) => { if (s > most) most = s; });
  if (painted || most > 1 || groupColours) {
    const n = kept.length;
    const fm = new Uint8Array(n);
    const codes = new Map<number, string>();
    for (let f = 0; f < n; f++) {
      const src0 = kept[f];
      fm[f] = Math.max(0, Math.min(255, faceFilament[src0] - 1));
      const code = faceCode[src0];
      if (code) codes.set(f, code);
    }
    while (palette.length < most) palette.push(DEFAULT_FILAMENTS[palette.length % DEFAULT_FILAMENTS.length]);
    model.paint = { faceMaterial: fm, codes, palette: palette.slice(0, Math.max(most, 1)) };
  }
  return model;
}

/** Colours for filaments a file paints with but names no colour for. */
const DEFAULT_FILAMENTS: RGB[] = [[240, 240, 240], [30, 30, 30], [200, 40, 40], [40, 90, 200], [240, 200, 40], [40, 160, 70], [230, 120, 30], [140, 60, 170]];

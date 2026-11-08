// What the app saves: the painted 3MF the slicers read (Dark STL's proven
// layout: one object, every triangle carrying its paint as Bambu Studio and
// OrcaSlicer (`paint_color`) and PrusaSlicer (`slic3rpe:mmu_segmentation`)
// keep it, filament n being the palette's nth colour, the palette in the
// metadata), a 3MF of one solid part per colour, and STL. Pure.

import type { IndexedMesh } from './mesh.ts';
import { toHex, type RGB } from './colour.ts';
import { ZipWriter } from './zip-write.ts';
import { leafCode } from './paint-tree.ts';

const MODEL_OPEN = '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n';
const BLOCK = 8192;

export const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number) => { const r = Math.round(n * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };

function* vertices(P: Float32Array): Generator<string> {
  for (let s = 0; s < P.length; s += BLOCK * 3) {
    let out = '';
    const e = Math.min(P.length, s + BLOCK * 3);
    for (let i = s; i < e; i += 3) out += `     <vertex x="${num(P[i])}" y="${num(P[i + 1])}" z="${num(P[i + 2])}"/>\n`;
    yield out;
  }
}

function* triangles(T: Uint32Array, code: (f: number) => string | undefined): Generator<string> {
  for (let s = 0; s < T.length; s += BLOCK * 3) {
    let out = '';
    const e = Math.min(T.length, s + BLOCK * 3);
    for (let i = s; i < e; i += 3) {
      const c = code(i / 3);
      out += c ? `     <triangle v1="${T[i]}" v2="${T[i + 1]}" v3="${T[i + 2]}" paint_color="${c}" slic3rpe:mmu_segmentation="${c}"/>\n` : `     <triangle v1="${T[i]}" v2="${T[i + 1]}" v3="${T[i + 2]}"/>\n`;
    }
    yield out;
  }
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="config" ContentType="text/xml"/>\n</Types>\n';

const rels = (thumbnail: boolean) => '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
  + (thumbnail ? ' <Relationship Target="/Metadata/thumbnail.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n' : '')
  + '</Relationships>\n';

function head(name: string, palette: RGB[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + MODEL_OPEN
    + ' <metadata name="Application">Model Painter</metadata>\n'
    + ` <metadata name="Title">${escapeXml(name)}</metadata>\n`
    + ' <metadata name="slic3rpe:Version3mf">1</metadata>\n'
    + ' <metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n'
    + ` <metadata name="ModelPainter:Palette">${palette.map(toHex).join(';')}</metadata>\n`;
}

export interface PaintedModel {
  name: string;
  /** at print size, in millimetres, Z up */
  mesh: IndexedMesh;
  /** every triangle's slicer code ('' for the first filament all over) */
  codes: ArrayLike<string | undefined>;
  palette: RGB[];
  /** a PNG of the model for the slicer's file list */
  thumbnail?: Uint8Array | null;
}

/** The painted 3MF, as pieces of the file. */
export async function painted3mf(m: PaintedModel): Promise<Uint8Array[]> {
  const name = m.name || 'model';
  const zip = new ZipWriter();
  const n = m.mesh.triangles.length / 3;
  await zip.add('[Content_Types].xml', [CONTENT_TYPES]);
  await zip.add('_rels/.rels', [rels(!!m.thumbnail)]);
  async function* model() {
    yield head(name, m.palette) + ` <resources>\n  <object id="1" name="${escapeXml(name)}" type="model">\n   <mesh>\n    <vertices>\n`;
    yield* vertices(m.mesh.positions);
    yield '    </vertices>\n    <triangles>\n';
    yield* triangles(m.mesh.triangles, (f) => m.codes[f] || undefined);
    yield '    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n </build>\n</model>\n';
  }
  await zip.add('3D/3dmodel.model', model());
  // PrusaSlicer's own description of the object: one part over every triangle, printed with filament 1
  await zip.add('Metadata/Slic3r_PE_model.config', ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n'
    + `  <metadata type="object" key="name" value="${escapeXml(name)}"/>\n`
    + '  <metadata type="object" key="extruder" value="1"/>\n'
    + `  <volume firstid="0" lastid="${Math.max(n - 1, 0)}">\n`
    + `   <metadata type="volume" key="name" value="${escapeXml(name)}"/>\n`
    + '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n'
    + '   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n'
    + '   <metadata type="volume" key="source_object_id" value="0"/>\n'
    + '   <metadata type="volume" key="source_volume_id" value="0"/>\n'
    + '   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n'
    + '  </volume>\n </object>\n</config>\n']);
  if (m.thumbnail) await zip.add('Metadata/thumbnail.png', [m.thumbnail], true);
  return zip.finish();
}

export interface ColourPart { name: string; mesh: IndexedMesh; colour: number }

/**
 * A 3MF of one object with a part per colour (what a split by colour makes),
 * each part's triangles painted its filament so every slicer prints it in
 * the right one without being told.
 */
export async function parts3mf(name: string, parts: ColourPart[], palette: RGB[], thumbnail?: Uint8Array | null): Promise<Uint8Array[]> {
  const zip = new ZipWriter();
  await zip.add('[Content_Types].xml', [CONTENT_TYPES]);
  await zip.add('_rels/.rels', [rels(!!thumbnail)]);
  async function* model() {
    yield head(name, palette) + ' <resources>\n';
    for (const [i, p] of parts.entries()) {
      const code = p.colour === 0 ? undefined : leafCode(p.colour + 1);
      yield `  <object id="${i + 2}" name="${escapeXml(p.name)}" type="model">\n   <mesh>\n    <vertices>\n`;
      yield* vertices(p.mesh.positions);
      yield '    </vertices>\n    <triangles>\n';
      yield* triangles(p.mesh.triangles, () => code);
      yield '    </triangles>\n   </mesh>\n  </object>\n';
    }
    const whole = parts.length + 2;
    yield `  <object id="${whole}" name="${escapeXml(name)}" type="model">\n   <components>\n`;
    for (let i = 0; i < parts.length; i++) yield `    <component objectid="${i + 2}"/>\n`;
    yield `   </components>\n  </object>\n </resources>\n <build>\n  <item objectid="${whole}" printable="1"/>\n </build>\n</model>\n`;
  }
  await zip.add('3D/3dmodel.model', model());
  if (thumbnail) await zip.add('Metadata/thumbnail.png', [thumbnail], true);
  return zip.finish();
}

/** A binary STL. */
export function stl(mesh: IndexedMesh, header = 'Model Painter'): Uint8Array {
  const P = mesh.positions, T = mesh.triangles, n = T.length / 3;
  const out = new Uint8Array(84 + n * 50);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < Math.min(80, header.length); i++) out[i] = header.charCodeAt(i) & 127;
  dv.setUint32(80, n, true);
  let o = 84;
  for (let f = 0; f < n; f++) {
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) { dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true); o += 12; }
    o += 2;
  }
  return out;
}

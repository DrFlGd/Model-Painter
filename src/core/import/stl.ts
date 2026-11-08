// STL models, binary or text: triangles only, in millimetres, Z up. Pure.

import { ModelBuilder, stem, type FileSource, type ImportedModel } from '../model.ts';

function looksText(b: Uint8Array): boolean {
  if (b.length < 84) return true;
  if (String.fromCharCode(...b.subarray(0, 5)).toLowerCase() !== 'solid') return false;
  // a binary file may start with "solid" too: trust its triangle count
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  return 84 + n * 50 !== b.length;
}

export function stlTriangles(b: Uint8Array): Float32Array {
  if (looksText(b)) {
    const src = new TextDecoder('latin1').decode(b);
    const out: number[] = [];
    for (const m of src.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)) out.push(+m[1], +m[2], +m[3]);
    return Float32Array.from(out.slice(0, out.length - (out.length % 9)));
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = Math.min(dv.getUint32(80, true), Math.floor((b.length - 84) / 50));
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
  return out;
}

export async function importStl(src: FileSource): Promise<ImportedModel> {
  const builder = new ModelBuilder();
  builder.addMaterial({ name: stem(src.name), colour: [230, 230, 230] });
  builder.add({ positions: stlTriangles(src.bytes), material: 0 });
  return builder.build(stem(src.name), 'STL', 'mm');
}

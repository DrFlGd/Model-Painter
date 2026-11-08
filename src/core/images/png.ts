// PNG pictures, read exactly as stored (no colour management), in the page,
// the worker and the tests alike: every bit depth and colour type,
// transparency chunks and interlacing. Inflates with DecompressionStream.

import type { Picture } from '../texpaint.ts';

export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(b: Uint8Array): Promise<Picture> {
  if (!isPng(b)) throw new Error('Not a PNG file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 8, type = 6, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos), kind = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('The PNG file has no picture');
  let total = 0;
  for (const c of idat) total += c.length;
  const packed = new Uint8Array(total);
  let at = 0;
  for (const c of idat) { packed.set(c, at); at += c.length; }
  const raw = await inflate(packed);
  const channels = [1, 0, 3, 1, 2, 0, 4][type];
  if (!channels) throw new Error(`PNG colour type ${type} isn't known`);
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel, for the filters
  const out = new Uint8Array(width * height * 4);
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let src = 0;
  const max = (1 << depth) - 1;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * channels * depth) / 8);
    let prev = new Uint8Array(stride), line = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const filter = raw[src++];
      for (let i = 0; i < stride; i++) {
        const x = raw[src + i], a = i >= bpp ? line[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v: number;
        switch (filter) {
          case 1: v = x + a; break;
          case 2: v = x + up; break;
          case 3: v = x + ((a + up) >> 1); break;
          case 4: { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); break; }
          default: v = x;
        }
        line[i] = v & 255;
      }
      src += stride;
      // the samples of this row
      const sample = (k: number): number => {
        if (depth === 8) return line[k];
        if (depth === 16) return line[k * 2];
        const bit = k * depth;
        return ((line[bit >> 3] >> (8 - depth - (bit & 7))) & max) * (type === 3 ? 1 : 255 / max);
      };
      const raw16 = (k: number) => (depth === 16 ? (line[k * 2] << 8) | line[k * 2 + 1] : depth === 8 ? line[k] : (line[(k * depth) >> 3] >> (8 - depth - ((k * depth) & 7))) & max);
      for (let x = 0; x < pw; x++) {
        const o = (((y0 + y * dy) * width) + x0 + x * dx) * 4;
        if (type === 3) {
          const k = sample(x);
          out[o] = palette?.[k * 3] ?? 0; out[o + 1] = palette?.[k * 3 + 1] ?? 0; out[o + 2] = palette?.[k * 3 + 2] ?? 0;
          out[o + 3] = trns && k < trns.length ? trns[k] : 255;
        } else if (type === 0 || type === 4) {
          const g = sample(x * channels);
          out[o] = out[o + 1] = out[o + 2] = g;
          const key = trns && trns.length >= 2 ? ((trns[0] << 8) | trns[1]) : -1; // the grey that is transparent
          out[o + 3] = type === 4 ? sample(x * channels + 1) : raw16(x) === key ? 0 : 255;
        } else {
          out[o] = sample(x * channels); out[o + 1] = sample(x * channels + 1); out[o + 2] = sample(x * channels + 2);
          if (type === 6) out[o + 3] = sample(x * channels + 3);
          else if (trns && trns.length >= 6 && depth === 8 && line[x * 3] === trns[1] && line[x * 3 + 1] === trns[3] && line[x * 3 + 2] === trns[5]) out[o + 3] = 0;
          else out[o + 3] = 255;
        }
      }
      const t = prev; prev = line; line = t;
    }
  }
  return { width, height, data: out };
}

// Truevision TGA pictures, which many game tools write: true colour (15, 16,
// 24, 32 bits), greyscale and colour-mapped, plain or run-length packed, rows
// from the bottom or the top. Pure.

import type { Picture } from '../texpaint.ts';

export function decodeTga(data: Uint8Array): Picture {
  if (data.length < 18) throw new Error('Not a TGA file');
  const idLength = data[0], mapType = data[1], type = data[2];
  const mapFirst = data[3] | (data[4] << 8), mapLength = data[5] | (data[6] << 8), mapBits = data[7];
  const width = data[12] | (data[13] << 8), height = data[14] | (data[15] << 8);
  const bits = data[16], desc = data[17];
  const base = type & ~8, rle = (type & 8) !== 0;
  if (![1, 2, 3].includes(base) || !width || !height) throw new Error(`This TGA picture (type ${type}) is not read`);
  let at = 18 + idLength;
  // the colour map, as RGBA
  let map: Uint8Array | null = null;
  if (mapType === 1) {
    const mb = (mapBits + 7) >> 3;
    map = new Uint8Array((mapFirst + mapLength) * 4);
    for (let i = 0; i < mapLength; i++) readPixel(data, at + i * mb, mapBits, map, (mapFirst + i) * 4);
    at += mapLength * mb;
  }
  if (base === 1 && !map) throw new Error('The TGA picture has no colour map');
  const bpp = (bits + 7) >> 3;
  const n = width * height;
  const out = new Uint8Array(n * 4);
  const put = (src: number, i: number) => {
    if (base === 1) {
      const k = bpp === 1 ? data[src] : data[src] | (data[src + 1] << 8);
      out.set(map!.subarray(k * 4, k * 4 + 4), i * 4);
    } else if (base === 3) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[src];
      out[i * 4 + 3] = bpp === 2 ? data[src + 1] : 255;
    } else readPixel(data, src, bits, out, i * 4);
  };
  if (!rle) {
    if (at + n * bpp > data.length) throw new Error('The TGA file is cut short');
    for (let i = 0; i < n; i++) put(at + i * bpp, i);
  } else {
    let i = 0;
    while (i < n && at < data.length) {
      const head = data[at++], count = (head & 127) + 1;
      if (head & 128) { for (let k = 0; k < count && i < n; k++) put(at, i++); at += bpp; }
      else { for (let k = 0; k < count && i < n; k++) { put(at, i++); at += bpp; } }
    }
  }
  // without the alpha bits a 32-bit picture's fourth byte may be anything
  const alphaBits = desc & 15;
  if (base === 2 && bits === 32 && alphaBits === 0) for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  // rows from the bottom unless bit 5; columns from the right if bit 4
  const fromTop = (desc & 0x20) !== 0, fromRight = (desc & 0x10) !== 0;
  if (!fromTop || fromRight) {
    const flipped = new Uint8Array(out.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sy = fromTop ? y : height - 1 - y, sx = fromRight ? width - 1 - x : x;
      flipped.set(out.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
    }
    return { width, height, data: flipped };
  }
  return { width, height, data: out };
}

function readPixel(d: Uint8Array, at: number, bits: number, out: Uint8Array, o: number) {
  if (bits === 24 || bits === 32) {
    out[o] = d[at + 2]; out[o + 1] = d[at + 1]; out[o + 2] = d[at]; out[o + 3] = bits === 32 ? d[at + 3] : 255;
  } else if (bits === 15 || bits === 16) {
    const p = d[at] | (d[at + 1] << 8), r = (p >> 10) & 31, g = (p >> 5) & 31, b = p & 31;
    out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 3) | (g >> 2); out[o + 2] = (b << 3) | (b >> 2);
    out[o + 3] = 255; // the attribute bit is unset by most tools that mean opaque
  } else if (bits === 8) {
    out[o] = out[o + 1] = out[o + 2] = d[at]; out[o + 3] = 255;
  } else throw new Error(`TGA pixels of ${bits} bits are not read`);
}

// DirectDraw Surface pictures, as games keep their textures: the block
// compressed formats BC1 to BC5 and BC7, and the plain ones (8-bit and 16-bit
// channels, half and full floats, the old bit-mask formats). A port of Dark
// STL's textures/dds.py; the BC7 decoder follows bcdec (Sergii Kudlai,
// github.com/iOrange/bcdec, MIT or Unlicense), whose partition tables these
// are. Only the first face of a cube map or array is read. BC6H (HDR light
// maps, never a colour texture) is not read. Pure.

import type { Picture } from '../texpaint.ts';

const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_ALPHAPIXELS = 0x1, DDPF_ALPHA = 0x2, DDPF_FOURCC = 0x4, DDPF_RGB = 0x40, DDPF_LUMINANCE = 0x20000;

type Codec =
  | 'BC1' | 'BC2' | 'BC3' | 'BC4' | 'BC4S' | 'BC5' | 'BC5S' | 'BC6H' | 'BC7'
  | 'R8G8B8A8' | 'B8G8R8A8' | 'B8G8R8X8' | 'R8G8' | 'R8' | 'A8' | 'R16' | 'R16F' | 'R32F'
  | 'R16G16B16A16' | 'R16G16B16A16F' | 'R32G32B32A32F' | 'B5G6R5' | 'B5G5R5A1' | 'B4G4R4A4' | 'R10G10B10A2' | 'MASK';

const BLOCK_BYTES: Partial<Record<Codec, number>> = { BC1: 8, BC2: 16, BC3: 16, BC4: 8, BC4S: 8, BC5: 16, BC5S: 16, BC6H: 16, BC7: 16 };
const PIXEL_BYTES: Partial<Record<Codec, number>> = {
  R8G8B8A8: 4, B8G8R8A8: 4, B8G8R8X8: 4, R8G8: 2, R8: 1, A8: 1, R16: 2, R16F: 2, R32F: 4,
  R16G16B16A16: 8, R16G16B16A16F: 8, R32G32B32A32F: 16, B5G6R5: 2, B5G5R5A1: 2, B4G4R4A4: 2, R10G10B10A2: 4,
};

const FOURCC: Record<string, Codec> = {
  DXT1: 'BC1', DXT2: 'BC2', DXT3: 'BC2', DXT4: 'BC3', DXT5: 'BC3', ATI1: 'BC4', BC4U: 'BC4', BC4S: 'BC4S',
  ATI2: 'BC5', BC5U: 'BC5', BC5S: 'BC5S', '$\0\0\0': 'R16G16B16A16', 'o\0\0\0': 'R16F', 'q\0\0\0': 'R16G16B16A16F',
  'r\0\0\0': 'R32F', 't\0\0\0': 'R32G32B32A32F',
};

const DXGI: Record<number, Codec> = {
  2: 'R32G32B32A32F', 10: 'R16G16B16A16F', 11: 'R16G16B16A16', 24: 'R10G10B10A2', 27: 'R8G8B8A8', 28: 'R8G8B8A8', 29: 'R8G8B8A8',
  41: 'R32F', 49: 'R8G8', 54: 'R16F', 56: 'R16', 61: 'R8', 65: 'A8',
  70: 'BC1', 71: 'BC1', 72: 'BC1', 73: 'BC2', 74: 'BC2', 75: 'BC2', 76: 'BC3', 77: 'BC3', 78: 'BC3',
  79: 'BC4', 80: 'BC4', 81: 'BC4S', 82: 'BC5', 83: 'BC5', 84: 'BC5S', 85: 'B5G6R5', 86: 'B5G5R5A1',
  87: 'B8G8R8A8', 88: 'B8G8R8X8', 90: 'B8G8R8A8', 91: 'B8G8R8A8', 92: 'B8G8R8X8', 93: 'B8G8R8X8',
  94: 'BC6H', 95: 'BC6H', 96: 'BC6H', 97: 'BC7', 98: 'BC7', 99: 'BC7', 115: 'B4G4R4A4',
};

export interface DdsInfo {
  width: number;
  height: number;
  mipmaps: number;
  codec: Codec;
  offset: number;
  bitCount: number;
  masks: [number, number, number, number];
}

export function isDds(data: Uint8Array): boolean {
  return data.length >= 128 && data[0] === 0x44 && data[1] === 0x44 && data[2] === 0x53 && data[3] === 0x20;
}

export function parseDds(data: Uint8Array): DdsInfo {
  if (!isDds(data)) throw new Error('Not a DDS file');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  if (u32(4) !== 124) throw new Error(`Unexpected DDS header size ${u32(4)}`);
  const flags = u32(8), height = u32(12), width = u32(16);
  let mipmaps = u32(28);
  const pf = u32(0x50);
  const fourcc = String.fromCharCode(data[0x54], data[0x55], data[0x56], data[0x57]);
  const bitCount = u32(0x58);
  let masks: [number, number, number, number] = [u32(0x5c), u32(0x60), u32(0x64), u32(0x68)];
  let offset = 128;
  let codec: Codec | undefined;
  if (pf & DDPF_FOURCC) {
    if (fourcc === 'DX10') {
      const dxgi = u32(128);
      offset += 20;
      codec = DXGI[dxgi];
      if (!codec) throw new Error(`This DDS format (DXGI ${dxgi}) is not read`);
    } else {
      codec = FOURCC[fourcc];
      if (!codec) throw new Error(`This DDS format (${JSON.stringify(fourcc)}) is not read`);
    }
  } else if (pf & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA | DDPF_ALPHAPIXELS)) {
    codec = 'MASK';
    if (!(pf & (DDPF_ALPHAPIXELS | DDPF_ALPHA))) masks[3] = 0;
    if (pf & DDPF_ALPHA && !(pf & (DDPF_RGB | DDPF_LUMINANCE))) masks = [0, 0, 0, masks[3]];
    if (pf & DDPF_LUMINANCE) masks = [masks[0], masks[0], masks[0], masks[3]];
  } else throw new Error(`This DDS pixel format (flags 0x${pf.toString(16)}) is not read`);
  if (!(flags & DDSD_MIPMAPCOUNT) || mipmaps === 0) mipmaps = 1;
  return { width, height, mipmaps, codec, offset, bitCount, masks };
}

function surfaceBytes(info: DdsInfo, w: number, h: number): number {
  const block = BLOCK_BYTES[info.codec];
  if (block) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * block;
  if (info.codec === 'MASK') return w * h * (info.bitCount >> 3);
  return w * h * PIXEL_BYTES[info.codec]!;
}

/**
 * The picture of a DDS file: its largest mip level, or the largest no bigger
 * than `maxSize` on its longer side when the file has one (painting reads
 * textures at most 2048 across, so a 4096 texture's next level does).
 */
export function decodeDds(data: Uint8Array, maxSize = Infinity): Picture {
  const info = parseDds(data);
  let level = 0, offset = info.offset;
  while (level + 1 < info.mipmaps && Math.max(info.width >> level, info.height >> level) > maxSize) {
    offset += surfaceBytes(info, Math.max(1, info.width >> level), Math.max(1, info.height >> level));
    level++;
  }
  const w = Math.max(1, info.width >> level), h = Math.max(1, info.height >> level);
  const need = surfaceBytes(info, w, h);
  if (offset + need > data.length) throw new Error('The DDS file is cut short');
  return decodeSurface(info, data.subarray(offset, offset + need), w, h);
}

function decodeSurface(info: DdsInfo, raw: Uint8Array, w: number, h: number): Picture {
  const out = new Uint8Array(w * h * 4);
  const codec = info.codec;
  if (BLOCK_BYTES[codec]) {
    if (codec === 'BC6H') throw new Error('BC6H (HDR) textures are not read: they hold light, not colours');
    const size = BLOCK_BYTES[codec]!;
    const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
    const block = new Uint8Array(64);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const at = (by * bw + bx) * size;
      const src = raw.subarray(at, at + size);
      switch (codec) {
        case 'BC1': colourBlock(src, 0, block, false); break;
        case 'BC2': colourBlock(src, 8, block, true); sharpAlpha(src, block); break;
        case 'BC3': colourBlock(src, 8, block, true); valueBlock(src, 0, block, 3, false); break;
        case 'BC4': case 'BC4S': {
          valueBlock(src, 0, block, 0, codec === 'BC4S');
          for (let i = 0; i < 16; i++) { block[i * 4 + 1] = block[i * 4 + 2] = block[i * 4]; block[i * 4 + 3] = 255; }
          break;
        }
        case 'BC5': case 'BC5S': {
          valueBlock(src, 0, block, 0, codec === 'BC5S');
          valueBlock(src, 8, block, 1, codec === 'BC5S');
          for (let i = 0; i < 16; i++) { block[i * 4 + 2] = 0; block[i * 4 + 3] = 255; }
          break;
        }
        case 'BC7': bc7Block(src, block); break;
      }
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= h) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= w) break;
          out.set(block.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4), (py * w + px) * 4);
        }
      }
    }
    return { width: w, height: h, data: out };
  }
  const n = w * h;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const clamp8 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  switch (codec) {
    case 'R8G8B8A8': out.set(raw.subarray(0, n * 4)); break;
    case 'B8G8R8A8': case 'B8G8R8X8':
      for (let i = 0; i < n; i++) {
        out[i * 4] = raw[i * 4 + 2]; out[i * 4 + 1] = raw[i * 4 + 1]; out[i * 4 + 2] = raw[i * 4];
        out[i * 4 + 3] = codec === 'B8G8R8X8' ? 255 : raw[i * 4 + 3];
      }
      break;
    case 'R8G8': for (let i = 0; i < n; i++) { out[i * 4] = raw[i * 2]; out[i * 4 + 1] = raw[i * 2 + 1]; out[i * 4 + 3] = 255; } break;
    case 'R8': for (let i = 0; i < n; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = raw[i]; out[i * 4 + 3] = 255; } break;
    case 'A8': for (let i = 0; i < n; i++) out[i * 4 + 3] = raw[i]; break;
    case 'B5G6R5':
      for (let i = 0; i < n; i++) {
        const p = dv.getUint16(i * 2, true), r = p >> 11, g = (p >> 5) & 63, b = p & 31;
        out[i * 4] = (r << 3) | (r >> 2); out[i * 4 + 1] = (g << 2) | (g >> 4); out[i * 4 + 2] = (b << 3) | (b >> 2); out[i * 4 + 3] = 255;
      }
      break;
    case 'B5G5R5A1':
      for (let i = 0; i < n; i++) {
        const p = dv.getUint16(i * 2, true), r = (p >> 10) & 31, g = (p >> 5) & 31, b = p & 31;
        out[i * 4] = (r << 3) | (r >> 2); out[i * 4 + 1] = (g << 3) | (g >> 2); out[i * 4 + 2] = (b << 3) | (b >> 2); out[i * 4 + 3] = p & 0x8000 ? 255 : 0;
      }
      break;
    case 'B4G4R4A4':
      for (let i = 0; i < n; i++) {
        const p = dv.getUint16(i * 2, true);
        out[i * 4] = ((p >> 8) & 15) * 17; out[i * 4 + 1] = ((p >> 4) & 15) * 17; out[i * 4 + 2] = (p & 15) * 17; out[i * 4 + 3] = (p >> 12) * 17;
      }
      break;
    case 'R10G10B10A2':
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(i * 4, true);
        out[i * 4] = (p & 1023) >> 2; out[i * 4 + 1] = ((p >> 10) & 1023) >> 2; out[i * 4 + 2] = ((p >> 20) & 1023) >> 2; out[i * 4 + 3] = (p >>> 30) * 85;
      }
      break;
    case 'R16': for (let i = 0; i < n; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = dv.getUint16(i * 2, true) >> 8; out[i * 4 + 3] = 255; } break;
    case 'R16F': case 'R32F':
      for (let i = 0; i < n; i++) {
        const v = clamp8(codec === 'R16F' ? half(dv.getUint16(i * 2, true)) : dv.getFloat32(i * 4, true));
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
      }
      break;
    case 'R16G16B16A16': for (let i = 0; i < n * 4; i++) out[i] = dv.getUint16(i * 2, true) >> 8; break;
    case 'R16G16B16A16F': for (let i = 0; i < n * 4; i++) out[i] = clamp8(half(dv.getUint16(i * 2, true))); break;
    case 'R32G32B32A32F': for (let i = 0; i < n * 4; i++) out[i] = clamp8(dv.getFloat32(i * 4, true)); break;
    case 'MASK': {
      const bpp = info.bitCount >> 3;
      const defaults = [0, 0, 0, 255];
      for (let i = 0; i < n; i++) {
        let p = 0;
        for (let k = 0; k < bpp && k < 4; k++) p += raw[i * bpp + k] * 2 ** (8 * k);
        for (let c = 0; c < 4; c++) {
          const mask = info.masks[c] >>> 0;
          if (!mask) { out[i * 4 + c] = defaults[c]; continue; }
          let shift = 0;
          while (!((mask >>> shift) & 1)) shift++;
          const max = mask >>> shift;
          out[i * 4 + c] = Math.round((((p >>> shift) & max) * 255) / max);
        }
      }
      break;
    }
    default: throw new Error(`This DDS format (${codec}) is not read`);
  }
  return { width: w, height: h, data: out };
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// ---------------------------------------------------------------------------
// BC1 to BC5

const pal = new Int32Array(12);

/** A BC1 colour block (8 bytes at `at`) into the block's RGB; `four` forces the four-colour mode (BC2, BC3). */
function colourBlock(src: Uint8Array, at: number, out: Uint8Array, four: boolean) {
  const c0 = src[at] | (src[at + 1] << 8), c1 = src[at + 2] | (src[at + 3] << 8);
  const r0 = ((c0 >> 11) << 3) | (c0 >> 13), g0 = (((c0 >> 5) & 63) << 2) | ((c0 >> 9) & 3), b0 = ((c0 & 31) << 3) | ((c0 >> 2) & 7);
  const r1 = ((c1 >> 11) << 3) | (c1 >> 13), g1 = (((c1 >> 5) & 63) << 2) | ((c1 >> 9) & 3), b1 = ((c1 & 31) << 3) | ((c1 >> 2) & 7);
  pal[0] = r0; pal[1] = g0; pal[2] = b0; pal[3] = r1; pal[4] = g1; pal[5] = b1;
  const opaque = four || c0 > c1;
  if (opaque) {
    pal[6] = ((2 * r0 + r1) / 3) | 0; pal[7] = ((2 * g0 + g1) / 3) | 0; pal[8] = ((2 * b0 + b1) / 3) | 0;
    pal[9] = ((r0 + 2 * r1) / 3) | 0; pal[10] = ((g0 + 2 * g1) / 3) | 0; pal[11] = ((b0 + 2 * b1) / 3) | 0;
  } else {
    pal[6] = (r0 + r1) >> 1; pal[7] = (g0 + g1) >> 1; pal[8] = (b0 + b1) >> 1;
    pal[9] = 0; pal[10] = 0; pal[11] = 0;
  }
  const bits = (src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) | (src[at + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++) {
    const s = (bits >>> (i * 2)) & 3;
    out[i * 4] = pal[s * 3]; out[i * 4 + 1] = pal[s * 3 + 1]; out[i * 4 + 2] = pal[s * 3 + 2];
    out[i * 4 + 3] = !opaque && s === 3 ? 0 : 255;
  }
}

/** BC2's alpha: 4 bits a texel. */
function sharpAlpha(src: Uint8Array, out: Uint8Array) {
  for (let i = 0; i < 8; i++) { out[i * 8 + 3] = (src[i] & 15) * 17; out[i * 8 + 7] = (src[i] >> 4) * 17; }
}

const vpal = new Float64Array(8);

/** A BC4 block (8 bytes at `at`) into channel `channel` of the block. */
function valueBlock(src: Uint8Array, at: number, out: Uint8Array, channel: number, signed: boolean) {
  let a0 = src[at], a1 = src[at + 1], lo = 0, hi = 255;
  if (signed) { a0 = Math.max(-127, (a0 << 24) >> 24); a1 = Math.max(-127, (a1 << 24) >> 24); lo = -127; hi = 127; }
  vpal[0] = a0; vpal[1] = a1;
  if (a0 > a1) for (let i = 1; i < 7; i++) vpal[i + 1] = ((7 - i) * a0 + i * a1) / 7;
  else { for (let i = 1; i < 5; i++) vpal[i + 1] = ((5 - i) * a0 + i * a1) / 5; vpal[6] = lo; vpal[7] = hi; }
  // 48 bits of 3-bit selectors
  const lo24 = src[at + 2] | (src[at + 3] << 8) | (src[at + 4] << 16);
  const hi24 = src[at + 5] | (src[at + 6] << 8) | (src[at + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const s = i < 8 ? (lo24 >> (i * 3)) & 7 : (hi24 >> ((i - 8) * 3)) & 7;
    let v = vpal[s];
    if (signed) v = ((v + 127) * 255) / 254;
    out[i * 4 + channel] = Math.max(0, Math.min(255, Math.round(v)));
  }
}

// ---------------------------------------------------------------------------
// BC7

// subset of each texel, 16 per partition: 64 partitions of two subsets, then 64 of three
const P2 = '0011001100110011000100010001000101110111011101110001001100110111000000010001001100110111011111110001001101111111000000010011011100000000000100110011011111111111000000010111111100000000000101110001011111111111000000001111111100001111111111110000000000001111000010001110111101110001000000000000000010001110011100110001000000110001000000000000100011001110000000001000110001110011001100010011000100010000000010001000110001100110011001100011011001101100000101111110100000001111111100000111000110001110001110011001110001010101010101010000111100001111010110100101101000110011110011000011110000111100010101011010101001101001011010010101101010100101011100111100111000010011110010000011001001001100001110111101110001101001100101100011110011000011011001101001100100000110011000000100111001000000001001110010000000000010011100100000010011100100011011001001001100110110110010010110001110011100001110011100011001101100110010010110001100111001011111101000000100011000111001110000111100110011001100111111000000100010111011100100010001110111';
const P3 = '0011001102212222000100112211222100002001221122110222002200110111000000001122112200110011002200220022002211111111001100112211221100000000111122220000111111112222000011112222222200120012001200120112011201120112012201220122012200110112112212220011200122002220000100110112112201110011200122000000112211221122002200220022111101110111022202220001000122212221000000110122012200001100221022100122012200110000001200121122222201101221122101100000011012211221002211021102002201100110200222220011012201220011000020002211222100000002112212220222002200120011001100120022022201200120012001200000111122220000012012012012012001202012120101200011220011220011001111222200001101010101222222220000000021212121002211220022112200220011002200110220122102201221010122222222010100002121212121210101010101012222022201110222011100021112000211120000211221122112022201110111022200021112111200020110011001102222000000002112211201100110222222220022001100110022002211221122002200000000000021120002000100020001022212220222122201012222222222220111201122012220';
// the texel whose index is a bit shorter, for subset 1 (two subsets), and subsets 1 and 2 (three)
const A2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const A31 = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const A32 = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const PART2 = Uint8Array.from(P2, (c) => c.charCodeAt(0) - 48);
const PART3 = Uint8Array.from(P3, (c) => c.charCodeAt(0) - 48);
const W2 = [0, 21, 43, 64], W3 = [0, 9, 18, 27, 37, 46, 55, 64], W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
// per mode: colour bits, alpha bits, subsets, partition bits
const COLOUR_BITS = [4, 6, 5, 7, 5, 7, 7, 5], ALPHA_BITS = [0, 0, 0, 0, 6, 8, 7, 5];
const HAS_PBITS = 0b11001011;

const ep = new Int32Array(24); // 6 endpoints × RGBA
const idx = new Uint8Array(16), idx2 = new Uint8Array(16);

function bc7Block(src: Uint8Array, out: Uint8Array) {
  // a little-endian 128-bit stream, read from bit 0
  let pos = 0;
  const bits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v |= ((src[pos >> 3] >> (pos & 7)) & 1) << i;
    return v;
  };
  let mode = 0;
  while (mode < 8 && bits(1) === 0) mode++;
  if (mode >= 8) { out.fill(0); return; }
  let subsets = 1, partition = 0, rotation = 0, selection = 0;
  if (mode === 0 || mode === 1 || mode === 2 || mode === 3 || mode === 7) {
    subsets = mode === 0 || mode === 2 ? 3 : 2;
    partition = bits(mode === 0 ? 4 : 6);
  }
  const ends = subsets * 2;
  if (mode === 4 || mode === 5) { rotation = bits(2); if (mode === 4) selection = bits(1); }
  const cb = COLOUR_BITS[mode], ab = ALPHA_BITS[mode];
  for (let c = 0; c < 3; c++) for (let e = 0; e < ends; e++) ep[e * 4 + c] = bits(cb);
  if (ab) for (let e = 0; e < ends; e++) ep[e * 4 + 3] = bits(ab);
  const pbit = (HAS_PBITS >> mode) & 1;
  if (pbit) {
    for (let i = 0; i < ends * 4; i++) ep[i] <<= 1;
    if (mode === 1) {
      const p0 = bits(1), p1 = bits(1);
      for (let c = 0; c < 3; c++) { ep[c] |= p0; ep[4 + c] |= p0; ep[8 + c] |= p1; ep[12 + c] |= p1; }
    } else {
      for (let e = 0; e < ends; e++) { const p = bits(1); for (let c = 0; c < 4; c++) ep[e * 4 + c] |= p; }
    }
  }
  for (let e = 0; e < ends; e++) {
    const j = cb + pbit;
    for (let c = 0; c < 3; c++) { const v = ep[e * 4 + c] << (8 - j); ep[e * 4 + c] = v | (v >> j); }
    if (ab) { const ja = ab + pbit; const v = ep[e * 4 + 3] << (8 - ja); ep[e * 4 + 3] = v | (v >> ja); }
    else ep[e * 4 + 3] = 255;
  }
  const ib = mode === 0 || mode === 1 ? 3 : mode === 6 ? 4 : 2;
  const ib2 = mode === 4 ? 3 : mode === 5 ? 2 : 0;
  const w1 = ib === 2 ? W2 : ib === 3 ? W3 : W4;
  const w2 = ib2 === 2 ? W2 : W3;
  const subsetOf = (t: number) => (subsets === 1 ? 0 : subsets === 2 ? PART2[partition * 16 + t] : PART3[partition * 16 + t]);
  const anchor = (t: number) => t === 0 || (subsets === 2 && t === A2[partition]) || (subsets === 3 && (t === A31[partition] || t === A32[partition]));
  for (let t = 0; t < 16; t++) idx[t] = bits(anchor(t) ? ib - 1 : ib);
  if (ib2) for (let t = 0; t < 16; t++) idx2[t] = bits(t === 0 ? ib2 - 1 : ib2);
  const lerp = (a: number, b: number, w: number) => ((64 - w) * a + w * b + 32) >> 6;
  for (let t = 0; t < 16; t++) {
    const s = subsetOf(t), e0 = s * 8, e1 = s * 8 + 4;
    let cw: number, aw: number;
    if (!ib2) { cw = w1[idx[t]]; aw = cw; }
    else if (!selection) { cw = w1[idx[t]]; aw = w2[idx2[t]]; }
    else { cw = w2[idx2[t]]; aw = w1[idx[t]]; }
    let r = lerp(ep[e0], ep[e1], cw), g = lerp(ep[e0 + 1], ep[e1 + 1], cw), b = lerp(ep[e0 + 2], ep[e1 + 2], cw), a = lerp(ep[e0 + 3], ep[e1 + 3], aw);
    if (rotation === 1) [a, r] = [r, a];
    else if (rotation === 2) [a, g] = [g, a];
    else if (rotation === 3) [a, b] = [b, a];
    out[t * 4] = r; out[t * 4 + 1] = g; out[t * 4 + 2] = b; out[t * 4 + 3] = a;
  }
}

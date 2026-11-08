// Reading a texture file into RGBA, whatever it is: DDS, TGA and PNG here
// (exactly as stored), anything else the browser can show (JPEG, WebP, BMP,
// GIF, AVIF) through `setBrowserDecoder`, which the page and the worker set.

import type { Picture } from '../texpaint.ts';
import { decodeDds, isDds } from './dds.ts';
import { decodePng, isPng } from './png.ts';
import { decodeTga } from './tga.ts';

export type BrowserDecoder = (bytes: Uint8Array, mime: string) => Promise<Picture>;
let browser: BrowserDecoder | null = null;

export function setBrowserDecoder(d: BrowserDecoder | null): void { browser = d; }

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', avif: 'image/avif', png: 'image/png' };

function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

/**
 * A picture file as RGBA (rows from the top). `maxSize` lets a DDS file be
 * read at a smaller mip level when it has one that big.
 */
export async function decodePicture(name: string, bytes: Uint8Array, maxSize = Infinity): Promise<Picture> {
  if (isDds(bytes)) return decodeDds(bytes, maxSize);
  if (isPng(bytes)) return decodePng(bytes);
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const mime = sniff(bytes) ?? MIME[ext];
  if (!mime && (ext === 'tga' || ext === 'icb' || ext === 'vda' || ext === 'vst' || bytes[2] === 2 || bytes[2] === 10)) return decodeTga(bytes);
  if (ext === 'tif' || ext === 'tiff') throw new Error(`${name}: TIFF pictures aren't read; save it as PNG`);
  if (!browser) throw new Error(`${name}: this kind of picture can't be read here`);
  return browser(bytes, mime ?? 'application/octet-stream');
}

/** Width and height without decoding all of it (for listing textures), when that is quick to tell. */
export function pictureSize(bytes: Uint8Array): [number, number] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isDds(bytes)) return [dv.getUint32(16, true), dv.getUint32(12, true)];
  if (isPng(bytes) && bytes.length > 24) return [dv.getUint32(16), dv.getUint32(20)];
  return null;
}

// Pictures the browser itself reads (JPEG, WebP, BMP, GIF, AVIF), as RGBA
// exactly as stored: no premultiplied alpha, no colour profile applied. Set
// as the picture readers' fallback in the page and in the texture worker.

import type { Picture } from '../core/texpaint.ts';

export async function browserDecoder(bytes: Uint8Array, mime: string): Promise<Picture> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('This browser cannot read pictures in the background');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) };
}

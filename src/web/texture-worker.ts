// The texture work, off the page's thread: reading pictures, suggesting the
// colours, reducing a texture for the Prepare texture dialog, and painting
// the model from its textures (core/texpaint.ts). It keeps the model it was
// last given, so the dialog's many small requests send only their settings.

import { decodePicture, setBrowserDecoder } from '../core/images/index.ts';
import { MAX_TEXTURE, paintModel, reduce, shrink, suggestPalette, type PaintInput, type Picture } from '../core/texpaint.ts';
import { parseHex } from '../core/colour.ts';
import type { Request } from './texture-jobs.ts';
import { browserDecoder } from './decode.ts';

setBrowserDecoder(browserDecoder);

let input: PaintInput | null = null;

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Request>) => {
  const r = e.data;
  const progress = (fraction: number, message: string) => post({ id: r.id, progress: [fraction, message] });
  try {
    switch (r.op) {
      case 'decode': {
        const pic: Picture = shrink(await decodePicture(r.name, r.bytes, MAX_TEXTURE), MAX_TEXTURE);
        const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data.buffer);
        post({ id: r.id, result: { width: pic.width, height: pic.height, data } }, [data.buffer]);
        break;
      }
      case 'setup':
        input = r.input;
        post({ id: r.id, result: true });
        break;
      case 'suggest':
        if (!input) throw new Error('no model');
        post({ id: r.id, result: suggestPalette(input, r.settings, progress) });
        break;
      case 'reduce': {
        if (!input) throw new Error('no model');
        const src = input.sources.get(r.material);
        if (!src || src.kind !== 'texture') throw new Error('that material has no texture');
        const labels = reduce(src.picture, r.palette.map(parseHex), { ...r.settings, palette: r.palette }, src.tint);
        post({ id: r.id, result: { width: src.picture.width, height: src.picture.height, labels } }, [labels.buffer]);
        break;
      }
      case 'paint': {
        if (!input) throw new Error('no model');
        post({ id: r.id, result: paintModel(input, r.settings, r.suggestion, progress) });
        break;
      }
    }
  } catch (err) {
    post({ id: r.id, error: (err as Error).message ?? String(err) });
  }
};

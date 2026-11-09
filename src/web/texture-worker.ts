// The long work, off the page's thread: reading pictures, suggesting the
// colours, reducing a texture for the Prepare texture dialog, painting the
// model from its textures (core/texpaint.ts), and making it watertight
// (core/finish.ts, with its paint carried over by core/finish-map.ts), and
// cutting it into pieces (core/cut.ts). It keeps the model it was last given,
// so the dialog's many small requests send only their settings, and the
// model made solid for cutting, so moving a cut only cuts again.

import { decodePicture, setBrowserDecoder } from '../core/images/index.ts';
import { MAX_TEXTURE, paintModel, reduce, shrink, suggestPalette, type PaintInput, type Picture } from '../core/texpaint.ts';
import { parseHex } from '../core/colour.ts';
import { makeWatertight } from '../core/finish.ts';
import { mapFinished, type FinishedModel } from '../core/finish-map.ts';
import { Cutter } from '../core/cut.ts';
import type { CutOutput, FinishOutput, Request } from './texture-jobs.ts';
import { browserDecoder } from './decode.ts';

setBrowserDecoder(browserDecoder);

let input: PaintInput | null = null;
let cutter: Cutter | null = null;
let cutterKey = '';

/** The buffers of a model, to hand to the page rather than copy. */
function buffers(model: FinishedModel): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [model.mesh.positions.buffer, model.mesh.triangles.buffer, model.faceMaterial.buffer, model.faceGroup.buffer];
  if (model.uvs) out.push(model.uvs.buffer);
  if (model.vertexColours) out.push(model.vertexColours.buffer);
  if (model.paint) out.push(model.paint.colour.buffer);
  return [...new Set(out)] as ArrayBuffer[];
}

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
      case 'finish': {
        if (!input) throw new Error('no model');
        const fin = await makeWatertight(input.mesh, r.groups, r.settings, (f, m) => progress(f * 0.8, m));
        progress(0.82, 'Carrying the paint and textures over');
        const model = mapFinished({
          mesh: input.mesh, uvs: input.uvs, vertexColours: input.vertexColours ?? null, faceMaterial: input.faceMaterial, faceGroup: r.groups,
          paint: r.paint, baseMaterial: r.baseMaterial,
        }, fin, (f) => progress(0.82 + f * 0.17, 'Carrying the paint and textures over'));
        const result: FinishOutput = { model, notes: fin.notes, volume: fin.volume, shells: fin.shells, hollows: fin.hollows, gapVolume: fin.gapVolume, looseRemoved: fin.looseRemoved };
        post({ id: r.id, result }, buffers(model));
        break;
      }
      case 'cut': {
        if (!input) throw new Error('no model');
        if (!cutter || cutterKey !== r.key) {
          cutter?.dispose();
          cutter = null;
          progress(0.01, r.solid ? 'Reading the solid' : 'Making it solid to cut');
          cutter = await Cutter.of(input.mesh, { solid: r.solid, groups: r.groups, sheet: r.sheet, progress: (f, m) => progress(f * 0.6, m) });
          cutterKey = r.key;
        }
        const cut = cutter.cut(r.settings, (f, m) => progress(0.6 + f * 0.25, m));
        const src = {
          mesh: input.mesh, uvs: input.uvs, vertexColours: input.vertexColours ?? null, faceMaterial: input.faceMaterial, faceGroup: r.groups,
          paint: r.paint, baseMaterial: r.baseMaterial,
        };
        const pieces = cut.pieces.map((p, i) => {
          progress(0.85 + (0.15 * i) / cut.pieces.length, `Carrying the paint onto ${p.name.toLowerCase()}`);
          return { name: p.name, kind: p.kind, faces: p.faces, axis: p.axis, volume: p.volume, model: mapFinished(src, p) };
        });
        const result: CutOutput = { pieces, notes: cut.notes, joints: cut.joints, volume: cutter.volume };
        post({ id: r.id, result }, pieces.flatMap((p) => buffers(p.model)));
        break;
      }
    }
  } catch (err) {
    post({ id: r.id, error: (err as Error).message ?? String(err) });
  }
};

// The page's side of the texture worker: each request a promise, progress
// passed along, and Cancel ending the worker (a fresh one starts with the
// next request, given the model again).

import type { PaintInput, PaintResult, Picture, Progress, Suggestion, TextureSettings } from '../core/texpaint.ts';
import { DEFAULT_SETTINGS } from '../core/texpaint.ts';
import { FINISH_DEFAULTS, type FinishSettings } from '../core/finish.ts';
import type { FinishedModel } from '../core/finish-map.ts';
import type { CutFace, CutSettings, JointReport } from '../core/cut.ts';

/** The model made watertight: the model to show, and what finishing did. */
export interface FinishOutput {
  model: FinishedModel;
  notes: string[];
  /** mm³ */
  volume: number;
  shells: number;
  hollows: number;
  gapVolume: number;
  looseRemoved: number;
}

export interface FinishPaint { colour: Uint8Array; codes: Map<number, string> }

/** One piece the model was cut into, with the paint, UVs and materials it took from the model. */
export interface CutPieceOut {
  name: string;
  kind: 'piece' | 'dowel';
  model: FinishedModel;
  faces: CutFace[];
  axis?: [number, number, number];
  /** mm³ */
  volume: number;
}

export interface CutOutput {
  pieces: CutPieceOut[];
  notes: string[];
  joints: JointReport[];
  /** of the solid cut, mm³ */
  volume: number;
}

export type Request = { id: number } & (
  | { op: 'decode'; name: string; bytes: Uint8Array }
  | { op: 'setup'; input: PaintInput }
  | { op: 'suggest'; settings: TextureSettings }
  | { op: 'reduce'; material: number; palette: string[]; settings: TextureSettings }
  | { op: 'paint'; settings: TextureSettings; suggestion: Suggestion | null }
  | { op: 'finish'; groups: Uint32Array; paint: FinishPaint | null; settings: FinishSettings; baseMaterial: number }
  | { op: 'cut'; key: string; groups: Uint32Array; solid: boolean; sheet: number; settings: CutSettings; paint: FinishPaint | null; baseMaterial: number }
);

type Waiting = { resolve: (v: never) => void; reject: (e: Error) => void; progress?: Progress };

export class Cancelled extends Error { constructor() { super('Stopped'); } }

type Body<R> = R extends unknown ? Omit<R, 'id'> : never;

export class TextureJobs {
  private worker: Worker | null = null;
  private next = 1;
  private waiting = new Map<number, Waiting>();
  private input: PaintInput | null = null;
  private sent = false;

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./texture-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data as { id: number; result?: unknown; error?: string; progress?: [number, string] };
      const job = this.waiting.get(m.id);
      if (!job) return;
      if (m.progress) { job.progress?.(m.progress[0], m.progress[1]); return; }
      this.waiting.delete(m.id);
      if (m.error !== undefined) job.reject(new Error(m.error)); else job.resolve(m.result as never);
    };
    w.onerror = (e) => {
      const err = new Error(e.message || 'The texture worker stopped');
      for (const j of this.waiting.values()) j.reject(err);
      this.waiting.clear();
      this.worker?.terminate();
      this.worker = null;
      this.sent = false;
    };
    this.worker = w;
    this.sent = false;
    return w;
  }

  private ask<T>(req: Body<Request>, progress?: Progress, transfer: Transferable[] = []): Promise<T> {
    const w = this.start();
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: never) => void, reject, progress });
      w.postMessage({ ...req, id }, transfer);
    });
  }

  /** Reads a picture file (at most MAX_TEXTURE across). */
  decode(name: string, bytes: Uint8Array): Promise<Picture> {
    return this.ask({ op: 'decode', name, bytes: bytes.slice() });
  }

  /** The model the next requests work on (its mesh at print size, in mm). */
  setModel(input: PaintInput): void { this.input = input; this.sent = false; }

  private async ready() {
    if (!this.input) throw new Error('No model is open');
    this.start();
    if (!this.sent) { this.sent = true; await this.ask({ op: 'setup', input: this.input }); }
  }

  async suggest(settings: Partial<TextureSettings>, progress?: Progress): Promise<Suggestion> {
    await this.ready();
    return this.ask({ op: 'suggest', settings: { ...DEFAULT_SETTINGS, ...settings } }, progress);
  }

  async reduce(material: number, palette: string[], settings: Partial<TextureSettings>): Promise<{ width: number; height: number; labels: Uint8Array }> {
    await this.ready();
    return this.ask({ op: 'reduce', material, palette, settings: { ...DEFAULT_SETTINGS, ...settings } });
  }

  async paint(settings: Partial<TextureSettings>, suggestion: Suggestion | null, progress?: Progress): Promise<PaintResult> {
    await this.ready();
    return this.ask({ op: 'paint', settings: { ...DEFAULT_SETTINGS, ...settings }, suggestion }, progress);
  }

  /** The model made watertight (finish.ts), its paint, UVs and materials carried over (finish-map.ts). */
  async finish(groups: Uint32Array, paint: FinishPaint | null, settings: Partial<FinishSettings>, baseMaterial: number, progress?: Progress): Promise<FinishOutput> {
    await this.ready();
    return this.ask({ op: 'finish', groups, paint, settings: { ...FINISH_DEFAULTS, ...settings }, baseMaterial }, progress);
  }

  /**
   * The model cut into pieces (cut.ts), each piece's paint, UVs and materials
   * carried over (finish-map.ts), the cut faces and joints in `baseMaterial`
   * and colour 1. The model made solid is kept in the worker under `key`, so
   * cutting the same model again only cuts. `solid`: the model is watertight
   * already (else it is made solid first, open surfaces `sheet` mm thick).
   */
  async cut(key: string, groups: Uint32Array, solid: boolean, sheet: number, settings: CutSettings, paint: FinishPaint | null, baseMaterial: number, progress?: Progress): Promise<CutOutput> {
    await this.ready();
    return this.ask({ op: 'cut', key, groups, solid, sheet, settings, paint, baseMaterial }, progress);
  }

  /** Stops whatever the worker is doing. */
  cancel(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.sent = false;
    for (const j of this.waiting.values()) j.reject(new Cancelled());
    this.waiting.clear();
  }

  get busy(): boolean { return this.waiting.size > 0; }
}

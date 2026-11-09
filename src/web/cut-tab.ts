// The Cut tab: planes placed in the view (dragged to slide them, the round
// handle dragged to tilt them, or a point on the model picked) cut the model
// shown into watertight pieces in the worker (core/cut.ts), each cut with its
// own joint and clearance. The pieces keep the paint, UVs and materials of
// the model they were cut from (the cut faces and joints colour 1), show in
// colours or in their paint, spread apart by a slider, and are saved each to
// its own file, laid flat on a cut face to print.

import * as THREE from 'three';
import type { Stage } from './stage.ts';
import { Cancelled, type CutOutput, type CutPieceOut, type TextureJobs } from './texture-jobs.ts';
import { CutPlanes, type PlaneAt, type V3 } from './cut-planes.ts';
import { PiecesView, pieceColour } from './pieces-view.ts';
import { PaintView } from './paint-view.ts';
import { TexturedView, type MaterialLook } from './textured.ts';
import { h, hex } from './prepare-image.ts';
import { desktop, makeFolder, pickFolder, writeFile } from './desktop.ts';
import { CUT_DEFAULTS, JOINT_DEFAULTS, printPose, type CutSettings, type Joint, type JointKind } from '../core/cut.ts';
import { PaintModel } from '../core/paint-model.ts';
import { painted3mf, parts3mf, stl } from '../core/export.ts';
import { splitByMaterial } from '../core/split-colours.ts';
import { join, ZipWriter } from '../core/zip-write.ts';
import type { IndexedMesh } from '../core/mesh.ts';
import type { ImportedModel, ModelMaterial } from '../core/model.ts';
import type { RGB } from '../core/colour.ts';

/** The model shown, as the Cut tab cuts it. */
export interface CutSource {
  /** names this model and the state of its shape: the solid it is cut from is made again when this changes */
  key: string;
  /** changes to its paint so far (the pieces carry the paint they were cut with) */
  edits: number;
  /** made watertight on the Finish tab (else it is made solid first) */
  watertight: boolean;
  model: ImportedModel;
  /** its textured look in the view, where a point is picked */
  target: THREE.Object3D;
  paint: { faceMaterial: Uint8Array; codes: Map<number, string> } | null;
  palette: RGB[];
  looks: MaterialLook[];
  /** open surfaces are made this thick when the model is made solid to cut, mm */
  sheet: number;
}

export interface CutHost {
  stage: Stage;
  jobs: TextureJobs;
  source(): CutSource | null;
  status(text: string): void;
  progress(text: string | null, fraction?: number, stop?: () => void): void;
  /** a job started or ended, or the pieces came or went: buttons follow */
  changed(): void;
}

export type PieceFormat = '3mf' | 'split' | 'stl';

interface Cut { normal: V3; point: V3; joint: Joint }

interface Result {
  out: CutOutput;
  key: string;
  edits: number;
  request: string;
  materials: ModelMaterial[];
  looks: MaterialLook[];
  painted: boolean;
  watertight: boolean;
}

const KEY = 'model-painter-cut';
const AXES: Record<'x' | 'y' | 'z', V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const JOINT_NAME: Record<JointKind, string> = { flat: 'Flat', pegs: 'Pegs', dowels: 'Dowels', magnets: 'Magnets', key: 'Key' };
const JOINT_ABOUT: Record<JointKind, string> = {
  flat: 'The cut faces as they are, to glue together.',
  pegs: 'Round pegs on one side and holes on the other, wider by the clearance, so the pieces push together.',
  dowels: 'Holes on both sides and separate dowels (printed, or bought pins or filament of that diameter).',
  magnets: 'Round pockets on both sides for disc magnets, with the clearance round them.',
  key: 'A tongue in the shape of the cut face, inset from its edge, into a groove on the other side: the pieces only fit one way.',
};
const CUT_FACE: ModelMaterial = { name: 'Cut faces', colour: [205, 205, 205] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const deg = (r: number) => (r * 180) / Math.PI, rad = (d: number) => (d * Math.PI) / 180;
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const round = (v: number, k = 1000) => Math.round(v * k) / k;
/** mm with one decimal, never "-0.0" */
const mm = (v: number) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);
const cm3 = (mm3: number) => (mm3 / 1000 >= 10 ? (mm3 / 1000).toFixed(0) : (mm3 / 1000).toFixed(mm3 / 1000 >= 1 ? 1 : 2));

function sizeOf(P: ArrayLike<number>): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], P[i + d]); hi[d] = Math.max(hi[d], P[i + d]); }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}
const sizeText = (s: number[]) => s.map((v) => v.toFixed(v < 10 ? 1 : 0)).join(' × ') + ' mm';

/** Which way a cut faces, in words. */
function facing(n: V3): string {
  for (const [k, a] of Object.entries(AXES)) if (Math.abs(Math.abs(dot(n, a)) - 1) < 1e-4) return `across ${k.toUpperCase()}`;
  return 'tilted';
}

export class CutTab {
  private cuts: Cut[] = [];
  private selected = -1;
  private result: Result | null = null;
  private view: PiecesView | null = null;
  private planes: CutPlanes;
  private showing: 'model' | 'pieces' | 'painted' = 'pieces';
  private active = false;
  private box: { key: string; lo: number[]; hi: number[] } | null = null;
  private palette = '';
  private saved: { joint: Joint; wall: number; spread: number; flat: boolean };

  constructor(private host: CutHost) {
    this.planes = new CutPlanes(host.stage);
    this.planes.targets = () => { const s = host.source(); return s ? [s.target] : []; };
    this.planes.onSelect = (i) => { this.selected = i; this.render(); };
    this.planes.onMove = (i, at, done) => {
      const c = this.cuts[i];
      if (!c) return;
      c.normal = at.normal.map((v) => round(v, 1e6)) as V3;
      c.point = at.point;
      if (done) this.recentre(c);
      this.render(!done);
    };
    let saved: Partial<CutTab['saved']> = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* the defaults */ }
    this.saved = { joint: { ...JOINT_DEFAULTS, ...saved.joint }, wall: saved.wall ?? CUT_DEFAULTS.wall, spread: saved.spread ?? 0.25, flat: saved.flat ?? true };
    $<HTMLInputElement>('cut-wall').value = String(this.saved.wall);
    $<HTMLInputElement>('cut-spread').value = String(this.saved.spread);
    $<HTMLInputElement>('export-flat').checked = this.saved.flat;
    this.wire();
  }

  private remember() {
    this.saved.wall = this.wall();
    this.saved.spread = Number($<HTMLInputElement>('cut-spread').value) || 0;
    this.saved.flat = $<HTMLInputElement>('export-flat').checked;
    try { localStorage.setItem(KEY, JSON.stringify(this.saved)); } catch { /* not kept */ }
  }

  private wall(): number {
    const v = Number($<HTMLInputElement>('cut-wall').value);
    return Number.isFinite(v) && v > 0 ? Math.max(0.4, Math.min(20, v)) : CUT_DEFAULTS.wall;
  }

  // ---------- where the model is ----------
  private bounds(): { lo: number[]; hi: number[]; centre: V3; size: number } | null {
    const s = this.host.source();
    if (!s) return null;
    if (!this.box || this.box.key !== s.key) {
      const P = s.model.mesh.positions;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], P[i + d]); hi[d] = Math.max(hi[d], P[i + d]); }
      this.box = { key: s.key, lo, hi };
    }
    const { lo, hi } = this.box;
    const centre = lo.map((v, i) => (v + hi[i]) / 2) as V3;
    return { lo, hi, centre, size: Math.max(20, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.8) };
  }

  private offsetOf(c: Cut): number {
    const b = this.bounds();
    return b ? dot(c.normal, c.point.map((v, i) => v - b.centre[i])) : 0;
  }

  /** How far the model reaches from its middle along n. */
  private halfOf(n: V3): number {
    const b = this.bounds();
    return b ? 0.5 * (Math.abs(n[0]) * (b.hi[0] - b.lo[0]) + Math.abs(n[1]) * (b.hi[1] - b.lo[1]) + Math.abs(n[2]) * (b.hi[2] - b.lo[2])) : 50;
  }

  /** A plane facing n, `off` from the model's middle: its point is the middle moved along n, so the square stays over the model. */
  private put(c: Cut, n: V3, off: number) {
    const b = this.bounds();
    const centre = b?.centre ?? [0, 0, 0];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    c.normal = n.map((v) => round(v / l, 1e6)) as V3;
    c.point = centre.map((v, i) => round(v + c.normal[i] * off, 1e4)) as V3;
  }
  private recentre(c: Cut) { this.put(c, c.normal, this.offsetOf(c)); }

  private facingMe(): V3 {
    const s = this.host.stage;
    const d = s.camera.position.clone().sub(s.controls.target).normalize();
    return [round(d.x), round(d.y), round(d.z)];
  }

  // ---------- the controls ----------
  private wire() {
    for (const b of $('cut-add').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => this.add(b.dataset.axis as 'x' | 'y' | 'z' | 'view');
    for (const b of $('cut-dir').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => {
      const c = this.sel();
      if (!c) return;
      this.put(c, b.dataset.dir === 'view' ? this.facingMe() : AXES[b.dataset.dir as 'x' | 'y' | 'z'], 0);
      this.edited();
    };
    $('cut-pick').onclick = () => this.pick();
    const slide = (v: number) => {
      const c = this.sel();
      if (!c || !Number.isFinite(v)) return;
      const half = this.halfOf(c.normal);
      this.put(c, c.normal, Math.max(-half, Math.min(half, v)));
      this.edited(true);
    };
    $('cut-position').addEventListener('input', () => slide(Number($<HTMLInputElement>('cut-position').value)));
    $('cut-position-num').addEventListener('change', () => slide(Number($<HTMLInputElement>('cut-position-num').value)));
    const turn = (tilt: number, around: number) => {
      const c = this.sel();
      if (!c || !Number.isFinite(tilt) || !Number.isFinite(around)) return;
      const t = rad(Math.max(0, Math.min(180, tilt))), p = rad(around);
      this.put(c, [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)], this.offsetOf(c));
      this.edited(true);
    };
    const angles = () => this.angles(this.sel()!);
    $('cut-tilt').addEventListener('input', () => turn(Number($<HTMLInputElement>('cut-tilt').value), angles().turn));
    $('cut-tilt-num').addEventListener('change', () => turn(Number($<HTMLInputElement>('cut-tilt-num').value), angles().turn));
    $('cut-turn').addEventListener('input', () => turn(angles().tilt, Number($<HTMLInputElement>('cut-turn').value)));
    $('cut-turn-num').addEventListener('change', () => turn(angles().tilt, Number($<HTMLInputElement>('cut-turn-num').value)));
    for (const b of $('cut-joint').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => this.setJoint({ kind: b.dataset.joint as JointKind });
    const number = (id: string, key: keyof Joint, lo: number, hi: number) => $(id).addEventListener('change', () => {
      const v = Number($<HTMLInputElement>(id).value);
      if (Number.isFinite(v)) this.setJoint({ [key]: Math.max(lo, Math.min(hi, v)) });
    });
    number('cut-clearance', 'clearance', 0, 2);
    number('cut-diameter', 'diameter', 0.5, 50);
    number('cut-magnet-d', 'magnetDiameter', 0.5, 50);
    number('cut-magnet-h', 'magnetHeight', 0.2, 50);
    number('cut-depth', 'depth', 0.5, 100);
    $('cut-count').addEventListener('change', () => this.setJoint({ count: Number($<HTMLSelectElement>('cut-count').value) || 0 }));
    $('cut-flip').addEventListener('change', () => this.setJoint({ flip: $<HTMLInputElement>('cut-flip').checked }));
    $('cut-print-dowels').addEventListener('change', () => this.setJoint({ printDowels: $<HTMLInputElement>('cut-print-dowels').checked }));
    $('cut-joint-all').onclick = () => {
      const c = this.sel();
      if (!c) return;
      for (const x of this.cuts) x.joint = { ...c.joint };
      this.render();
      this.host.status(`Every cut has ${JOINT_NAME[c.joint.kind].toLowerCase()} joints now.`);
    };
    $('cut-wall').addEventListener('change', () => { this.remember(); this.renderResult(); });
    $('cut-run').onclick = () => void this.run();
    for (const b of $('cut-show').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => this.setShow(b.dataset.show as 'model' | 'pieces' | 'painted');
    $('cut-spread').addEventListener('input', () => {
      if (this.showing === 'model') this.setShow('pieces');
      this.applyShow();
    });
    $('cut-spread').addEventListener('change', () => this.remember());
    $('export-flat').addEventListener('change', () => this.remember());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.planes.picking) { this.planes.picking = null; this.render(); this.host.status('Picking a point stopped.'); }
    });
  }

  private sel(): Cut | null { return this.cuts[this.selected] ?? null; }

  private angles(c: Cut): { tilt: number; turn: number } {
    return { tilt: deg(Math.acos(Math.max(-1, Math.min(1, c.normal[2])))), turn: deg(Math.atan2(c.normal[1], c.normal[0])) };
  }

  private add(axis: 'x' | 'y' | 'z' | 'view') {
    if (!this.host.source()) return;
    const c: Cut = { normal: [0, 0, 1], point: [0, 0, 0], joint: { ...this.saved.joint } };
    this.put(c, axis === 'view' ? this.facingMe() : AXES[axis], 0);
    this.cuts.push(c);
    this.selected = this.cuts.length - 1;
    this.edited();
  }

  private remove(i: number) {
    this.cuts.splice(i, 1);
    if (this.selected >= this.cuts.length) this.selected = this.cuts.length - 1;
    else if (this.selected > i) this.selected--;
    this.edited();
  }

  private setJoint(patch: Partial<Joint>) {
    const c = this.sel();
    if (!c) return;
    c.joint = { ...c.joint, ...patch };
    // new cuts take the joint set last
    this.saved.joint = { ...c.joint };
    this.remember();
    this.render();
  }

  private pick() {
    if (this.planes.picking) { this.planes.picking = null; this.render(); return; }
    if (!this.sel()) return;
    this.setShow('model');
    this.planes.picking = (point) => {
      const c = this.sel();
      if (!c) return;
      this.put(c, c.normal, this.offsetOf({ ...c, point: point.toArray() as V3 }));
      this.edited();
      this.host.status(`Cut ${this.selected + 1} goes through the point picked now.`);
    };
    this.render();
    this.host.status('Click the model where the cut should go through.');
  }

  /** A cut moved, came or went: the planes show again, over the model. */
  private edited(quick = false) {
    if (this.showing !== 'model' && this.result) this.setShow('model');
    this.render(quick);
  }

  // ---------- showing it ----------
  /** The tab shown or left: the planes and pieces show only on it. */
  setActive(on: boolean): void {
    this.active = on;
    if (!on) this.planes.picking = null;
    if (on && this.view && this.result) {
      const s = this.host.source();
      const p = s ? JSON.stringify(s.palette) : '';
      if (p !== this.palette) { this.palette = p; this.view.dropLooks(); }
    }
    this.render();
  }

  private setShow(how: 'model' | 'pieces' | 'painted') {
    this.showing = how;
    if (how !== 'model') this.planes.picking = null;
    this.render();
  }

  private applyShow() {
    const stage = this.host.stage;
    const pieces = this.active && !!this.view && this.showing !== 'model';
    const spread = Number($<HTMLInputElement>('cut-spread').value) || 0;
    stage.content.visible = !pieces;
    if (this.view) {
      this.view.object.visible = pieces;
      if (pieces) { this.view.show(this.showing === 'painted' ? 'painted' : 'pieces'); this.view.spread(spread); }
    }
    stage.setPlateVisible(!pieces || spread < 0.01);
    // the model's own Textures | Paint switch does nothing to the pieces
    $('look').style.visibility = pieces ? 'hidden' : '';
    this.planes.visible = this.active && !pieces && !!this.host.source();
    stage.render();
  }

  /** Everything on the tab as it is now. `quick`: only what a drag changes. */
  render(quick = false): void {
    const s = this.host.source();
    const b = this.bounds();
    this.planes.set(this.cuts, this.selected, b?.size ?? 100);
    this.applyShow();
    $('cut-what').textContent = !s ? 'Open a model first.'
      : s.watertight ? 'It cuts the watertight model (Finish tab), keeping its paint.'
      : 'It cuts the original, made solid first as Make watertight does (open surfaces made as thick as set on the Finish tab). Make it watertight there first to fill hollows or add a base.';
    for (const btn of $('cut-add').querySelectorAll<HTMLButtonElement>('button')) btn.disabled = !s;
    this.renderEditor();
    this.renderList();
    this.renderResult(quick);
    if (!quick) this.updateButtons();
  }

  private renderList() {
    $('cut-none').classList.toggle('hidden', this.cuts.length > 0);
    $('cut-list').replaceChildren(...this.cuts.map((c, i) => {
      const j = c.joint;
      const li = h('li', { role: 'option', 'aria-selected': String(i === this.selected), class: i === this.selected ? 'selected' : '', 'data-cut': String(i) },
        h('span', null, `Cut ${i + 1}`, h('small', null, `${facing(c.normal)} · ${mm(this.offsetOf(c))} mm from the middle · ${JOINT_NAME[j.kind]}${j.kind !== 'flat' ? `, ${j.clearance.toFixed(2)} mm clearance` : ''}`)),
        h('button', { type: 'button', title: 'Remove this cut', 'aria-label': `Remove cut ${i + 1}`, onclick: (e: Event) => { e.stopPropagation(); this.remove(i); } }, 'Remove'));
      li.onclick = () => { this.selected = i; this.render(); };
      return li;
    }));
  }

  private renderEditor() {
    const c = this.sel();
    $('cut-edit').classList.toggle('hidden', !c);
    if (!c) return;
    $('cut-edit-title').textContent = `Cut ${this.selected + 1}`;
    const half = this.halfOf(c.normal), off = this.offsetOf(c);
    const step = Math.max(0.1, Math.round((half / 100) * 10) / 10);
    const pos = $<HTMLInputElement>('cut-position'), posNum = $<HTMLInputElement>('cut-position-num');
    pos.min = String(-half); pos.max = String(half); pos.step = String(step); pos.value = String(off);
    posNum.step = String(step);
    if (document.activeElement !== posNum) posNum.value = mm(off);
    fill(pos);
    const { tilt, turn } = this.angles(c);
    const set = (id: string, v: number) => { const el = $<HTMLInputElement>(id); if (document.activeElement !== el) el.value = String(Math.round(v)); if (el.type === 'range') fill(el); };
    set('cut-tilt', tilt); set('cut-tilt-num', tilt); set('cut-turn', turn); set('cut-turn-num', turn);
    const level = tilt < 0.5 || tilt > 179.5;
    $<HTMLInputElement>('cut-turn').disabled = level;
    $<HTMLInputElement>('cut-turn-num').disabled = level;
    const dir = facing(c.normal);
    for (const btn of $('cut-dir').querySelectorAll<HTMLButtonElement>('button')) btn.classList.toggle('active', btn.dataset.dir !== 'view' && dir === `across ${btn.dataset.dir!.toUpperCase()}`);
    const pick = $<HTMLButtonElement>('cut-pick');
    pick.textContent = this.planes.picking ? 'Click the model… (click here to stop)' : 'Pick a point';
    pick.classList.toggle('on', !!this.planes.picking);
    const j = c.joint;
    for (const btn of $('cut-joint').querySelectorAll<HTMLButtonElement>('button')) btn.classList.toggle('active', btn.dataset.joint === j.kind);
    $('cut-joint-about').textContent = JOINT_ABOUT[j.kind];
    const show = (id: string, on: boolean) => $(id).classList.toggle('hidden', !on);
    const round = j.kind === 'pegs' || j.kind === 'dowels';
    show('cut-clearance-row', j.kind !== 'flat');
    show('cut-diameter-row', round);
    show('cut-magnet-d-row', j.kind === 'magnets');
    show('cut-magnet-h-row', j.kind === 'magnets');
    show('cut-depth-row', round || j.kind === 'key');
    show('cut-count-row', round || j.kind === 'magnets');
    show('cut-flip-row', j.kind === 'pegs' || j.kind === 'key');
    show('cut-print-dowels-row', j.kind === 'dowels');
    show('cut-joint-all-row', this.cuts.length > 1);
    $('cut-diameter-label').textContent = j.kind === 'dowels' ? 'Dowel diameter' : 'Peg diameter';
    $('cut-diameter-row').title = j.kind === 'dowels' ? '1.75 mm takes filament as dowels; 3 or 5 mm suits metal pins' : 'The holes are this plus twice the clearance';
    $('cut-depth-label').textContent = j.kind === 'key' ? 'Key height' : 'Depth into each piece';
    $('cut-flip-label').textContent = j.kind === 'key' ? 'The tongue on the other side' : 'Pegs on the other side';
    const value = (id: string, v: number) => { const el = $<HTMLInputElement>(id); if (document.activeElement !== el) el.value = String(v); };
    value('cut-clearance', j.clearance); value('cut-diameter', j.diameter); value('cut-magnet-d', j.magnetDiameter); value('cut-magnet-h', j.magnetHeight); value('cut-depth', j.depth);
    $<HTMLSelectElement>('cut-count').value = String(j.count);
    $<HTMLInputElement>('cut-flip').checked = j.flip;
    $<HTMLInputElement>('cut-print-dowels').checked = j.printDowels;
  }

  private request(): CutSettings {
    return { cuts: this.cuts.map((c) => ({ normal: c.normal, point: c.point, joint: { ...c.joint } })), wall: this.wall() };
  }

  private stale(): string | null {
    const r = this.result, s = this.host.source();
    if (!r || !s) return null;
    if (r.key !== s.key) return r.watertight !== s.watertight
      ? `Cut from the ${r.watertight ? 'watertight model' : 'original'}, not the one shown: cut again to cut this one.`
      : 'The model changed since it was cut (its size or turn): cut again to take that in.';
    if (r.edits !== s.edits) return 'The paint changed since it was cut: cut again to carry it onto the pieces.';
    if (r.request !== JSON.stringify(this.request())) return 'Cut with other planes or joints than these: cut again to see the change.';
    return null;
  }

  /** `quick`: the piece list is as it was (only the note and buttons change while a cut moves). */
  private renderResult(quick = false) {
    const r = this.result;
    $('cut-result').classList.toggle('hidden', !r);
    if (!r) return;
    const stale = this.stale();
    $('cut-stale').classList.toggle('hidden', !stale);
    $('cut-stale').textContent = stale ?? '';
    for (const btn of $('cut-show').querySelectorAll<HTMLButtonElement>('button')) btn.classList.toggle('active', btn.dataset.show === this.showing);
    if (quick) return;
    $('cut-show-painted').textContent = r.painted ? 'Paint' : 'Textures';
    $('cut-show-painted').title = r.painted ? 'Each piece in the paint it took from the model' : 'Each piece in the textures and colours it took from the model';
    fill($<HTMLInputElement>('cut-spread'));
    const pieces = r.out.pieces.filter((p) => p.kind === 'piece').length, dowels = r.out.pieces.length - pieces;
    $('piece-list').replaceChildren(
      h('li', { class: 'muted' }, h('span', null, `${plural(pieces, 'piece')}${dowels ? ` and ${plural(dowels, 'dowel')}` : ''}`), h('span', { class: 'vol' }, `${cm3(r.out.volume)} cm³ in all`)),
      ...r.out.pieces.map((p, i) => h('li', { 'data-piece': String(i), 'data-kind': p.kind },
        h('i', { class: 'piece-swatch', style: { background: pieceColour(i) } }),
        h('span', null, p.name, h('small', null, `${sizeText(sizeOf(p.model.mesh.positions))} · ${plural(p.model.mesh.triangles.length / 3, 'triangle')}`)),
        h('span', { class: 'vol' }, `${cm3(p.volume)} cm³`))));
    $('cut-notes').replaceChildren(...r.out.notes.map((n) => h('li', null, n)));
  }

  private updateButtons() {
    const s = this.host.source();
    const run = $<HTMLButtonElement>('cut-run');
    run.disabled = !s || !this.cuts.length || this.host.jobs.busy;
    run.textContent = this.cuts.length ? `Cut with ${plural(this.cuts.length, 'plane')}` : 'Cut';
  }

  /** What Fit in view frames: the pieces while they are shown (spread apart they reach further than the model). */
  frameBox(): THREE.Box3 | null {
    if (!this.view || !this.view.object.visible) return null;
    return new THREE.Box3().setFromObject(this.view.object);
  }

  // ---------- cutting ----------
  /** The pieces, for saving and the buttons. */
  get pieces(): CutPieceOut[] | null { return this.result?.out.pieces ?? null; }
  get painted(): boolean { return !!this.result?.painted; }

  /** Cuts the model shown with the planes as they are. */
  async run(): Promise<boolean> {
    const s = this.host.source();
    if (!s || !this.cuts.length || this.host.jobs.busy) return false;
    const settings = this.request();
    const request = JSON.stringify(settings);
    const t0 = performance.now();
    this.planes.picking = null;
    this.host.progress(s.watertight ? 'Cutting…' : 'Making it solid to cut…', 0.01, () => this.host.jobs.cancel());
    this.host.status(`Cutting ${s.model.name} with ${plural(this.cuts.length, 'plane')}…`);
    $<HTMLButtonElement>('cut-run').disabled = true;
    this.host.changed();
    try {
      const paint = s.paint ? { colour: s.paint.faceMaterial.slice(), codes: new Map(s.paint.codes) } : null;
      const out = await this.host.jobs.cut(`${s.key}:${s.watertight ? 'solid' : s.sheet}`, s.model.faceGroup, s.watertight, s.sheet, settings, paint, s.model.materials.length, (f, m) => this.host.progress(m, f));
      this.host.progress('Showing the pieces…', 0.99);
      await frame();
      this.view?.dispose();
      this.result = {
        out, key: s.key, edits: s.edits, request, watertight: s.watertight,
        materials: [...s.model.materials, CUT_FACE], looks: [...s.looks, { colour: CUT_FACE.colour }], painted: !!paint,
      };
      this.palette = JSON.stringify(s.palette);
      this.view = new PiecesView(out.pieces.map((p) => p.model.mesh), (i) => this.lookOf(i));
      this.host.stage.extras.add(this.view.object);
      this.showing = 'pieces';
      const secs = (performance.now() - t0) / 1000;
      const pieces = out.pieces.filter((p) => p.kind === 'piece').length, dowels = out.pieces.length - pieces;
      const skipped = out.joints.reduce((a, j) => a + j.skipped, 0);
      this.host.status(`Cut into ${plural(pieces, 'piece')}${dowels ? ` and ${plural(dowels, 'dowel')}` : ''} in ${secs.toFixed(1)} s${skipped ? `; ${plural(skipped, 'place')} left flat (see the Cut tab)` : ''}. Save › Each piece writes them out.`);
      return true;
    } catch (e) {
      this.host.status(e instanceof Cancelled ? 'Cutting stopped.' : `It couldn't be cut: ${errorText(e)}`);
      return false;
    } finally {
      this.host.progress(null);
      this.render();
      this.host.changed();
    }
  }

  /** Piece i in its paint (or its textures, when the model had none). */
  private lookOf(i: number) {
    const r = this.result!;
    const p = r.out.pieces[i];
    const palette = this.host.source()?.palette ?? [[236, 236, 232]];
    if (p.model.paint) {
      const v = new PaintView(p.model.mesh, palette);
      v.restore(p.model.paint.colour, p.model.paint.codes);
      return { object: v.object, dispose: () => v.dispose() };
    }
    const v = new TexturedView(this.pieceModel(p), r.looks);
    return { object: v.object, dispose: () => v.dispose() };
  }

  private pieceModel(p: CutPieceOut): ImportedModel {
    const m = p.model;
    return { name: p.name, format: 'piece', mesh: m.mesh, uvs: m.uvs, vertexColours: m.vertexColours, faceMaterial: m.faceMaterial, faceGroup: m.faceGroup, materials: this.result!.materials, units: 'mm', notes: [] };
  }

  /** A new model is open: its cuts and pieces start afresh. */
  reset(): void {
    this.cuts = [];
    this.selected = -1;
    this.drop();
  }

  private drop() {
    this.view?.dispose();
    this.view = null;
    this.result = null;
    this.box = null;
    this.planes.picking = null;
    this.render();
    this.host.changed();
  }

  // ---------- saving ----------
  /**
   * Saves every piece to its own file in a new folder `<name>_pieces` (a zip
   * of it in a browser): a painted 3MF, a 3MF split by colour or an STL,
   * laid flat to print unless that is turned off. Cuts again first when the
   * pieces are out of date.
   */
  async save(format: PieceFormat, name: string, options: { thumbnail: boolean; depth: number }): Promise<string | null> {
    if (this.stale() && !(await this.run())) return null;
    const r = this.result;
    const s = this.host.source();
    if (!r || !s) return null;
    const flat = $<HTMLInputElement>('export-flat').checked;
    const folder = `${name}_pieces`;
    let where: { folder: string } | null = null;
    if (desktop) {
      const parent = await pickFolder(`Save the ${plural(r.out.pieces.length, 'piece')} in (a new folder ${folder} is made there)`);
      if (!parent) return null;
      where = { folder: await makeFolder(parent, folder) };
    }
    const zip = desktop ? null : new ZipWriter();
    const palette = s.palette;
    const ext = format === 'stl' ? 'stl' : '3mf';
    const files: string[] = [];
    let warnings: string[] = [];
    try {
      for (const [i, p] of r.out.pieces.entries()) {
        const file = `${name}_${p.name.toLowerCase().replace(/\s+/g, '')}${format === 'split' ? ' by colour' : ''}.${ext}`;
        this.host.progress(`Writing ${file}…`, i / r.out.pieces.length);
        await frame();
        const mesh: IndexedMesh = { positions: flat ? printPose({ mesh: p.model.mesh, kind: p.kind, faces: p.faces, axis: p.axis }) : p.model.mesh.positions, triangles: p.model.mesh.triangles };
        const paint = p.model.paint ? new PaintModel(mesh) : null;
        paint?.restore(p.model.paint!.colour, p.model.paint!.codes);
        let bytes: Uint8Array[];
        const stem = `${name} ${p.name.toLowerCase()}`;
        if (format === 'stl') bytes = [stl(mesh, stem)];
        else {
          const thumb = options.thumbnail ? await this.thumbnailOf(mesh, paint, palette) : null;
          if (format === '3mf') bytes = await painted3mf({ name: stem, mesh, codes: paint ? paint.paintCodes() : [], palette, thumbnail: thumb });
          else {
            const baked = paint ? paint.baked() : { mesh, faceMaterial: new Uint8Array(mesh.triangles.length / 3) };
            const split = await splitByMaterial(baked.mesh, baked.faceMaterial, palette.length, { depth: options.depth });
            warnings = warnings.concat(split.warnings.map((w) => `${p.name}: ${w}`));
            bytes = await parts3mf(stem, split.parts.map((q) => ({ name: `Colour ${q.material + 1}`, mesh: q.mesh, colour: q.material })), palette, thumb);
          }
        }
        if (where) await writeFile(where.folder, file, join(bytes));
        else await zip!.add(`${folder}/${file}`, bytes, format !== 'stl'); // a 3MF is a zip already
        files.push(file);
      }
      if (zip) {
        const url = URL.createObjectURL(new Blob(zip.finish() as BlobPart[], { type: 'application/zip' }));
        const a = h('a', { href: url, download: `${folder}.zip` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } finally {
      this.host.progress(null);
    }
    const place = where ? where.folder : `${folder}.zip`;
    this.host.status(`Saved ${plural(files.length, 'file')} in ${place}.`);
    const how = flat ? 'each laid flat on a cut face to print (dowels on end)' : 'each where it is in the model';
    return `${plural(files.length, 'file')} in ${place}, ${how}.` + (warnings.length ? ` ${warnings.join('; ')}.` : '');
  }

  /** A small picture of a piece as it is saved, for the slicer's file list. */
  private async thumbnailOf(mesh: IndexedMesh, paint: PaintModel | null, palette: RGB[]): Promise<Uint8Array | null> {
    let object: THREE.Object3D, dispose: () => void;
    if (paint) {
      const v = new PaintView(mesh, palette);
      v.restore(paint.faceMaterial, paint.codes);
      object = v.object; dispose = () => v.dispose();
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      const m = new THREE.MeshStandardMaterial({ color: hex(palette[0] ?? [236, 236, 232]), flatShading: true, roughness: 0.75 });
      object = new THREE.Mesh(g, m); dispose = () => { g.dispose(); m.dispose(); };
    }
    try { return await this.host.stage.thumbnail(256, object); } finally { dispose(); }
  }
}

/** The coloured part of a slider's track. */
function fill(r: HTMLInputElement) {
  const min = Number(r.min), max = Number(r.max);
  r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
}

// Cutting a model into pieces for printing, with joints between them: a port
// of Dark STL's cut.py.
//
// The model is a solid first: the watertight model (finish.ts) as it is, or
// any other model made solid the way finishing makes it. Each cut is a plane
// that splits every piece it crosses, and a joint for the faces it makes:
//
// - flat: the faces as they are, to glue.
// - pegs: round pegs on one side, holes on the other, wider by the clearance.
// - dowels: holes on both sides and separate dowel pieces (or bought pins, or
//   filament).
// - magnets: round pockets on both sides for disc magnets, with the clearance
//   round them.
// - key: a tongue in the shape of the cut face itself (inset from its edge)
//   into a groove on the other side, so the pieces only go together one way.
//
// Features are placed per island of the cut face (a leg and a sleeve cut by
// one plane each get their own), as far from the edge as they can be; one that
// would break through the far side of a piece is made shorter, or left out
// with a note. Every triangle of a piece says where it came from: the model's
// triangle it is a piece of, or BASE for a face the cut made (the cut face,
// a peg, a hole), so the pieces keep their paint and the cut faces take
// colour 1 (finish-map.ts). Sizes in millimetres. Pure apart from
// manifold's WebAssembly.

import type { CrossSection, Manifold, ManifoldToplevel, Mat4, SimplePolygon, Vec2, Vec3 } from 'manifold-3d';
import { manifold } from './solid.ts';
import { BASE, makeWatertight, Origins, type Progress } from './finish.ts';
import type { IndexedMesh } from './mesh.ts';

export type JointKind = 'flat' | 'pegs' | 'dowels' | 'magnets' | 'key';
export const JOINTS: JointKind[] = ['flat', 'pegs', 'dowels', 'magnets', 'key'];

export interface Joint {
  kind: JointKind;
  /** the gap on each side between parts that slide together, mm */
  clearance: number;
  /** features per island of the cut face; 0: as many as suit it (up to 2) */
  count: number;
  /** pegs and dowels, mm */
  diameter: number;
  /** how far a peg, dowel or the key goes into a piece, mm */
  depth: number;
  magnetDiameter: number;
  magnetHeight: number;
  /** pegs and the tongue on the other side of the cut (normally the side the normal points to) */
  flip: boolean;
  /** dowels: the dowels made as pieces too */
  printDowels: boolean;
}

export const JOINT_DEFAULTS: Joint = { kind: 'pegs', clearance: 0.2, count: 0, diameter: 5, depth: 6, magnetDiameter: 6, magnetHeight: 3, flip: false, printDowels: true };

export interface CutPlane {
  /** the side it points to is the first; any length but none */
  normal: Vec3;
  /** a point on the plane, mm */
  point: Vec3;
  joint?: Partial<Joint>;
}

export interface CutSettings {
  cuts: CutPlane[];
  /** the least material kept between a feature and the outside, mm */
  wall: number;
}

export const CUT_DEFAULTS = { wall: 1.6 };

/** how far a feature reaches past the cut face into the piece it joins, so unions don't meet on a plane, mm */
export const EMBED = 0.3;
export const MAX_FEATURES = 8;
/** how far every plane is moved along its normal (a cut lying exactly on a face of the model would leave a sheet of no thickness), mm */
export const NUDGE = 1.3e-3;

/** A face a cut made on a piece: its outward normal, its plane's offset along it, and whether pegs or a tongue stand on it. */
export interface CutFace { normal: Vec3; offset: number; raised: boolean }

export interface Piece {
  name: string;
  kind: 'piece' | 'dowel';
  mesh: IndexedMesh;
  /** for each triangle, the model's triangle it is a piece of, or BASE for one the cut made */
  source: Int32Array;
  faces: CutFace[];
  /** a dowel's length runs this way */
  axis?: Vec3;
  /** mm³ */
  volume: number;
}

export interface JointReport { cut: number; crossed: number; placed: number; skipped: number; kind: JointKind }

export interface CutResult {
  pieces: Piece[];
  /** what making it solid and placing the joints did */
  notes: string[];
  joints: JointReport[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const FEATURE: Record<JointKind, string> = { flat: 'joint', pegs: 'peg', dowels: 'dowel', magnets: 'magnet', key: 'key' };

type Side = 1 | -1;
/** the slot of a side in a pair: [positive, negative] */
const si = (s: Side) => (s > 0 ? 0 : 1);
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The unit vector; an error for none. */
export function unit(v: ArrayLike<number>): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(l) || l < 1e-9) throw new Error('A cut needs a direction.');
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Two unit vectors across the plane, so (e1, e2, normal) is right-handed. */
function frame(n: Vec3): [Vec3, Vec3] {
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  const k = a[0] <= a[1] && a[0] <= a[2] ? 0 : a[1] <= a[2] ? 1 : 2;
  const axis: Vec3 = [0, 0, 0];
  axis[k] = 1;
  const e1 = unit(cross(n, axis));
  return [e1, cross(n, e1)];
}

/** Model millimetres to the plane's frame (u, v across it, w along the normal, 0 on it), column-major. */
function toPlane(n: Vec3, offset: number): Mat4 {
  const [e1, e2] = frame(n);
  return [e1[0], e2[0], n[0], 0, e1[1], e2[1], n[1], 0, e1[2], e2[2], n[2], 0, 0, 0, -offset, 1];
}

function fromPlane(n: Vec3, offset: number): Mat4 {
  const [e1, e2] = frame(n);
  return [e1[0], e1[1], e1[2], 0, e2[0], e2[1], e2[2], 0, n[0], n[1], n[2], 0, n[0] * offset, n[1] * offset, n[2] * offset, 1];
}

/** Even-odd point-in-polygon over all the contours (outlines and holes). */
function inside(x: number, y: number, polys: SimplePolygon[]): boolean {
  let odd = false;
  for (const p of polys) {
    if (p.length < 3) continue;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      if ((y1 > y) !== (y2 > y) && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) odd = !odd;
    }
  }
  return odd;
}

/** Each point's distance to the nearest side of the contours. */
function edgeDistance(points: Vec2[], polys: SimplePolygon[]): Float64Array {
  const d = new Float64Array(points.length).fill(Infinity);
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
      const ex = bx - ax, ey = by - ay, ll = Math.max(ex * ex + ey * ey, 1e-12);
      for (let q = 0; q < points.length; q++) {
        const [x, y] = points[q];
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / ll));
        const dx = x - (ax + t * ex), dy = y - (ay + t * ey);
        const dd = dx * dx + dy * dy;
        if (dd < d[q]) d[q] = dd;
      }
    }
  }
  for (let q = 0; q < d.length; q++) d[q] = Math.sqrt(d[q]);
  return d;
}

function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Centres for `count` round features (0: as many as suit it, up to 2) of
 * `radius` inside an island of a cut face, each at least `wall` from its edge
 * and `spacing` from the others, as spread out as they can be.
 */
export function placeFeatures(island: CrossSection, radius: number, wall: number, count: number, spacing: number): Vec2[] {
  const inner = island.offset(-(radius + wall), 'Round');
  try {
    if (inner.isEmpty() || inner.area() <= 0) return [];
    const polys = inner.toPolygons();
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of polys) for (const [x, y] of p) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); }
    const step = Math.max(radius / 3, Math.sqrt(Math.max(inner.area(), 1e-9) / 3000), 0.05);
    const nx = Math.ceil((hi[0] + step - lo[0]) / step), ny = Math.ceil((hi[1] + step - lo[1]) / step);
    let cand: Vec2[] = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = lo[0] + i * step, y = lo[1] + j * step;
      if (inside(x, y, polys)) cand.push([x, y]);
    }
    // a sliver: its own corners are inside it
    if (!cand.length) cand = polys.flat().map(([x, y]) => [x, y] as Vec2);
    const depth = edgeDistance(cand, island.toPolygons());
    const want = Math.min(count > 0 ? count : 2, MAX_FEATURES);
    const deepest = cand[argmax(depth)];
    if (want === 1) return [deepest];
    // spread out from one end of the room left: the candidate furthest from its middle, then the one furthest from that...
    const chosen: Vec2[] = [cand[argmax(cand.map((c) => dist2(c, deepest)))]];
    const near = cand.map((c) => dist2(c, chosen[0]));
    while (chosen.length < want) {
      // spread out, but not onto the very edge of the room left
      const score = near.map((d, i) => (d >= spacing ? d + 0.25 * depth[i] : -Infinity));
      const best = argmax(score);
      if (!Number.isFinite(score[best])) break;
      chosen.push(cand[best]);
      for (let i = 0; i < cand.length; i++) near[i] = Math.min(near[i], dist2(cand[i], cand[best]));
    }
    // one only: in the middle, where there is most room
    if (chosen.length === 1 || (count === 0 && dist2(chosen[0], chosen[1]) < spacing * 1.2)) return [deepest];
    return chosen;
  } finally {
    inner.delete();
  }
}

/** The span w0..w1 (on the positive side) mirrored to `side`. */
const sided = (w0: number, w1: number, side: Side): [number, number] => (side > 0 ? [w0, w1] : [-w1, -w0]);

function cylinder(m: ManifoldToplevel, r: number, w0: number, w1: number, at: Vec2): Manifold {
  const c = m.Manifold.cylinder(w1 - w0, r, r, Math.max(24, Math.min(96, Math.trunc(r * 12))));
  const out = c.translate([at[0], at[1], w0]);
  c.delete();
  return out;
}

function extrudeAt(cs: CrossSection, w0: number, w1: number): Manifold {
  const e = cs.extrude(w1 - w0);
  const out = e.translate([0, 0, w0]);
  e.delete();
  return out;
}

/** Whether `feature` lies inside `piece` (so a hole there doesn't break through). The feature is used up. */
function contained(piece: Manifold, feature: Manifold, need = 0.995): boolean {
  try {
    const vol = feature.volume();
    if (vol <= 0) return false;
    const both = piece.intersect(feature);
    const v = both.volume();
    both.delete();
    return v >= need * vol;
  } finally {
    feature.delete();
  }
}

interface Shape { side: Side | 0; kind: 'add' | 'sub' | 'dowel'; shape: Manifold }

/**
 * One peg, dowel or magnet at `c`, or null when it would break through a piece
 * (pegs and dowels are tried shorter first). `local`: the two halves in the
 * plane's frame, [positive, negative].
 */
function roundFeature(m: ManifoldToplevel, j: Joint, c: Vec2, r: number, hr: number, depth: number, clr: number, wall: number, male: Side, local: [Manifold, Manifold]): Shape[] | null {
  if (j.kind === 'pegs') {
    for (const d of [depth, depth * 0.6, depth * 0.35]) {
      if (contained(local[si(-male as Side)], cylinder(m, hr + wall / 2, ...sided(0, d + clr + wall / 2, -male as Side), c))) {
        return [
          { side: male, kind: 'add', shape: cylinder(m, r, ...sided(-EMBED, d, -male as Side), c) },
          { side: -male as Side, kind: 'sub', shape: cylinder(m, hr, ...sided(-EMBED, d + clr, -male as Side), c) },
        ];
      }
    }
    return null;
  }
  const hd = depth + clr;
  const spans = [0, 0];
  for (const side of [1, -1] as Side[]) {
    let found = false;
    for (const d of j.kind === 'dowels' ? [hd, hd * 0.6, hd * 0.35] : [hd]) {
      if (contained(local[si(side)], cylinder(m, hr + wall / 2, ...sided(0, d + wall / 2, side), c))) { spans[si(side)] = d; found = true; break; }
    }
    if (!found) return null;
  }
  const out: Shape[] = ([1, -1] as Side[]).map((side) => ({ side, kind: 'sub' as const, shape: cylinder(m, hr, ...sided(-EMBED, spans[si(side)], side), c) }));
  if (j.kind === 'dowels') out.push({ side: 0, kind: 'dowel', shape: cylinder(m, r, -(spans[1] - clr), spans[0] - clr, c) });
  return out;
}

interface Features { add: [Manifold[], Manifold[]]; sub: [Manifold[], Manifold[]]; dowels: Manifold[]; placed: number; skipped: number }

/** The features of one cut's joint, in the plane's frame: added to and cut from each side, dowel pieces, and how many were placed or left out. */
function jointFeatures(m: ManifoldToplevel, n: Vec3, offset: number, j: Joint, pos: Manifold, neg: Manifold, wall: number): Features {
  const out: Features = { add: [[], []], sub: [[], []], dowels: [], placed: 0, skipped: 0 };
  if (j.kind === 'flat') return out;
  const T = toPlane(n, offset);
  const local: [Manifold, Manifold] = [pos.transform(T), neg.transform(T)];
  try {
    const male: Side = j.flip ? -1 : 1, female = -male as Side;
    const clr = Math.max(j.clearance, 0);
    let section = local[0].isEmpty() ? null : local[0].slice(1e-4);
    if (!section || section.isEmpty()) { section?.delete(); section = local[1].slice(-1e-4); }
    const all = section.isEmpty() ? [] : section.decompose();
    section.delete();
    const islands = all.filter((s) => { const keep = s.area() > 0.5; if (!keep) s.delete(); return keep; });
    for (const island of islands) {
      try {
        if (j.kind === 'key') {
          const t0 = island.offset(-wall, 'Round'), g0 = island.offset(-wall + clr, 'Round');
          const tongue = t0.simplify(0.02), groove = g0.simplify(0.02);
          t0.delete(); g0.delete();
          try {
            if (tongue.isEmpty() || tongue.area() < 1) { out.skipped++; continue; }
            let d = 0, ok = false;
            for (d of [j.depth, j.depth * 0.6, j.depth * 0.35]) {
              if (contained(local[si(female)], extrudeAt(groove, ...sided(0, d + clr, female)))) { ok = true; break; }
            }
            if (!ok) { out.skipped++; continue; }
            out.add[si(male)].push(extrudeAt(tongue, ...sided(-EMBED, d, female)));
            out.sub[si(female)].push(extrudeAt(groove, ...sided(-EMBED, d + clr, female)));
            out.placed++;
          } finally { tongue.delete(); groove.delete(); }
          continue;
        }
        const [r, depth] = j.kind === 'magnets' ? [j.magnetDiameter / 2, j.magnetHeight] : [j.diameter / 2, j.depth];
        const hr = r + clr;
        const centres = placeFeatures(island, hr, wall, j.count, 2 * hr + wall);
        if (!centres.length) { out.skipped++; continue; }
        let made = centres.map((c) => roundFeature(m, j, c, r, hr, depth, clr, wall, male, local));
        if (!made.some(Boolean) && centres.length > 1) {
          // spread out they break through: one in the middle may not
          const deepest = placeFeatures(island, hr, wall, 1, 0);
          made = deepest.length ? [roundFeature(m, j, deepest[0], r, hr, depth, clr, wall, male, local)] : [];
        }
        const fits = made.filter((f): f is Shape[] => f !== null);
        if (!fits.length) { out.skipped++; continue; }
        for (const f of fits) for (const x of f) {
          if (x.kind === 'add') out.add[si(x.side as Side)].push(x.shape);
          else if (x.kind === 'sub') out.sub[si(x.side as Side)].push(x.shape);
          else if (j.printDowels) out.dowels.push(x.shape);
          else x.shape.delete();
        }
        out.placed += fits.length;
      } finally {
        island.delete();
      }
    }
  } finally {
    local[0].delete(); local[1].delete();
  }
  return out;
}

/** The union of the shapes, moved by `T`; the shapes are used up. */
function joined(m: ManifoldToplevel, shapes: Manifold[], T: Mat4): Manifold {
  const u = shapes.length > 1 ? m.Manifold.union(shapes) : shapes[0];
  const out = u.transform(T);
  if (shapes.length > 1) u.delete();
  for (const s of shapes) s.delete();
  return out;
}

/**
 * A model as a solid, ready to cut again and again: each cut starts from the
 * same solid, so moving a plane only cuts again.
 */
export class Cutter {
  private o: Origins;
  private solid: Manifold;
  /** what making it solid did */
  readonly notes: string[];

  private constructor(o: Origins, solid: Manifold, notes: string[]) { this.o = o; this.solid = solid; this.notes = notes; }

  /**
   * The model as a solid. `solid`: it is one already (the watertight model), so
   * it is taken as it is when it is a clean closed surface. Otherwise it is
   * made solid the way finishing does it, without filling hollows, as Dark
   * STL's cut does.
   */
  static async of(mesh: IndexedMesh, options: { solid?: boolean; groups?: ArrayLike<number> | null; sheet?: number; progress?: Progress } = {}): Promise<Cutter> {
    const m = await manifold();
    const o = new Origins(m);
    if (!mesh.triangles.length) throw new Error("There's nothing to cut: the model has no triangles.");
    if (options.solid) {
      const n = mesh.triangles.length / 3;
      const s = o.solid(mesh.positions, mesh.triangles, Int32Array.from({ length: n }, (_, i) => i));
      if (s) return new Cutter(o, s, []);
    }
    const fin = await makeWatertight(mesh, options.groups ?? null, { sheet: options.sheet ?? 1.2, fillHollows: false }, options.progress);
    const s = o.solid(fin.mesh.positions, fin.mesh.triangles, fin.source);
    if (!s) throw new Error("The model couldn't be made solid to cut.");
    return new Cutter(o, s, fin.notes.filter((t) => !t.includes('separate pieces')));
  }

  /** mm³ */
  get volume(): number { return this.solid.volume(); }

  /** The solid split along every plane in turn, each cut's joint added, into watertight pieces: the top first, then the dowels. */
  cut(settings: CutSettings, progress?: Progress): CutResult {
    const m = this.o.m;
    const notes = this.notes.slice();
    const joints: JointReport[] = [];
    const wall = Math.max(settings.wall, 0.4);
    // `own`: made here (the solid itself is kept for the next cut)
    let pieces: { s: Manifold; faces: CutFace[]; own: boolean }[] = [{ s: this.solid, faces: [], own: false }];
    const dowels: { s: Manifold; axis: Vec3 }[] = [];
    const live = new Set<Manifold>();
    try {
      settings.cuts.forEach((c, ci) => {
        const label = `Cut ${ci + 1}`;
        const n = unit(c.normal);
        const j: Joint = { ...JOINT_DEFAULTS, ...c.joint };
        if (!JOINTS.includes(j.kind)) throw new Error(`Unknown joint '${j.kind}'.`);
        // a plane lying exactly on a face of the model (a cut at a round number through a flat base) would split that face
        // into a sheet of no thickness on one side; a shift far below print resolution avoids it
        const offset = dot(n, c.point) + NUDGE;
        progress?.(ci / settings.cuts.length, `${label} of ${settings.cuts.length}`);
        const back = fromPlane(n, offset);
        const male: Side = j.flip ? -1 : 1;
        const next: typeof pieces = [];
        let crossed = 0, placed = 0, skipped = 0;
        for (const p of pieces) {
          const [pos, neg] = p.s.splitByPlane(n, offset);
          if (pos.isEmpty() || neg.isEmpty() || pos.volume() < 1e-3 || neg.volume() < 1e-3) {
            pos.delete(); neg.delete();
            next.push(p);
            continue;
          }
          crossed++;
          const f = jointFeatures(m, n, offset, j, pos, neg, wall);
          placed += f.placed;
          skipped += f.skipped;
          for (const [side, half] of [[1, pos], [-1, neg]] as [Side, Manifold][]) {
            let part = half;
            const raised = f.add[si(side)].length > 0 && side === male;
            if (f.sub[si(side)].length) { const t = joined(m, f.sub[si(side)], back); const x = part.subtract(t); t.delete(); part.delete(); part = x; }
            if (f.add[si(side)].length) { const t = joined(m, f.add[si(side)], back); const x = part.add(t); t.delete(); part.delete(); part = x; }
            live.add(part);
            next.push({ s: part, faces: [...p.faces, { normal: [-side * n[0], -side * n[1], -side * n[2]], offset: -side * offset, raised }], own: true });
          }
          for (const d of f.dowels) { const s = d.transform(back); d.delete(); live.add(s); dowels.push({ s, axis: n }); }
          if (p.own) { live.delete(p.s); p.s.delete(); }
        }
        if (!crossed) notes.push(`${label} doesn't go through the model.`);
        if (skipped) notes.push(`${label}: ${plural(skipped, 'place')} had no room for a ${FEATURE[j.kind]} and ${skipped === 1 ? 'was' : 'were'} left flat.`);
        joints.push({ cut: ci, crossed, placed, skipped, kind: j.kind });
        pieces = next;
      });
      progress?.(0.95, 'Reading the pieces');
      // the pieces from the top down, then the dowels
      const middle = (s: Manifold) => { const b = s.boundingBox(); return (b.min[2] + b.max[2]) / 2; };
      const order = pieces.map((p, i) => ({ i, z: middle(p.s) })).sort((a, b) => b.z - a.z);
      const out: Piece[] = order.map(({ i }, k) => {
        const p = pieces[i];
        return { name: `Piece ${k + 1}`, kind: 'piece', ...this.o.read(p.s, BASE), faces: p.faces, volume: p.s.volume() };
      });
      dowels.forEach((d, k) => out.push({ name: `Dowel ${k + 1}`, kind: 'dowel', ...this.o.read(d.s, BASE), faces: [], axis: d.axis, volume: d.s.volume() }));
      return { pieces: out, notes, joints };
    } finally {
      for (const s of live) s.delete();
    }
  }

  dispose(): void { this.solid.delete(); }
}

/** A model cut into pieces: made solid (see Cutter.of), then cut. */
export async function cutModel(mesh: IndexedMesh, settings: CutSettings, options: { solid?: boolean; groups?: ArrayLike<number> | null; sheet?: number } = {}): Promise<CutResult> {
  const c = await Cutter.of(mesh, options);
  try { return c.cut(settings); } finally { c.dispose(); }
}

// ---------------------------------------------------------------- laying pieces out to print

/** The rotation (3 × 3, row-major) taking unit vector `a` onto `b`. */
export function rotation(a: Vec3, b: Vec3): number[] {
  const u = unit(a), w = unit(b);
  const v = cross(u, w), c = dot(u, w);
  if (c < -0.999999) {
    const k = Math.abs(u[0]) <= Math.abs(u[1]) && Math.abs(u[0]) <= Math.abs(u[2]) ? 0 : Math.abs(u[1]) <= Math.abs(u[2]) ? 1 : 2;
    const e: Vec3 = [0, 0, 0];
    e[k] = 1;
    const ax = unit(cross(u, e));
    return [0, 1, 2].flatMap((r) => [0, 1, 2].map((q) => 2 * ax[r] * ax[q] - (r === q ? 1 : 0)));
  }
  const K = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
  const KK = [0, 1, 2].flatMap((r) => [0, 1, 2].map((q) => K[r * 3] * K[q] + K[r * 3 + 1] * K[3 + q] + K[r * 3 + 2] * K[6 + q]));
  return [0, 1, 2].flatMap((r) => [0, 1, 2].map((q) => (r === q ? 1 : 0) + K[r * 3 + q] + KK[r * 3 + q] / (1 + c)));
}

/** Positions turned by `R` (3 × 3, row-major), then set on the bed: centred over the middle, standing on Z = 0. */
export function onBed(P: ArrayLike<number>, R: number[] | null = null): Float32Array {
  const out = new Float32Array(P.length);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    for (let d = 0; d < 3; d++) {
      const v = R ? R[d * 3] * x + R[d * 3 + 1] * y + R[d * 3 + 2] * z : P[i + d];
      out[i + d] = v;
      if (v < lo[d]) lo[d] = v;
      if (v > hi[d]) hi[d] = v;
    }
  }
  const shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
  for (let i = 0; i < out.length; i += 3) { out[i] += shift[0]; out[i + 1] += shift[1]; out[i + 2] += shift[2]; }
  return out;
}

/**
 * Where a piece's vertices go to print it: turned to lie on its biggest flat
 * cut face (one without pegs or a tongue on it) and set on the bed; a dowel
 * stands on end. A piece without a cut face to lie on stays upright.
 */
export function printPose(piece: Pick<Piece, 'mesh' | 'kind' | 'faces' | 'axis'>): Float32Array {
  const { positions: P, triangles: T } = piece.mesh;
  if (piece.kind === 'dowel') return onBed(P, piece.axis ? rotation(piece.axis, [0, 0, 1]) : null);
  let best: Vec3 | null = null, bestArea = 0;
  for (const face of piece.faces) {
    if (face.raised) continue;
    let area = 0;
    for (let t = 0; t < T.length / 3; t++) {
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const n = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
      const l = Math.hypot(n[0], n[1], n[2]);
      if (!(l > 0) || dot(n, face.normal) / l <= 0.999) continue;
      const mid = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
      if (Math.abs(dot(mid, face.normal) - face.offset) < 0.05) area += l / 2;
    }
    if (area > bestArea) { best = face.normal; bestArea = area; }
  }
  return onBed(P, best ? rotation(best, [0, 0, -1]) : null);
}

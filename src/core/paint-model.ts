// The paint on a model, apart from any viewer: a colour per mesh triangle and,
// for a triangle painted in more than one colour, the slicer's split of it
// (paint-tree.ts). From GusGusGooose's paint model, changed to keep a split
// triangle as its slicer code rather than as a tree: painting a model from its
// textures makes millions of leaves, which as objects would not fit in a page.
// A tool decodes the codes of the triangles it touches, edits the trees and
// writes them back. Codes hold state = colour + 1 (filament n is colour n − 1).
//
// The tools: the brush splits triangles where its edge crosses them, a screen
// stamp (text, a polygon, a picture) splits them where its colours change down
// to about a pixel, and the bucket fills across leaves and whole triangles
// alike. Undo keeps only the triangles a step changed. Pure: the browser's
// PaintView draws it, the tests drive it.

import type { IndexedMesh } from './mesh.ts';
import {
  bakePaint, CORNERS, collapse, decodePaint, encodePaint, forEachLeaf, leafCode, majority, setLeaf, splitLong, walkCode,
  codeShares, type Bary, type PaintNode,
} from './paint-tree.ts';
import { faceAdjacency, faceNormals, floodRegion } from './paint-fill.ts';

/** A screen picture of what to paint: per pixel a palette index, or −1 for nothing; row 0 at the top. */
export interface LabelImage { labels: Int16Array; width: number; height: number }

/** How the model lies on the screen, for a stamp. */
export interface StampView {
  /** a world point → its pixel (x right, y down) */
  project(x: number, y: number, z: number): [number, number];
  /** whether mesh triangle `f` is what shows at that pixel (or one touching it, which is close enough at a pixel) */
  visible(f: number, x: number, y: number): boolean;
}

export interface StampOptions {
  /** stop splitting once a piece is this many pixels across (default 1.5) */
  minPx?: number;
  /** or this many millimetres (default 0.05): finer than any nozzle */
  minEdge?: number;
}

/** deepest split (a sliver halves only its long sides, so it may take more levels than a square-ish face) */
export const MAX_DEPTH = 24;
/** colours a slicer's paint can hold (OrcaSlicer reads 16 filaments) */
export const MAX_COLOURS = 16;

/** A step to undo or redo: the triangles it changed and what they were, or (a change to all of them) the whole paint before it. */
interface Change {
  faces: Map<number, { m: number; code: string | undefined }>;
  full?: { faceMaterial: Uint8Array; codes: Map<number, string> };
}

const stateOf = (m: number) => m + 1;
const colourOf = (s: number) => Math.max(0, s - 1);

export class PaintModel {
  /** each mesh triangle's colour; for a triangle with a code, the colour covering most of it */
  readonly faceMaterial: Uint8Array;
  /** triangles painted in more than one colour: their slicer code (state = colour + 1) */
  codes = new Map<number, string>();
  readonly centroids: Float32Array;
  /** each triangle's farthest corner from its centroid */
  readonly radii: Float32Array;
  readonly count: number;
  readonly mesh: IndexedMesh;
  /** triangles whose look changed since the viewer last caught up; `all` when everything may have */
  protected dirty = new Set<number>();
  protected all = false;
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private current: Change | null = null;
  private adjacency: Int32Array | null = null;
  private normals: Float32Array | null = null;
  /** trees decoded for the step under way */
  private open = new Map<number, PaintNode>();

  constructor(mesh: IndexedMesh) {
    this.mesh = mesh;
    const n = (this.count = mesh.triangles.length / 3);
    this.faceMaterial = new Uint8Array(n);
    this.centroids = new Float32Array(n * 3);
    this.radii = new Float32Array(n);
    this.measure();
  }

  /** After the mesh's vertices moved (the model turned or scaled): its triangles' places again. The paint stays on its triangles. */
  moved(): void {
    this.measure();
    this.normals = null;
    this.all = true;
    this.changed();
  }

  private measure() {
    const P = this.mesh.positions, T = this.mesh.triangles, n = this.count;
    for (let i = 0; i < n; i++) {
      const a = T[i * 3] * 3, b = T[i * 3 + 1] * 3, c = T[i * 3 + 2] * 3;
      const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      this.centroids[i * 3] = x; this.centroids[i * 3 + 1] = y; this.centroids[i * 3 + 2] = z;
      let r = 0;
      for (const v of [a, b, c]) r = Math.max(r, Math.hypot(P[v] - x, P[v + 1] - y, P[v + 2] - z));
      this.radii[i] = r;
    }
  }

  /** Called after every change; the viewer catches up here. */
  protected changed(): void {}

  /** A point of triangle `f` from its corner weights, into `out`. */
  point(f: number, w: ArrayLike<number>, out: number[] = [0, 0, 0], at = 0): number[] {
    const P = this.mesh.positions, T = this.mesh.triangles;
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    for (let d = 0; d < 3; d++) out[d] = P[a + d] * w[at] + P[b + d] * w[at + 1] + P[c + d] * w[at + 2];
    return out;
  }

  /** Whether two triangles share a corner. */
  touches(f: number, g: number): boolean {
    const T = this.mesh.triangles;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (T[f * 3 + i] === T[g * 3 + j]) return true;
    return false;
  }

  get faceNormals(): Float32Array { return (this.normals ??= faceNormals(this.mesh)); }
  get faceAdjacency(): Int32Array { return (this.adjacency ??= faceAdjacency(this.mesh)); }

  // ---------- undo ----------

  /** Starts a step: what changes from here until the next snapshot is undone together. */
  snapshot(): void {
    this.endStep();
    this.current = { faces: new Map() };
  }

  private endStep() {
    if (this.current && (this.current.faces.size || this.current.full)) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    this.current = null;
  }

  /** Notes triangle `f` as it is now, before the step changes it. */
  private remember(f: number) {
    if (!this.current) this.current = { faces: new Map() }; // a change without a snapshot is still undoable
    if (!this.current.full && !this.current.faces.has(f)) this.current.faces.set(f, { m: this.faceMaterial[f], code: this.codes.get(f) });
  }

  private swap(change: Change): Change {
    if (change.full) {
      const back: Change = { faces: new Map(), full: { faceMaterial: Uint8Array.from(this.faceMaterial), codes: this.codes } };
      this.faceMaterial.set(change.full.faceMaterial);
      this.codes = new Map(change.full.codes);
      this.all = true;
      return back;
    }
    const back: Change = { faces: new Map() };
    for (const [f, s] of change.faces) {
      back.faces.set(f, { m: this.faceMaterial[f], code: this.codes.get(f) });
      this.faceMaterial[f] = s.m;
      if (s.code) this.codes.set(f, s.code); else this.codes.delete(f);
      this.dirty.add(f);
    }
    if (change.faces.size > this.count / 4) this.all = true;
    return back;
  }

  undo(): boolean {
    this.endStep();
    const c = this.undoStack.pop();
    if (!c) return false;
    this.redoStack.push(this.swap(c));
    this.changed();
    return true;
  }

  redo(): boolean {
    this.endStep();
    const c = this.redoStack.pop();
    if (!c) return false;
    this.undoStack.push(this.swap(c));
    this.changed();
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0 || !!this.current?.faces.size || !!this.current?.full; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  // ---------- trees ----------

  /** The tree of triangle `f`, to change: decoded from its code, or a one-leaf tree of its colour. */
  protected editTree(f: number): PaintNode {
    let t = this.open.get(f);
    if (t) return t;
    const code = this.codes.get(f);
    t = (code && decodePaint(code, colourOf)) || { v: CORNERS, material: this.faceMaterial[f] };
    this.open.set(f, t);
    return t;
  }

  /** The tree of triangle `f` to read (not to change). */
  treeOf(f: number): PaintNode | undefined {
    const t = this.open.get(f);
    if (t) return t;
    const code = this.codes.get(f);
    return code ? decodePaint(code, colourOf) ?? undefined : undefined;
  }

  /** After editing a tree: merge what became one colour, and keep it as a code unless the whole triangle did. */
  protected settle(f: number, changed = true): void {
    const t = this.open.get(f);
    this.open.delete(f);
    if (!t || !changed) return;
    this.remember(f);
    if (collapse(t)) { this.faceMaterial[f] = t.material; this.codes.delete(f); }
    else { this.codes.set(f, encodePaint(t, stateOf)); this.faceMaterial[f] = majority(t); }
    this.dirty.add(f);
  }

  /** Colours a whole triangle. True if that changed anything. */
  protected setFace(f: number, material: number): boolean {
    if (!this.codes.has(f) && this.faceMaterial[f] === material) return false;
    this.remember(f);
    this.codes.delete(f);
    this.faceMaterial[f] = material;
    this.dirty.add(f);
    return true;
  }

  /** The colour at a point of triangle `f` (its corner weights). */
  colourAt(f: number, w: ArrayLike<number>): number {
    const code = this.codes.get(f);
    if (!code) return this.faceMaterial[f];
    let found = -1, best = -Infinity;
    walkCode(code, (c, state) => {
      // how far inside the leaf the point is: the smallest of its weights in the leaf's own corners
      const inside = insideLeaf(c, w);
      if (inside > best) { best = inside; found = state; }
    });
    return found < 0 ? this.faceMaterial[f] : colourOf(found);
  }

  // ---------- tools ----------

  /** Paints whole triangles. Returns how many changed. */
  paintFaces(faces: ArrayLike<number>, material: number): number {
    let changed = 0;
    for (let i = 0; i < faces.length; i++) if (this.setFace(faces[i], material)) changed++;
    if (changed) this.changed();
    return changed;
  }

  /**
   * Paints everything within `radius` of `p`, splitting the triangles its
   * edge crosses until the pieces are under `minEdge` (default 4 % of the
   * radius, between 0.03 and 0.4 mm). With `facing`, only triangles that
   * face that way (towards the camera) are painted, so a brush on the front
   * of a thin cloak leaves its back alone. Returns how many triangles changed.
   */
  brush(p: { x: number; y: number; z: number }, radius: number, material: number, opts: { minEdge?: number; facing?: [number, number, number] } = {}): number {
    const minEdge = opts.minEdge ?? Math.min(0.4, Math.max(0.03, radius * 0.04));
    const c = this.centroids, r2 = radius * radius;
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    const P = this.mesh.positions, T = this.mesh.triangles;
    const N = opts.facing ? this.faceNormals : null;
    const facing = opts.facing;
    const corner = (v: number, out: number[]) => { out[0] = P[v * 3]; out[1] = P[v * 3 + 1]; out[2] = P[v * 3 + 2]; return out; };
    const d2 = (q: number[]) => (q[0] - p.x) ** 2 + (q[1] - p.y) ** 2 + (q[2] - p.z) ** 2;
    let changed = 0;
    const visit = (f: number, n: PaintNode, depth: number): boolean => {
      this.point(f, n.v[0], A); this.point(f, n.v[1], B); this.point(f, n.v[2], C);
      if (d2(A) <= r2 && d2(B) <= r2 && d2(C) <= r2) {
        if (!n.children && n.material === material) return false;
        setLeaf(n, material);
        return true;
      }
      if (triangleDistance2(p, A, B, C) > r2) return false;
      if (!n.children && n.material === material) return false;
      const e2 = minEdge * minEdge;
      const long: [boolean, boolean, boolean] = [dist2(A, B) > e2, dist2(B, C) > e2, dist2(C, A) > e2];
      if (!(long[0] || long[1] || long[2]) || depth >= MAX_DEPTH) {
        // small enough: all of it or none, by its middle
        const m = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
        if (d2(m) > r2) return false;
        setLeaf(n, material);
        return true;
      }
      if (!n.children) splitLong(n, long);
      let any = false;
      for (const ch of n.children!) if (visit(f, ch, depth + 1)) any = true;
      return any;
    };
    for (let f = 0; f < this.count; f++) {
      const dx = c[f * 3] - p.x, dy = c[f * 3 + 1] - p.y, dz = c[f * 3 + 2] - p.z;
      const reach = radius + this.radii[f];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      if (N && facing && N[f * 3] * facing[0] + N[f * 3 + 1] * facing[1] + N[f * 3 + 2] * facing[2] > 0.05) continue;
      corner(T[f * 3], A); corner(T[f * 3 + 1], B); corner(T[f * 3 + 2], C);
      if (d2(A) <= r2 && d2(B) <= r2 && d2(C) <= r2) { if (this.setFace(f, material)) changed++; continue; }
      if (!this.codes.has(f) && this.faceMaterial[f] === material) continue;
      if (triangleDistance2(p, A, B, C) > r2) continue;
      const hit = visit(f, this.editTree(f), 0);
      if (hit) changed++;
      this.settle(f, hit);
    }
    if (changed) this.changed();
    return changed;
  }

  /**
   * Paints a screen stamp onto the triangles in `candidates`: each piece
   * that lies under one label throughout (and shows on screen) takes it;
   * pieces under a change of label are split until they are about a pixel
   * across, then take the label under their middle. Returns how many
   * triangles changed.
   */
  paintLabels(img: LabelImage, view: StampView, candidates: Iterable<number>, opts: StampOptions = {}): number {
    const { labels: L, width: W, height: H } = img;
    const minPx = opts.minPx ?? 1.5, minEdge = opts.minEdge ?? 0.05;
    // summed counts of label changes between neighbouring pixels, across and down, so any box asks "one label?" in O(1)
    const SW = W + 1;
    const sh = new Int32Array(SW * (H + 1)), sv = new Int32Array(SW * (H + 1));
    let lx0 = W, ly0 = H, lx1 = -1, ly1 = -1;
    for (let y = 0; y < H; y++) {
      let rowH = 0, rowV = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (L[i] >= 0) { if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y; }
        rowH += x + 1 < W && L[i] !== L[i + 1] ? 1 : 0;
        rowV += y + 1 < H && L[i] !== L[i + W] ? 1 : 0;
        sh[(y + 1) * SW + x + 1] = sh[y * SW + x + 1] + rowH;
        sv[(y + 1) * SW + x + 1] = sv[y * SW + x + 1] + rowV;
      }
    }
    if (lx1 < 0) return 0;
    const sum = (s: Int32Array, x0: number, y0: number, x1: number, y1: number) => s[(y1 + 1) * SW + x1 + 1] - s[y0 * SW + x1 + 1] - s[(y1 + 1) * SW + x0] + s[y0 * SW + x0];
    /** the one label over a pixel box (inclusive, on the image), or null when it changes inside */
    const uniform = (x0: number, y0: number, x1: number, y1: number): number | null => {
      if (x1 > x0 && sum(sh, x0, y0, x1 - 1, y1) > 0) return null;
      if (y1 > y0 && sum(sv, x0, y0, x1, y1 - 1) > 0) return null;
      return L[y0 * W + x0];
    };
    const clampX = (v: number) => Math.max(0, Math.min(W - 1, Math.floor(v)));
    const clampY = (v: number) => Math.max(0, Math.min(H - 1, Math.floor(v)));
    const onImage = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    const visit = (f: number, n: PaintNode, depth: number): boolean => {
      this.point(f, n.v[0], A); this.point(f, n.v[1], B); this.point(f, n.v[2], C);
      const a = view.project(A[0], A[1], A[2]), b = view.project(B[0], B[1], B[2]), c = view.project(C[0], C[1], C[2]);
      const minx = Math.min(a[0], b[0], c[0]), maxx = Math.max(a[0], b[0], c[0]);
      const miny = Math.min(a[1], b[1], c[1]), maxy = Math.max(a[1], b[1], c[1]);
      if (maxx < lx0 || minx >= lx1 + 1 || maxy < ly0 || miny >= ly1 + 1) return false; // nowhere near the stamp
      const u = uniform(clampX(minx), clampY(miny), clampX(maxx), clampY(maxy));
      if (u !== null && u < 0) return false;
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
      const inView = minx >= 0 && miny >= 0 && maxx < W && maxy < H;
      let seen = 0;
      for (const [x, y] of [a, b, c, [cx, cy]]) if (onImage(x, y) && view.visible(f, x, y)) seen++;
      if (u !== null && seen === 4 && inView) {
        if (!n.children && n.material === u) return false;
        setLeaf(n, u);
        return true;
      }
      // a side is worth splitting while it spans more than a pixel or so and more than the finest the print shows
      const pxLong = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > minPx * minPx;
      const long: [boolean, boolean, boolean] = [pxLong(a, b) && dist2(A, B) > minEdge * minEdge, pxLong(b, c) && dist2(B, C) > minEdge * minEdge, pxLong(c, a) && dist2(C, A) > minEdge * minEdge];
      const px = Math.sqrt(Math.max((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2, (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2));
      if (!(long[0] || long[1] || long[2]) || depth >= MAX_DEPTH) {
        // as small as it gets: the label under its middle, if it shows there
        if (!onImage(cx, cy) || !view.visible(f, cx, cy)) return false;
        const label = L[Math.floor(cy) * W + Math.floor(cx)];
        if (label < 0 || (!n.children && n.material === label)) return false;
        setLeaf(n, label);
        return true;
      }
      if (seen === 0 && px < 6) return false; // hidden behind something
      if (!n.children) splitLong(n, long);
      let any = false;
      for (const ch of n.children!) if (visit(f, ch, depth + 1)) any = true;
      return any;
    };
    let changed = 0;
    for (const f of candidates) {
      const hit = visit(f, this.editTree(f), 0);
      if (hit) changed++;
      this.settle(f, hit);
    }
    if (changed) this.changed();
    return changed;
  }

  /**
   * Bucket fill from the point `w` (corner weights) of triangle `face`: the
   * connected region of the colour there, not across creases sharper than
   * `maxAngleDeg`. Only the triangles the region may reach (those holding
   * that colour, joined across gentle edges) are baked to find it. Returns
   * how many triangles changed.
   */
  bucket(face: number, w: ArrayLike<number>, material: number, maxAngleDeg: number): number {
    const seedColour = this.colourAt(face, w);
    if (seedColour === material) return 0;
    const adj = this.faceAdjacency, normals = this.faceNormals;
    const cosMax = Math.cos((Math.min(180, maxAngleDeg) * Math.PI) / 180);
    const holds = (f: number) => (this.codes.has(f) ? this.codeHolds(f, seedColour) : this.faceMaterial[f] === seedColour);
    // the triangles it may reach
    const seen = new Uint8Array(this.count);
    const reach: number[] = [];
    const stack = [face];
    seen[face] = 1;
    let anyCode = false;
    while (stack.length) {
      const f = stack.pop()!;
      reach.push(f);
      if (this.codes.has(f)) anyCode = true;
      for (let k = 0; k < 3; k++) {
        const g = adj[f * 3 + k];
        if (g < 0 || seen[g] || !holds(g)) continue;
        const d = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
        if (d < cosMax) continue;
        seen[g] = 1;
        stack.push(g);
      }
    }
    let changed = 0;
    if (!anyCode) {
      // whole triangles only: the region is exactly what was reached
      for (const f of reach) if (this.setFace(f, material)) changed++;
      if (changed) this.changed();
      return changed;
    }
    const trees = new Map<number, PaintNode>();
    for (const f of reach) { const t = this.treeOf(f); if (t) trees.set(f, t); }
    const b = bakePaint(this.mesh, this.faceMaterial, trees, reach);
    // the baked triangle under the seed point
    let seed = -1;
    const seedTree = trees.get(face);
    let seedLeaf = -1;
    if (seedTree) {
      let k = 0, best = -Infinity;
      forEachLeaf(seedTree, (l) => {
        const c = new Float64Array([...l.v[0], ...l.v[1], ...l.v[2]]);
        const inside = insideLeaf(c, w);
        if (inside > best) { best = inside; seedLeaf = k; }
        k++;
      });
    }
    for (let i = 0; i < b.source.length; i++) if (b.source[i] === face && (seedLeaf < 0 || b.leafIndex[i] === seedLeaf)) { seed = i; break; }
    if (seed < 0) return 0;
    const region = floodRegion(faceAdjacency(b.mesh), faceNormals(b.mesh), b.faceMaterial, seed, maxAngleDeg);
    const whole = new Set<number>(), parts = new Map<number, Set<number>>();
    for (const i of region) {
      const f = b.source[i], k = b.leafIndex[i];
      if (k < 0) whole.add(f);
      else { let s = parts.get(f); if (!s) parts.set(f, (s = new Set())); s.add(k); }
    }
    for (const f of whole) if (this.setFace(f, material)) changed++;
    for (const [f, ks] of parts) {
      const t = trees.get(f)!;
      this.open.set(f, t);
      let k = 0, any = false;
      forEachLeaf(t, (l) => { if (ks.has(k++) && l.material !== material) { l.material = material; any = true; } });
      if (any) changed++;
      this.settle(f, any);
    }
    if (changed) this.changed();
    return changed;
  }

  /** Whether triangle `f`'s code has any leaf of `colour`. */
  private codeHolds(f: number, colour: number): boolean {
    const code = this.codes.get(f);
    if (!code) return this.faceMaterial[f] === colour;
    let yes = false;
    const want = stateOf(colour);
    walkCode(code, (_c, s) => { if (s === want) yes = true; });
    return yes;
  }

  /** Keeps the whole paint as it is, before a change to all of it (a step of its own). */
  private rememberAll() {
    this.endStep();
    this.current = { faces: new Map(), full: { faceMaterial: Uint8Array.from(this.faceMaterial), codes: new Map(this.codes) } };
  }

  /** Every triangle one colour. */
  fillAll(material: number): void {
    this.rememberAll();
    this.codes.clear();
    this.faceMaterial.fill(material);
    this.all = true;
    this.changed();
  }

  /** Sets every triangle's colour (no codes). */
  setFaces(faceMaterial: ArrayLike<number>): void {
    this.rememberAll();
    this.codes.clear();
    this.faceMaterial.set(faceMaterial);
    this.all = true;
    this.changed();
  }

  /** Puts paint on the model: every triangle's colour and the codes of those painted in part (state = colour + 1). */
  restore(faceMaterial: ArrayLike<number>, codes: Map<number, string> | (string | undefined)[], keepHistory = false): void {
    if (faceMaterial.length !== this.count) throw new Error(`the paint has ${faceMaterial.length} faces, the model ${this.count}`);
    if (keepHistory) this.rememberAll(); else { this.undoStack = []; this.redoStack = []; this.current = null; }
    this.faceMaterial.set(faceMaterial);
    this.codes = new Map();
    const entries: Iterable<[number, string | undefined]> = codes instanceof Map ? codes : codes.map((c, i) => [i, c] as [number, string | undefined]);
    for (const [f, c] of entries) if (c && f >= 0 && f < this.count) this.codes.set(f, c);
    this.all = true;
    this.changed();
  }

  /**
   * Gives every colour another: `map[old] = new`. Codes whose leaves now
   * agree are merged. Used to swap one colour for another everywhere and to
   * close up the palette when a colour is removed.
   */
  remap(map: ArrayLike<number>): void {
    this.rememberAll();
    for (let f = 0; f < this.count; f++) this.faceMaterial[f] = map[this.faceMaterial[f]] ?? 0;
    for (const [f, code] of this.codes) {
      const t = decodePaint(code, (s) => map[colourOf(s)] ?? 0);
      if (!t) { this.codes.delete(f); continue; }
      if (collapse(t)) { this.codes.delete(f); this.faceMaterial[f] = t.material; }
      else { this.codes.set(f, encodePaint(t, stateOf)); this.faceMaterial[f] = majority(t); }
    }
    this.all = true;
    this.changed();
  }

  // ---------- reading the paint ----------

  get painted(): boolean { return this.codes.size > 0 || this.faceMaterial.some((m) => m !== 0); }

  /** Triangles with any paint other than the first colour on them. */
  get paintedFaces(): number {
    let n = 0;
    for (let f = 0; f < this.count; f++) if (this.faceMaterial[f] !== 0 || this.codes.has(f)) n++;
    return n;
  }

  /** How many leaves the codes hold (a slicer slows down past a few million). */
  leafCount(): number {
    let n = 0;
    for (const code of this.codes.values()) walkCode(code, () => n++);
    return n + (this.count - this.codes.size);
  }

  /** The area each colour covers, in the mesh's units squared. */
  colourAreas(colours = MAX_COLOURS): Float64Array {
    const out = new Float64Array(colours);
    const P = this.mesh.positions, T = this.mesh.triangles;
    const share = new Float64Array(colours + 1);
    for (let f = 0; f < this.count; f++) {
      const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      const code = this.codes.get(f);
      if (!code) { const m = this.faceMaterial[f]; if (m < colours) out[m] += area; continue; }
      share.fill(0);
      codeShares(code, share);
      for (let s = 1; s <= colours; s++) out[s - 1] += share[s] * area;
    }
    return out;
  }

  /** Every colour that shows somewhere. */
  materialsUsed(): Set<number> {
    const used = new Set<number>();
    for (let f = 0; f < this.count; f++) if (!this.codes.has(f)) used.add(this.faceMaterial[f]);
    for (const code of this.codes.values()) walkCode(code, (_c, s) => used.add(colourOf(s)));
    return used;
  }

  /**
   * The slicer paint code of every triangle ('' where the triangle is all
   * colour 0, which is the object's own filament): filament n is colour n − 1.
   */
  paintCodes(): string[] {
    const whole: string[] = [];
    const out: string[] = new Array(this.count);
    for (let f = 0; f < this.count; f++) {
      const code = this.codes.get(f);
      if (code) { out[f] = code; continue; }
      const m = this.faceMaterial[f];
      out[f] = m === 0 ? '' : (whole[m] ??= leafCode(stateOf(m)));
    }
    return out;
  }

  /** The paint as whole triangles (leaves made real, T-junctions closed): for a split by colour. */
  baked() {
    if (!this.codes.size) {
      return { mesh: this.mesh, faceMaterial: Uint8Array.from(this.faceMaterial), source: Uint32Array.from({ length: this.count }, (_, i) => i), leafIndex: new Int32Array(this.count).fill(-1) };
    }
    return bakePaint(this.mesh, this.faceMaterial, (f) => this.treeOf(f));
  }
}

/** How far inside a leaf (corners as 9 weights) the point `w` lies: its smallest weight in the leaf's corners (≥ 0 inside). */
function insideLeaf(c: ArrayLike<number>, w: ArrayLike<number>): number {
  // solve w = l0 c0 + l1 c1 + l2 c2 in the (w1, w2) plane
  const x0 = c[1], y0 = c[2], x1 = c[4], y1 = c[5], x2 = c[7], y2 = c[8];
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-18) return -Infinity;
  const px = w[1] - x0, py = w[2] - y0;
  const l1 = (px * (y2 - y0) - (x2 - x0) * py) / det;
  const l2 = ((x1 - x0) * py - px * (y1 - y0)) / det;
  return Math.min(1 - l1 - l2, l1, l2);
}

const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Squared distance from `p` to the triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function triangleDistance2(p: { x: number; y: number; z: number }, a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): number {
  return pointTriangle2(p.x, p.y, p.z, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** triangleDistance2 on plain numbers (no arrays or closures, for the hot loops). */
export function pointTriangle2(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let s = 0, t = 0;
  if (d1 <= 0 && d2 <= 0) { s = 0; t = 0; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { s = 1; t = 0; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { s = d1 / (d1 - d3); t = 0; }
    else if (d6 >= 0 && d5 <= d6) { s = 0; t = 1; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { s = 0; t = d2 / (d2 - d6); }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); s = 1 - w; t = w; }
    else { const denom = 1 / (va + vb + vc); s = vb * denom; t = vc * denom; }
  }
  const qx = ax + abx * s + acx * t - px, qy = ay + aby * s + acy * t - py, qz = az + abz * s + acz * t - pz;
  return qx * qx + qy * qy + qz * qz;
}

export type { Bary };

// The paint as three.js draws it: one drawn triangle per mesh triangle and,
// for a triangle painted in more than one colour, one per leaf of its code
// instead (its own slot then left empty). Leaves sit in blocks after the
// mesh's own triangles, so a stroke rewrites only the blocks it touched, and
// the block area is packed again when too much of it is stale. Each drawn
// vertex is its position and a palette index (13 bytes), the palette a
// uniform and the shading flat from screen derivatives, so a model painted
// from its textures, with millions of leaves, still fits. A backing mesh of
// the split triangles, whole and pushed back, fills the hairline cracks a GPU
// leaves where leaves meet a neighbour's edge, and is what picking sees of
// them (pick.ts): every mesh triangle drawn whole exactly once.

import * as THREE from 'three';
import type { IndexedMesh } from '../core/mesh.ts';
import { walkCode } from '../core/paint-tree.ts';
import { PaintModel, MAX_COLOURS } from '../core/paint-model.ts';
import type { RGB } from '../core/colour.ts';

const VERTEX = /* glsl */ `
attribute float paint;
uniform vec3 palette[${MAX_COLOURS}];
varying vec3 vColour;
varying vec3 vView;
varying vec3 vWorld;
void main() {
  int i = int(paint + 0.5);
  vColour = palette[i < ${MAX_COLOURS} ? i : 0];
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 view = viewMatrix * world;
  vView = view.xyz;
  gl_Position = projectionMatrix * view;
}`;

const FRAGMENT = /* glsl */ `
uniform vec4 brush;
uniform vec3 brushColour;
uniform float highlight;
uniform float pickColour;
varying vec3 vColour;
varying vec3 vView;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 key = normalize(vec3(-0.35, 0.55, 0.75));
  vec3 fill = normalize(vec3(0.6, -0.2, 0.4));
  float light = 0.38 + 0.55 * max(dot(n, key), 0.0) + 0.17 * max(dot(n, fill), 0.0);
  vec3 c = vColour * light;
  if (brush.w > 0.0) {
    float d = length(vWorld - brush.xyz);
    float px = length(fwidth(vWorld)) * 1.2;
    float ring = 1.0 - smoothstep(0.0, px, abs(d - brush.w));
    float inside = step(d, brush.w);
    c = mix(c, mix(c, brushColour, 0.25), inside * highlight);
    c = mix(c, vec3(1.0, 0.72, 0.29), ring);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const BACKING_FRAGMENT = /* glsl */ `
varying vec3 vColour;
varying vec3 vView;
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 key = normalize(vec3(-0.35, 0.55, 0.75));
  vec3 fill = normalize(vec3(0.6, -0.2, 0.4));
  float light = 0.38 + 0.55 * max(dot(n, key), 0.0) + 0.17 * max(dot(n, fill), 0.0);
  gl_FragColor = vec4(vColour * light, 1.0);
  #include <colorspace_fragment>
}`;

const BACKING_VERTEX = VERTEX.replace('varying vec3 vWorld;', '').replace('vWorld = world.xyz;', '');

export class PaintView extends PaintModel {
  readonly geometry = new THREE.BufferGeometry();
  readonly backing = new THREE.BufferGeometry();
  readonly material: THREE.ShaderMaterial;
  readonly backingMaterial: THREE.ShaderMaterial;
  readonly object = new THREE.Group();
  private pos = new Float32Array(0);
  private col = new Uint8Array(0);
  private capacity = 0;
  private end: number;
  private stale = 0;
  private blocks = new Map<number, { start: number; size: number }>();
  private ranges: [number, number][] = [];
  private full = false;
  private paletteColours: THREE.Color[];
  /** called after the paint changed (the app updates its numbers) */
  onChange: (() => void) | null = null;

  constructor(mesh: IndexedMesh, palette: RGB[]) {
    super(mesh);
    this.paletteColours = Array.from({ length: MAX_COLOURS }, () => new THREE.Color(0xdddddd));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, side: THREE.DoubleSide,
      uniforms: { palette: { value: this.paletteColours }, brush: { value: new THREE.Vector4(0, 0, 0, 0) }, brushColour: { value: new THREE.Color() }, highlight: { value: 1 }, pickColour: { value: 0 } },
    });
    this.backingMaterial = new THREE.ShaderMaterial({
      vertexShader: BACKING_VERTEX, fragmentShader: BACKING_FRAGMENT, side: THREE.DoubleSide,
      uniforms: { palette: { value: this.paletteColours } },
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    });
    this.setPalette(palette);
    this.end = this.count;
    this.allocate(this.count + Math.max(4096, this.count >> 3));
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(mesh.positions, 3));
    this.geometry.boundingBox = box;
    this.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    this.backing.boundingBox = box;
    this.backing.boundingSphere = this.geometry.boundingSphere;
    const front = new THREE.Mesh(this.geometry, this.material);
    const back = new THREE.Mesh(this.backing, this.backingMaterial);
    front.frustumCulled = false; back.frustumCulled = false;
    front.raycast = () => {}; back.raycast = () => {};
    this.object.add(back, front);
    this.all = true;
    this.sync();
  }

  setPalette(palette: RGB[]): void {
    for (let i = 0; i < MAX_COLOURS; i++) {
      const c = palette[i] ?? palette[0] ?? [220, 220, 220];
      this.paletteColours[i].setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
    }
  }

  /** The brush's ring on the surface (radius 0 hides it). */
  showBrush(at: THREE.Vector3 | null, radius: number, colour?: RGB): void {
    const u = this.material.uniforms;
    if (!at) { (u.brush.value as THREE.Vector4).set(0, 0, 0, 0); return; }
    (u.brush.value as THREE.Vector4).set(at.x, at.y, at.z, radius);
    if (colour) (u.brushColour.value as THREE.Color).setRGB(colour[0] / 255, colour[1] / 255, colour[2] / 255, THREE.SRGBColorSpace);
  }

  /** After the mesh's vertices moved (the model turned or scaled): the paint stays on its triangles. */
  override moved(): void {
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(this.mesh.positions, 3));
    this.geometry.boundingBox = box;
    this.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    this.backing.boundingBox = box;
    this.backing.boundingSphere = this.geometry.boundingSphere;
    super.moved();
  }

  protected override changed(): void { super.changed(); this.sync(); this.onChange?.(); }

  dispose(): void {
    this.geometry.dispose(); this.backing.dispose(); this.material.dispose(); this.backingMaterial.dispose();
  }

  private allocate(capacity: number) {
    const keep = Math.min(this.capacity, capacity);
    const pos = new Float32Array(capacity * 9), col = new Uint8Array(capacity * 3);
    if (keep) { pos.set(this.pos.subarray(0, keep * 9)); col.set(this.col.subarray(0, keep * 3)); }
    this.pos = pos; this.col = col;
    this.capacity = capacity;
    this.geometry.dispose();
    const p = new THREE.BufferAttribute(pos, 3); p.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.BufferAttribute(col, 1); c.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', p);
    this.geometry.setAttribute('paint', c);
    this.full = true;
  }

  private readonly pt = [0, 0, 0];
  /** Drawn triangle `t` as a piece of mesh triangle `f` (corner weights `w`, 9 numbers; null for none) in colour `colour`. */
  private write(t: number, f: number, w: ArrayLike<number> | null, colour: number) {
    const pos = this.pos, col = this.col, o = t * 9;
    if (!w) { pos.fill(0, o, o + 9); col.fill(0, t * 3, t * 3 + 3); return; }
    const P = this.mesh.positions, T = this.mesh.triangles;
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const w0 = w[k * 3], w1 = w[k * 3 + 1], w2 = w[k * 3 + 2];
      pos[o + k * 3] = P[a] * w0 + P[b] * w1 + P[c] * w2;
      pos[o + k * 3 + 1] = P[a + 1] * w0 + P[b + 1] * w1 + P[c + 1] * w2;
      pos[o + k * 3 + 2] = P[a + 2] * w0 + P[b + 2] * w1 + P[c + 2] * w2;
    }
    col[t * 3] = col[t * 3 + 1] = col[t * 3 + 2] = colour;
  }

  private static readonly WHOLE = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  private writeFace(f: number) {
    const code = this.codes.get(f);
    this.write(f, f, code ? null : PaintView.WHOLE, this.faceMaterial[f]);
    this.mark(f, 1);
    let b = this.blocks.get(f);
    if (!code) {
      if (b) { this.clear(b.start, b.size); this.stale += b.size; this.blocks.delete(f); }
      return;
    }
    let leaves = 0;
    walkCode(code, () => leaves++);
    if (!b || b.size < leaves) {
      if (b) { this.clear(b.start, b.size); this.stale += b.size; }
      const size = leaves + (leaves >> 2) + 1;
      if (this.end + size > this.capacity) this.allocate(Math.max(Math.ceil(this.capacity * 1.5), this.end + size));
      b = { start: this.end, size };
      this.end += size;
      this.blocks.set(f, b);
    }
    let k = 0;
    const start = b.start;
    walkCode(code, (w, state) => { this.write(start + k++, f, w, Math.max(0, state - 1)); });
    if (k < b.size) this.clear(b.start + k, b.size - k);
    this.mark(b.start, b.size);
  }

  private clear(start: number, size: number) {
    this.pos.fill(0, start * 9, (start + size) * 9);
    this.mark(start, size);
  }

  private mark(start: number, size: number) {
    if (this.full) return;
    if (this.ranges.length >= 512) { this.full = true; this.ranges = []; return; }
    const last = this.ranges[this.ranges.length - 1];
    if (last && last[0] + last[1] === start) last[1] += size; else this.ranges.push([start, size]);
  }

  /** Catches the drawn triangles up with the paint. */
  private sync() {
    if (this.all) {
      // everything again, the blocks packed tight
      this.blocks.clear();
      let leaves = 0;
      for (const code of this.codes.values()) walkCode(code, () => leaves++);
      const need = this.count + Math.ceil(leaves * 1.1) + this.codes.size + 4096;
      if (need > this.capacity || need < this.capacity / 3) this.allocate(need);
      this.end = this.count;
      this.stale = 0;
      this.full = true;
      this.ranges = [];
      for (let f = 0; f < this.count; f++) this.writeFace(f);
      this.all = false;
    } else {
      for (const f of this.dirty) this.writeFace(f);
      if (this.stale > Math.max(65536, (this.end - this.count) >> 1)) { this.all = true; this.dirty.clear(); this.sync(); return; }
    }
    this.dirty.clear();
    this.geometry.setDrawRange(0, this.end * 3);
    for (const [name, width] of [['position', 9], ['paint', 3]] as const) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      if (!this.full) for (const [s, n] of this.ranges) a.addUpdateRange(s * width, n * width);
      a.needsUpdate = true;
    }
    this.ranges = [];
    this.full = false;
    this.syncBacking();
  }

  private backingCapacity = 0;
  private syncBacking() {
    const n = this.codes.size;
    if (!this.backingCapacity || n > this.backingCapacity || (this.backingCapacity > 4096 && n < this.backingCapacity / 4)) {
      this.backing.dispose();
      this.backingCapacity = Math.max(256, Math.ceil(n * 1.5));
      this.backing.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.backingCapacity * 9), 3));
      this.backing.setAttribute('paint', new THREE.BufferAttribute(new Uint8Array(this.backingCapacity * 3), 1));
      this.backing.setAttribute('face', new THREE.BufferAttribute(new Float32Array(this.backingCapacity * 3), 1));
    }
    const pos = (this.backing.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const col = (this.backing.getAttribute('paint') as THREE.BufferAttribute).array as Uint8Array;
    const ids = (this.backing.getAttribute('face') as THREE.BufferAttribute).array as Float32Array;
    const P = this.mesh.positions, T = this.mesh.triangles;
    let t = 0;
    for (const f of this.codes.keys()) {
      for (let k = 0; k < 3; k++) {
        const v = T[f * 3 + k] * 3;
        pos[t * 9 + k * 3] = P[v]; pos[t * 9 + k * 3 + 1] = P[v + 1]; pos[t * 9 + k * 3 + 2] = P[v + 2];
      }
      col[t * 3] = col[t * 3 + 1] = col[t * 3 + 2] = this.faceMaterial[f];
      ids[t * 3] = ids[t * 3 + 1] = ids[t * 3 + 2] = f;
      t++;
    }
    this.backing.setDrawRange(0, n * 3);
    for (const name of ['position', 'paint', 'face']) {
      const a = this.backing.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n * (name === 'position' ? 9 : 3)));
      a.needsUpdate = true;
    }
  }
}

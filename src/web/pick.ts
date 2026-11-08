// Which mesh triangle is under a pixel: the paint view's triangles drawn once
// more into an off-screen target with their triangle's number as the colour,
// and read back. The whole triangles are the paint view's own first slots
// (triangle t is drawn vertices 3t..3t+2, so the number is gl_VertexID / 3);
// the split ones come from its backing, which draws each of them whole with
// its number beside it. Both sides count, so the inside of an open cloak is
// picked where it shows. For the brush and the bucket one pixel is drawn
// (the camera's view offset narrowed to it); a stamp reads the whole view.

import * as THREE from 'three';
import type { PaintView } from './paint-view.ts';

const ENCODE = /* glsl */ `
vec3 encode(int f) {
  int id = f + 1;
  return vec3(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255)) / 255.0;
}`;

const wholeMaterial = new THREE.ShaderMaterial({
  vertexShader: `${ENCODE}
flat varying vec3 vId;
void main() { vId = encode(gl_VertexID / 3); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `flat varying vec3 vId; void main() { gl_FragColor = vec4(vId, 1.0); }`,
  side: THREE.DoubleSide, toneMapped: false,
});

const splitMaterial = new THREE.ShaderMaterial({
  vertexShader: `${ENCODE}
attribute float face;
flat varying vec3 vId;
void main() { vId = encode(int(face + 0.5)); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `flat varying vec3 vId; void main() { gl_FragColor = vec4(vId, 1.0); }`,
  side: THREE.DoubleSide, toneMapped: false,
});

export interface Hit {
  face: number;
  point: THREE.Vector3;
  /** the point's weights of the triangle's corners */
  weights: [number, number, number];
  /** whether the triangle's front shows */
  front: boolean;
}

export class Picker {
  private scene = new THREE.Scene();
  private whole: THREE.Mesh;
  private split: THREE.Mesh;
  private one = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  private pixel = new Uint8Array(4);
  private renderer: THREE.WebGLRenderer;
  private view: PaintView;

  constructor(renderer: THREE.WebGLRenderer, view: PaintView) {
    this.renderer = renderer;
    this.view = view;
    this.whole = new THREE.Mesh(view.geometry, wholeMaterial);
    this.split = new THREE.Mesh(view.backing, splitMaterial);
    for (const m of [this.whole, this.split]) { m.frustumCulled = false; m.matrixAutoUpdate = false; this.scene.add(m); }
    this.scene.background = new THREE.Color(0, 0, 0);
  }

  private draw(camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
    const g = this.view.geometry;
    const range = { start: g.drawRange.start, count: g.drawRange.count };
    g.setDrawRange(0, this.view.count * 3);
    for (const m of [this.whole, this.split]) m.matrix.copy(this.view.object.matrixWorld);
    const prev = this.renderer.getRenderTarget();
    const clear = this.renderer.getClearColor(new THREE.Color()), alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(clear, alpha);
    g.setDrawRange(range.start, range.count);
  }

  /** The triangle under pixel (x, y) of a `w` × `h` view (CSS pixels, y down), or −1. */
  faceAt(camera: THREE.PerspectiveCamera, x: number, y: number, w: number, h: number): number {
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    camera.setViewOffset(w, h, Math.floor(x), Math.floor(y), 1, 1);
    this.draw(camera, this.one);
    camera.clearViewOffset();
    this.renderer.readRenderTargetPixels(this.one, 0, 0, 1, 1, this.pixel);
    const id = this.pixel[0] | (this.pixel[1] << 8) | (this.pixel[2] << 16);
    return id - 1;
  }

  /** The triangle under a pixel and where on it the ray from the camera meets it. */
  hit(camera: THREE.PerspectiveCamera, x: number, y: number, w: number, h: number): Hit | null {
    const face = this.faceAt(camera, x, y, w, h);
    if (face < 0 || face >= this.view.count) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x + 0.5) / w) * 2 - 1, -((y + 0.5) / h) * 2 + 1), camera);
    const P = this.view.mesh.positions, T = this.view.mesh.triangles;
    const m = this.view.object.matrixWorld;
    const corner = (k: number) => new THREE.Vector3(P[T[face * 3 + k] * 3], P[T[face * 3 + k] * 3 + 1], P[T[face * 3 + k] * 3 + 2]).applyMatrix4(m);
    const a = corner(0), b = corner(1), c = corner(2);
    const point = new THREE.Vector3();
    const plane = new THREE.Plane().setFromCoplanarPoints(a, b, c);
    if (!ray.ray.intersectPlane(plane, point)) point.copy(a).add(b).add(c).divideScalar(3);
    const bary = new THREE.Triangle(a, b, c).getBarycoord(point, new THREE.Vector3()) ?? new THREE.Vector3(1 / 3, 1 / 3, 1 / 3);
    // a pixel's ray can graze past an edge: keep the point on the triangle
    let wa = Math.max(0, bary.x), wb = Math.max(0, bary.y), wc = Math.max(0, bary.z);
    const s = wa + wb + wc || 1;
    wa /= s; wb /= s; wc /= s;
    point.set(a.x * wa + b.x * wb + c.x * wc, a.y * wa + b.y * wb + c.y * wc, a.z * wa + b.z * wb + c.z * wc);
    const front = plane.normal.dot(ray.ray.direction) < 0;
    return { face, point, weights: [wa, wb, wc], front };
  }

  /** The triangle under every pixel of a `w` × `h` view (−1 where none), row 0 at the top like the screen. */
  map(camera: THREE.PerspectiveCamera, w: number, h: number): Int32Array {
    const target = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.draw(camera, target);
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, w, h, px);
    target.dispose();
    const out = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = (h - 1 - y) * w; // GL rows start at the bottom
      for (let x = 0; x < w; x++) {
        const i = (row + x) * 4;
        out[y * w + x] = (px[i] | (px[i + 1] << 8) | (px[i + 2] << 16)) - 1;
      }
    }
    return out;
  }

  dispose(): void { this.one.dispose(); }
}

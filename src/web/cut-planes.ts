// The cut planes in the 3D view: a translucent square for each cut, through
// the model's middle, the chosen one brighter with a round handle on a stem
// along its normal (the side the pegs and the tongue go on). Dragging a plane
// slides it along its normal, dragging the handle tilts it, and while a point
// is being picked a click on the model moves the plane through it. The
// pointer is caught before the view's own controls, so a drag that starts on
// a plane doesn't also turn the view.

import * as THREE from 'three';
import type { Stage } from './stage.ts';

export type V3 = [number, number, number];
export interface PlaneAt { normal: V3; point: V3 }

const ON = 0xf2a43a;
const IDLE = 0x8a94a3;

export class CutPlanes {
  readonly group = new THREE.Group();
  private planes: PlaneAt[] = [];
  private selected = -1;
  private size = 100;
  private ray = new THREE.Raycaster();
  private drag: { i: number; part: 'sheet' | 'knob'; normal: THREE.Vector3; point: THREE.Vector3; start: number; now: PlaneAt; id: number } | null = null;
  /** the model shown: a plane behind it isn't caught, and Pick a point hits it */
  targets: () => THREE.Object3D[] = () => [];
  /** while a point is being picked: called with the point clicked on the model */
  picking: ((point: THREE.Vector3) => void) | null = null;
  onSelect: ((i: number) => void) | null = null;
  /** a plane moved by dragging; `done` when the drag ends */
  onMove: ((i: number, at: PlaneAt, done: boolean) => void) | null = null;

  constructor(private stage: Stage) {
    stage.extras.add(this.group);
    this.group.visible = false;
    // caught on the way down to the view, before the orbit controls see it
    const host = stage.renderer.domElement.parentElement ?? stage.renderer.domElement;
    host.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    host.addEventListener('pointermove', (e) => this.move(e), { capture: true });
    host.addEventListener('pointerup', (e) => this.up(e), { capture: true });
    host.addEventListener('pointercancel', (e) => this.up(e), { capture: true });
  }

  get visible(): boolean { return this.group.visible; }
  set visible(on: boolean) {
    this.group.visible = on;
    if (!on) this.stage.renderer.domElement.style.cursor = '';
    this.stage.render();
  }

  /** The planes to show, the chosen one, and how big a square is (mm). */
  set(planes: PlaneAt[], selected: number, size: number): void {
    this.planes = planes.map((p) => ({ normal: [...p.normal] as V3, point: [...p.point] as V3 }));
    this.selected = selected;
    this.size = Math.max(20, size);
    this.draw();
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
  }

  private draw() {
    this.clear();
    const size = this.size, h = size / 2;
    this.planes.forEach((p, i) => {
      const on = i === this.selected;
      const colour = on ? ON : IDLE;
      const g = new THREE.Group();
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: on ? 0.3 : 0.16, side: THREE.DoubleSide, depthWrite: false }));
      sheet.userData = { cut: i, part: 'sheet' };
      const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0), new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0)]),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: on ? 0.95 : 0.6 }));
      g.add(sheet, rim);
      if (on) {
        const reach = size * 0.28;
        const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, reach)]),
          new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true }));
        const knob = new THREE.Mesh(new THREE.SphereGeometry(size * 0.03, 20, 12), new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true }));
        knob.position.z = reach;
        knob.userData = { cut: i, part: 'knob' };
        stem.renderOrder = knob.renderOrder = 10;
        g.add(stem, knob);
      }
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...p.normal).normalize());
      g.position.set(...p.point);
      this.group.add(g);
    });
    this.stage.render();
  }

  private rayAt(e: PointerEvent): THREE.Ray {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.stage.camera);
    return this.ray.ray;
  }

  /** The nearest hit on the model shown. */
  private modelHit(): THREE.Intersection | null {
    let best: THREE.Intersection | null = null;
    for (const o of this.targets()) {
      const hit = this.ray.intersectObject(o, true)[0];
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }

  /** What of the planes is under the pointer: the handle wins over a sheet, and a sheet only when no part of the model is in front of it. */
  private under(withModel: boolean): THREE.Intersection | null {
    const hits = this.ray.intersectObjects(this.group.children, true).filter((x) => x.object.userData.part);
    const knob = hits.find((x) => x.object.userData.part === 'knob');
    if (knob) return knob;
    const sheet = hits.find((x) => x.object.userData.part === 'sheet');
    if (!sheet || !withModel) return sheet ?? null;
    const model = this.modelHit();
    return !model || sheet.distance <= model.distance + 1e-3 ? sheet : null;
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.group.visible || e.target !== this.stage.renderer.domElement) return;
    this.rayAt(e);
    if (this.picking) {
      const hit = this.modelHit();
      if (hit) {
        e.stopPropagation();
        e.preventDefault();
        const done = this.picking;
        this.picking = null;
        done(hit.point.clone());
      }
      return;
    }
    if (!this.planes.length) return;
    const hit = this.under(true);
    if (!hit) return;
    const i = hit.object.userData.cut as number;
    e.stopPropagation();
    e.preventDefault();
    this.stage.renderer.domElement.setPointerCapture?.(e.pointerId);
    if (i !== this.selected) this.onSelect?.(i);
    const p = this.planes[i];
    const normal = new THREE.Vector3(...p.normal).normalize();
    const point = new THREE.Vector3(...p.point);
    this.drag = { i, part: hit.object.userData.part, normal, point, start: this.along(this.ray.ray, point, normal), now: { normal: [...p.normal], point: [...p.point] }, id: e.pointerId };
  }

  /** How far along the line through `point` in `normal`'s direction the ray passes closest. */
  private along(ray: THREE.Ray, point: THREE.Vector3, normal: THREE.Vector3): number {
    const w0 = ray.origin.clone().sub(point);
    const b = ray.direction.dot(normal), d = ray.direction.dot(w0), e = normal.dot(w0);
    const den = 1 - b * b;
    return den < 1e-6 ? 0 : (e - b * d) / den;
  }

  private move(e: PointerEvent) {
    if (!this.group.visible) return;
    const d = this.drag;
    const ray = this.rayAt(e);
    if (!d) {
      // the handle and the planes show they can be dragged
      if (e.buttons || e.target !== this.stage.renderer.domElement) return;
      const hit = this.picking ? null : this.under(false);
      this.stage.renderer.domElement.style.cursor = this.picking ? 'crosshair' : hit ? (hit.object.userData.part === 'knob' ? 'grab' : 'move') : '';
      return;
    }
    e.stopPropagation();
    let normal = d.normal, point = d.point;
    if (d.part === 'knob') {
      // the handle follows the pointer over a plane facing the camera through the cut's centre
      const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(this.stage.camera.getWorldDirection(new THREE.Vector3()).negate(), d.point);
      const at = ray.intersectPlane(facing, new THREE.Vector3());
      if (!at) return;
      const dir = at.sub(d.point);
      if (dir.lengthSq() < 1e-6) return;
      normal = dir.normalize();
    } else {
      point = d.point.clone().addScaledVector(d.normal, this.along(ray, d.point, d.normal) - d.start);
    }
    d.now = { normal: normal.toArray() as V3, point: point.toArray() as V3 };
    this.planes[d.i] = { normal: [...d.now.normal], point: [...d.now.point] };
    this.draw();
    this.onMove?.(d.i, d.now, false);
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    e.stopPropagation();
    this.stage.renderer.domElement.releasePointerCapture?.(d.id);
    this.onMove?.(d.i, d.now, true);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}

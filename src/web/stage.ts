// The 3D view: renderer, camera (Z up, as printers and slicers have it),
// orbit controls, light, the build plate, and drawing only when something
// changed. The model is in millimetres at print size, standing on Z = 0.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
  readonly controls: OrbitControls;
  readonly content = new THREE.Group();
  /** helpers drawn in the view but not part of the model (the cut planes): left out of pictures and framing */
  readonly extras = new THREE.Group();
  private plate = new THREE.Group();
  private wanted = false;
  private host: HTMLElement;
  /** called after each frame (the overlay redraws then) */
  onFrame: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.prepend(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -220, 140);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true; // the wheel zooms towards what is under the mouse
    this.controls.addEventListener('change', () => this.render());
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.4);
    hemi.position.set(0, 0, 1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.6, -1, 1.4);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(1, 0.6, 0.4);
    this.camera.add(key, fill); // the light comes from the viewer, so every side shows its colours
    this.scene.add(hemi, this.camera, this.plate, this.content, this.extras);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.setTheme(document.documentElement.dataset.theme === 'dark');
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.enableDamping && this.controls.update()) this.wanted = true;
      if (!this.wanted) return;
      this.wanted = false;
      this.renderer.render(this.scene, this.camera);
      this.onFrame?.();
    };
    loop();
  }

  get width(): number { return this.host.clientWidth; }
  get height(): number { return this.host.clientHeight; }

  /** Draws again on the next frame. */
  render(): void { this.wanted = true; }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setTheme(dark: boolean): void {
    this.scene.background = new THREE.Color(dark ? 0x16191e : 0xeef0f3);
    this.plateColours = dark ? [0x2c323b, 0x22272e] : [0xc9ced6, 0xdde1e6];
    this.setPlate(this.plateSize);
    this.render();
  }

  private plateColours: [number, number] = [0xc9ced6, 0xdde1e6];
  private plateSize = 200;

  /** The build plate under the model: a grid of 10 mm squares, a little bigger than the model's footprint. */
  setPlate(size: number): void {
    this.plateSize = size;
    for (const c of [...this.plate.children]) { this.plate.remove(c); (c as THREE.LineSegments).geometry?.dispose(); }
    const s = Math.max(50, Math.ceil((size * 1.4) / 20) * 20);
    const step = s > 600 ? 50 : 10;
    const grid = new THREE.GridHelper(s, Math.round(s / step), this.plateColours[0], this.plateColours[1]);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.01;
    (grid.material as THREE.Material).depthWrite = false;
    this.plate.add(grid);
    this.render();
  }

  /** Shows or hides the build plate (pieces spread apart go below it). */
  setPlateVisible(on: boolean): void {
    if (this.plate.visible === on) return;
    this.plate.visible = on;
    this.render();
  }

  /** Points the camera at a box from the front left, above, with all of it in view. */
  frame(box: THREE.Box3, keepDirection = false): void {
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2) * 1.05;
    const dir = keepDirection ? this.camera.position.clone().sub(this.controls.target).normalize() : new THREE.Vector3(0.45, -1, 0.6).normalize();
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.01, dist / 1000);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.render();
  }

  /**
   * A square picture of the content (the plate left out), as PNG bytes: the
   * slicers show it in their file lists. `object`: that alone instead (one
   * not in the view, such as a piece laid flat to print).
   */
  async thumbnail(size = 512, object?: THREE.Object3D): Promise<Uint8Array> {
    let scene = this.scene;
    if (object) {
      scene = new THREE.Scene();
      const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.4);
      hemi.position.set(0, 0, 1);
      scene.add(hemi, object);
    }
    const box = new THREE.Box3().setFromObject(object ?? this.content);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100000);
    cam.up.set(0, 0, 1);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.02;
    cam.position.copy(centre).addScaledVector(new THREE.Vector3(0.45, -1, 0.55).normalize(), dist);
    cam.near = dist / 100; cam.far = dist * 10;
    cam.lookAt(centre);
    cam.updateProjectionMatrix();
    const light = new THREE.DirectionalLight(0xffffff, 1.6);
    light.position.set(-0.6, -1, 1.4);
    cam.add(light);
    const target = new THREE.WebGLRenderTarget(size, size, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const background = this.scene.background;
    this.scene.background = null;
    const plate = this.plate.visible, content = this.content.visible;
    this.plate.visible = false;
    this.extras.visible = false;
    this.content.visible = true;
    scene.add(cam);
    const clear = this.renderer.getClearAlpha();
    this.renderer.setClearAlpha(0);
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    const px = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, size, size, px);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearAlpha(clear);
    scene.remove(cam);
    if (object) scene.remove(object);
    this.scene.background = background;
    this.plate.visible = plate;
    this.extras.visible = true;
    this.content.visible = content;
    target.dispose();
    this.render();
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    g.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
  }
}

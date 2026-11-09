// The pieces a model was cut into, in the 3D view: each in its own colour,
// or each in the paint or textures it took from the model, and spread apart
// from the middle by a slider so the joints show.

import * as THREE from 'three';
import type { IndexedMesh } from '../core/mesh.ts';

export const PIECE_COLOURS = ['#d08c4a', '#5b9bd5', '#7cb46b', '#c96f9b', '#d9c35a', '#8a7fd1', '#4fb3b0', '#c9644f', '#9aa25a', '#6f8fb0'];
export const pieceColour = (i: number) => PIECE_COLOURS[i % PIECE_COLOURS.length];

/** A piece's look in its paint or textures, made when first shown. */
export interface PieceLook { object: THREE.Object3D; dispose(): void }

interface Item {
  group: THREE.Group;
  plain: THREE.Mesh;
  look: PieceLook | null;
  centre: THREE.Vector3;
}

export class PiecesView {
  readonly object = new THREE.Group();
  private items: Item[] = [];
  private middle = new THREE.Vector3();
  private size = 100;
  private showing: 'pieces' | 'painted' = 'pieces';

  /** `look(i)` makes piece i's painted or textured look. */
  constructor(meshes: IndexedMesh[], private look: (i: number) => PieceLook) {
    const all = new THREE.Box3();
    meshes.forEach((m, i) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(m.triangles, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const plain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: pieceColour(i), roughness: 0.75, metalness: 0, flatShading: true, side: THREE.DoubleSide }));
      const group = new THREE.Group();
      group.add(plain);
      const box = geometry.boundingBox!;
      all.union(box);
      this.items.push({ group, plain, look: null, centre: box.getCenter(new THREE.Vector3()) });
      this.object.add(group);
    });
    if (this.items.length) {
      this.middle = this.items.reduce((a, it) => a.add(it.centre), new THREE.Vector3()).multiplyScalar(1 / this.items.length);
      this.size = all.getSize(new THREE.Vector3()).length();
    }
  }

  get count(): number { return this.items.length; }

  /** Each piece in its own colour, or in the paint or textures it took from the model. */
  show(how: 'pieces' | 'painted'): void {
    this.showing = how;
    this.items.forEach((it, i) => {
      if (how === 'painted' && !it.look) { it.look = this.look(i); it.group.add(it.look.object); }
      it.plain.visible = how === 'pieces';
      if (it.look) it.look.object.visible = how === 'painted';
    });
  }

  get shown(): 'pieces' | 'painted' { return this.showing; }

  /** The looks made so far change (the palette did): made again when next shown. */
  dropLooks(): void {
    for (const it of this.items) if (it.look) { it.group.remove(it.look.object); it.look.dispose(); it.look = null; }
    this.show(this.showing);
  }

  /** Spreads the pieces apart from the middle: 0 together, 1 well apart. */
  spread(f: number): void {
    for (const it of this.items) {
      const dir = it.centre.clone().sub(this.middle);
      const len = dir.length();
      if (len > 1e-6) dir.multiplyScalar(1 / len);
      it.group.position.copy(dir.multiplyScalar(f * this.size * 0.35 + f * len * 0.6));
    }
  }

  dispose(): void {
    for (const it of this.items) {
      it.plain.geometry.dispose();
      (it.plain.material as THREE.Material).dispose();
      it.look?.dispose();
    }
    this.items = [];
    this.object.removeFromParent();
  }
}

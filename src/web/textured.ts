// The model as it came, in its own textures and colours: what painting
// starts from. Drawn from the imported model's welded mesh, its corners
// joined again where they share a vertex, a UV and a colour (so a big model
// costs about what it did in its file), triangles grouped by material.

import * as THREE from 'three';
import type { ImportedModel } from '../core/model.ts';
import type { Picture } from '../core/texpaint.ts';
import type { RGB } from '../core/colour.ts';

export interface MaterialLook {
  /** the texture to show, if any */
  picture?: Picture | null;
  /** the flat colour (or the texture's tint) */
  colour?: RGB | null;
  /** whether it shows the model's vertex colours */
  vertex?: boolean;
}

export class TexturedView {
  readonly object = new THREE.Group();
  readonly geometry = new THREE.BufferGeometry();
  private materials: THREE.MeshStandardMaterial[] = [];
  private textures: (THREE.DataTexture | null)[] = [];
  /** for each drawn vertex, the model's vertex it is */
  private source: Uint32Array;
  private model: ImportedModel;
  private mesh: THREE.Mesh;

  constructor(model: ImportedModel, looks: MaterialLook[]) {
    this.model = model;
    const T = model.mesh.triangles, n = T.length / 3, UV = model.uvs, C = model.vertexColours;
    // triangles in material order, so each material is one draw
    const counts = new Uint32Array(model.materials.length + 1);
    for (let f = 0; f < n; f++) counts[Math.min(model.faceMaterial[f], model.materials.length)]++;
    const starts = new Uint32Array(counts.length);
    for (let m = 1; m < counts.length; m++) starts[m] = starts[m - 1] + counts[m - 1];
    const order = new Uint32Array(n);
    const at = starts.slice();
    for (let f = 0; f < n; f++) order[at[Math.min(model.faceMaterial[f], model.materials.length)]++] = f;
    // corners joined where vertex, UV and colour agree
    const nv = model.mesh.positions.length / 3;
    const head = new Int32Array(nv).fill(-1);
    const corners = n * 3;
    const next = new Int32Array(corners);
    const src = new Uint32Array(corners), uv = UV ? new Float32Array(corners * 2) : null, col = C ? new Uint8Array(corners * 3) : null;
    const index = new Uint32Array(corners);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const f = order[i];
      for (let k = 0; k < 3; k++) {
        const v = T[f * 3 + k], c = f * 3 + k;
        let found = -1;
        for (let e = head[v]; e >= 0; e = next[e]) {
          if (uv && (uv[e * 2] !== UV![c * 2] || uv[e * 2 + 1] !== UV![c * 2 + 1])) continue;
          if (col && (col[e * 3] !== C![c * 3] || col[e * 3 + 1] !== C![c * 3 + 1] || col[e * 3 + 2] !== C![c * 3 + 2])) continue;
          found = e; break;
        }
        if (found < 0) {
          found = count++;
          src[found] = v;
          if (uv) { uv[found * 2] = UV![c * 2]; uv[found * 2 + 1] = UV![c * 2 + 1]; }
          if (col) { col[found * 3] = C![c * 3]; col[found * 3 + 1] = C![c * 3 + 1]; col[found * 3 + 2] = C![c * 3 + 2]; }
          next[found] = head[v];
          head[v] = found;
        }
        index[i * 3 + k] = found;
      }
    }
    this.source = src.slice(0, count);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    if (uv) this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv.slice(0, count * 2), 2));
    if (col) this.geometry.setAttribute('color', new THREE.BufferAttribute(col.slice(0, count * 3), 3, true));
    this.geometry.setIndex(new THREE.BufferAttribute(count > 65535 ? index : Uint16Array.from(index), 1));
    for (let m = 0; m < counts.length; m++) if (counts[m]) this.geometry.addGroup(starts[m] * 3, counts[m] * 3, Math.min(m, model.materials.length - 1));
    this.mesh = new THREE.Mesh(this.geometry, []);
    this.object.add(this.mesh);
    this.setLooks(looks);
    this.moved();
  }

  /** Each material's texture or colour again (after a texture was chosen). */
  setLooks(looks: MaterialLook[]): void {
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t?.dispose();
    this.textures = [];
    const smooth = !!this.model.uvs;
    this.materials = this.model.materials.map((_, i) => {
      const look = looks[i] ?? {};
      let map: THREE.DataTexture | null = null;
      if (look.picture) {
        const p = look.picture;
        map = new THREE.DataTexture(new Uint8Array(p.data.buffer as ArrayBuffer, p.data.byteOffset, p.data.byteLength), p.width, p.height, THREE.RGBAFormat);
        map.colorSpace = THREE.SRGBColorSpace;
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.magFilter = THREE.LinearFilter;
        map.minFilter = THREE.LinearMipmapLinearFilter;
        map.generateMipmaps = true;
        map.anisotropy = 4;
        map.flipY = false; // the UVs run down the picture, as its rows do
        map.needsUpdate = true;
      }
      this.textures.push(map);
      const c = look.colour ?? [255, 255, 255];
      return new THREE.MeshStandardMaterial({
        map, color: new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace),
        vertexColors: !!look.vertex && !!this.model.vertexColours && !map,
        roughness: 0.85, metalness: 0, side: THREE.DoubleSide, flatShading: !smooth,
      });
    });
    this.mesh.material = this.materials;
  }

  /** After the model's vertices moved (turned or scaled). */
  moved(): void {
    const P = this.model.mesh.positions, S = this.source;
    const pos = (this.geometry.getAttribute('position') as THREE.BufferAttribute);
    const out = pos.array as Float32Array;
    for (let i = 0; i < S.length; i++) { const v = S[i] * 3; out[i * 3] = P[v]; out[i * 3 + 1] = P[v + 1]; out[i * 3 + 2] = P[v + 2]; }
    pos.needsUpdate = true;
    if (this.model.uvs) this.geometry.computeVertexNormals(); else this.geometry.deleteAttribute('normal');
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t?.dispose();
  }
}

// manifold-3d, for the export that splits a painted model into one body per
// colour (split-colours.ts). From GusGusGooose's fit.ts.

import Module from 'manifold-3d';
import type { Manifold as ManifoldT, ManifoldToplevel, Mesh as MeshT } from 'manifold-3d';
import type { IndexedMesh } from './mesh.ts';

let wasm: ManifoldToplevel | null = null;

export async function manifold(): Promise<ManifoldToplevel> {
  if (!wasm) {
    wasm = await Module();
    wasm.setup();
  }
  return wasm;
}

/** The mesh as a solid; an error when it is not a closed, consistently wound surface. */
export async function toManifold(mesh: IndexedMesh): Promise<ManifoldT> {
  const { Manifold, Mesh } = await manifold();
  const m = new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.triangles });
  m.merge();
  const man = new Manifold(m);
  const status = man.status();
  if (status !== 'NoError') throw new Error(`the model is not a closed solid (${status})`);
  return man;
}

export function fromManifold(man: ManifoldT): IndexedMesh {
  const m: MeshT = man.getMesh();
  const positions = new Float32Array(m.numVert * 3);
  for (let v = 0; v < m.numVert; v++) {
    positions[v * 3] = m.vertProperties[v * m.numProp];
    positions[v * 3 + 1] = m.vertProperties[v * m.numProp + 1];
    positions[v * 3 + 2] = m.vertProperties[v * m.numProp + 2];
  }
  return { positions, triangles: Uint32Array.from(m.triVerts) };
}

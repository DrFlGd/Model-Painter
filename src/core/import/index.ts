// Opening a model file: the importer for its kind. glTF, OBJ, PSK, STL and
// 3MF are read here (pure, so the tests and a worker can too); FBX, Collada,
// 3DS and PLY go through three.js's loaders in the page (web/import-three.ts),
// which registers them with `addImporter`.

import { extension, type FileSource, type ImportedModel } from '../model.ts';
import { importGltf } from './gltf.ts';
import { importObj } from './obj.ts';
import { importPsk } from './psk.ts';
import { importStl } from './stl.ts';
import { import3mf } from './threemf.ts';

export type Importer = (src: FileSource) => Promise<ImportedModel>;

const importers = new Map<string, { name: string; open: Importer }>([
  ['.glb', { name: 'glTF', open: importGltf }],
  ['.gltf', { name: 'glTF', open: importGltf }],
  ['.obj', { name: 'Wavefront OBJ', open: importObj }],
  ['.psk', { name: 'ActorX (UModel, FModel)', open: importPsk }],
  ['.pskx', { name: 'ActorX (UModel, FModel)', open: importPsk }],
  ['.stl', { name: 'STL', open: importStl }],
  ['.3mf', { name: '3MF', open: import3mf }],
]);

export function addImporter(ext: string, name: string, open: Importer): void {
  importers.set(ext.toLowerCase(), { name, open });
}

/** The extensions a model can have, for an open dialog. */
export function modelExtensions(): string[] {
  return [...importers.keys()];
}

export function canOpen(name: string): boolean {
  return importers.has(extension(name));
}

export async function importModel(src: FileSource): Promise<ImportedModel> {
  const imp = importers.get(extension(src.name));
  if (!imp) throw new Error(`${src.name} isn't a kind of model this app reads (it reads ${[...new Set([...importers.values()].map((i) => i.name))].join(', ')})`);
  const model = await imp.open(src);
  const tris = model.mesh.triangles.length / 3;
  if (tris > 6_000_000) model.notes.push(`It has ${(tris / 1e6).toFixed(1)} million triangles, which is a lot to paint and for a slicer to read.`);
  return model;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold } from '../src/core/solid.ts';
import { PaintModel } from '../src/core/paint-model.ts';
import { painted3mf, parts3mf, stl } from '../src/core/export.ts';
import { join } from '../src/core/zip-write.ts';
import { unzip } from '../src/core/zip-read.ts';
import { import3mf } from '../src/core/import/threemf.ts';
import { importStl } from '../src/core/import/stl.ts';
import { splitByMaterial } from '../src/core/split-colours.ts';
import { memorySource } from './helpers/files.ts';
import type { RGB } from '../src/core/colour.ts';

const PALETTE: RGB[] = [[240, 240, 240], [200, 30, 30], [30, 30, 200]];

async function paintedCube() {
  const { Manifold } = await manifold();
  const mesh = fromManifold(Manifold.cube([20, 20, 20], true));
  const model = new PaintModel(mesh);
  model.brush({ x: 0, y: 0, z: 10 }, 4, 1);
  model.brush({ x: 10, y: 3, z: 3 }, 3, 2);
  model.paintFaces([0], 2);
  return model;
}

test('a painted 3MF comes back in with the same paint and colours', async () => {
  const model = await paintedCube();
  const codes = model.paintCodes();
  const bytes = join(await painted3mf({ name: 'cube <1>', mesh: model.mesh, codes, palette: PALETTE, thumbnail: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }));
  const files = await unzip(bytes);
  assert.ok(files.has('3D/3dmodel.model'));
  assert.ok(files.has('Metadata/Slic3r_PE_model.config'));
  assert.ok(files.has('Metadata/thumbnail.png'));
  const xml = new TextDecoder().decode(files.get('3D/3dmodel.model'));
  assert.ok(xml.includes('<metadata name="ModelPainter:Palette">#F0F0F0;#C81E1E;#1E1EC8</metadata>'));
  assert.ok(xml.includes('name="cube &lt;1&gt;"'));
  const back = await import3mf(memorySource('cube.3mf', { 'cube.3mf': bytes }));
  assert.equal(back.mesh.triangles.length, model.mesh.triangles.length);
  assert.deepEqual(back.paint!.palette, PALETTE);
  const again = new PaintModel(back.mesh);
  again.restore(back.paint!.faceMaterial, back.paint!.codes);
  assert.deepEqual(again.paintCodes(), codes);
});

test('a 3MF split by colour has a solid part per colour, painted its filament', async () => {
  const model = await paintedCube();
  const b = model.baked();
  const split = await splitByMaterial(b.mesh, b.faceMaterial, 3);
  const parts = split.parts.map((p) => ({ name: `colour ${p.material + 1}`, mesh: p.mesh, colour: p.material }));
  assert.equal(parts.length, 3);
  const bytes = join(await parts3mf('cube', parts, PALETTE));
  const back = await import3mf(memorySource('cube.3mf', { 'cube.3mf': bytes }));
  const used = new Set(back.paint!.faceMaterial);
  assert.deepEqual([...used].sort(), [0, 1, 2]);
});

test('STL round trip', async () => {
  const model = await paintedCube();
  const back = await importStl(memorySource('cube.stl', { 'cube.stl': stl(model.mesh) }));
  assert.equal(back.mesh.triangles.length, 36);
  assert.equal(back.mesh.positions.length, 8 * 3);
});

// The voxel tools against scipy.ndimage, as Dark STL's finishing uses it (fixtures/voxels.py writes the reference).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blobs, blur, dilateBall, erodeBall, fillHoles, stepCross, type Grid } from '../src/core/voxels.ts';

const ref = JSON.parse(readFileSync(new URL('./fixtures/voxels.json', import.meta.url), 'utf8'));
const [nx, ny, nz] = ref.shape as number[];
const g: Grid = { nx, ny, nz, data: Uint8Array.from(ref.grid) };
const same = (a: Grid, want: number[], what: string) => {
  let diff = 0;
  for (let i = 0; i < want.length; i++) if (a.data[i] !== want[i]) diff++;
  assert.equal(diff, 0, `${what}: ${diff} cells differ`);
};

test('ball dilation, closing and hole filling match scipy', () => {
  const d = dilateBall(g, 2);
  same(d, ref.dil2, 'dilation');
  same(erodeBall(d, 2), ref.close2, 'closing');
  same(fillHoles(d), ref.fill, 'filled');
});

test('cross steps match scipy iterations', () => {
  same(stepCross(g, 3), ref.cross3, 'dilation x3');
  same(stepCross(dilateBall(g, 2), 2, true), ref.ecross2, 'erosion x2');
});

test('blobs and blur match scipy', () => {
  assert.equal(blobs(g).length, ref.blobs);
  const f = blur(Float32Array.from(g.data), nx, ny, nz, 0.7);
  let worst = 0;
  for (let i = 0; i < f.length; i++) worst = Math.max(worst, Math.abs(f[i] - ref.blur[i]));
  assert.ok(worst < 1e-4, `blur differs by ${worst}`);
});

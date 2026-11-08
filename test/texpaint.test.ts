import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paintModel, suggestPalette, reduce, clean, DEFAULT_SETTINGS, type PaintInput, type Picture } from '../src/core/texpaint.ts';
import { codeShares, walkCode } from '../src/core/paint-tree.ts';
import type { RGB } from '../src/core/colour.ts';

/** A flat 10 mm square of two triangles with UVs over all of a texture (V down the picture). */
function square(pic: Picture): PaintInput {
  return {
    mesh: { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]) },
    // corner (x, y) has u = x / 10, v = 1 − y / 10
    uvs: Float32Array.from([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]),
    faceMaterial: [0, 0],
    sources: new Map([[0, { kind: 'texture' as const, picture: pic }]]),
  };
}

/** A picture coloured by a function of its texel's middle (u, v in 0..1). */
function picture(w: number, h: number, colour: (u: number, v: number) => RGB): Picture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = colour((x + 0.5) / w, (y + 0.5) / h), i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

const RED: RGB = [200, 30, 30], BLUE: RGB = [30, 30, 200], GREEN: RGB = [30, 190, 40];
const near = (a: RGB, b: RGB, tol = 10) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('the palette is the colours the surface covers, most used first', () => {
  // two thirds red, one third blue
  const input = square(picture(96, 96, (u) => (u < 2 / 3 ? RED : BLUE)));
  const s = suggestPalette(input, { colours: 2 });
  assert.equal(s.palette.length, 2);
  assert.ok(near(s.palette[0], RED), `first ${s.palette[0]}`);
  assert.ok(near(s.palette[1], BLUE), `second ${s.palette[1]}`);
  assert.ok(Math.abs(s.coverage[0] - 2 / 3) < 0.03, `coverage ${s.coverage}`);
  // only the part of a texture the model covers counts: UVs over its left half see only red
  const half = square(picture(96, 96, (u) => (u < 0.5 ? RED : BLUE)));
  half.uvs = half.uvs!.map((v, i) => (i % 2 === 0 ? v * 0.45 : v));
  const h = suggestPalette(half, { colours: 2 });
  assert.equal(h.palette.length, 1, 'one colour is all there is');
  assert.ok(near(h.palette[0], RED));
});

test('close colours merge under the tolerance, and small ones go under the smallest share', () => {
  const DARKRED: RGB = [180, 25, 25];
  const input = square(picture(128, 128, (u, v) => (u < 0.4 ? RED : u < 0.8 ? DARKRED : v < 0.1 ? GREEN : BLUE)));
  const all = suggestPalette(input, { colours: 4 });
  assert.equal(all.palette.length, 4);
  const merged = suggestPalette(input, { colours: 4, tolerance: 8 });
  assert.equal(merged.palette.length, 3, `merged ${merged.palette.map(String)}`);
  const big = suggestPalette(input, { colours: 4, minShare: 5 });
  assert.equal(big.palette.length, 3, 'green covers 2 % of the surface');
  assert.ok(!big.palette.some((c) => near(c, GREEN)));
});

test('a two-colour texture paints a border inside the triangles, where the texture has it', () => {
  // red left of u = 0.3, blue right of it: the border crosses both triangles
  const input = square(picture(128, 128, (u) => (u < 0.3 ? RED : BLUE)));
  const r = paintModel(input, { colours: 2, feature: 0.2 });
  assert.equal(r.palette.length, 2);
  assert.equal(r.splitFaces, 2);
  assert.equal(r.codes.size, 2);
  const red = r.palette.findIndex((c) => near(c, RED));
  assert.ok(red >= 0);
  assert.ok(Math.abs(r.coverage[red] - 0.3) < 0.02, `red covers ${r.coverage[red]}`);
  // every leaf is the colour of the texture at its middle (but for leaves on the border)
  const P = input.mesh.positions, T = input.mesh.triangles;
  let wrong = 0, total = 0;
  for (const [f, code] of r.codes) {
    walkCode(code, (w, state) => {
      let x = 0;
      for (let k = 0; k < 3; k++) x += P[T[f * 3 + k] * 3] * (w[k] + w[3 + k] + w[6 + k]) / 3;
      const leafWidth = Math.max(...[0, 1, 2].map((k) => Math.abs(P[T[f * 3 + k] * 3] * (w[k] - w[3 + k]))));
      total++;
      if (Math.abs(x - 3) < Math.max(0.3, leafWidth)) return;
      if ((state - 1 === red) !== x < 3) wrong++;
    });
  }
  assert.equal(wrong, 0, `${wrong} of ${total} leaves`);
  // shares from the codes give the same area as the coverage
  const share = new Float64Array(4);
  for (const code of r.codes.values()) codeShares(code, share);
  assert.ok(Math.abs(share[red + 1] / 2 - 0.3) < 0.02);
  // a coarser feature size makes fewer, bigger pieces
  const coarse = paintModel(input, { colours: 2, feature: 2 });
  assert.ok(coarse.leaves < r.leaves / 3, `${coarse.leaves} vs ${r.leaves}`);
});

test('a given palette and dropped colours are kept to', () => {
  const input = square(picture(64, 64, (u, v) => (u < 0.5 ? RED : v < 0.5 ? BLUE : GREEN)));
  const given = paintModel(input, { palette: ['#ff0000', '#00ff00'] });
  assert.deepEqual(given.palette, [[255, 0, 0], [0, 255, 0]]);
  const s = suggestPalette(input, { colours: 3 });
  const blue = s.palette.findIndex((c) => near(c, BLUE));
  const dropped = paintModel(input, { colours: 3, drop: [blue] }, s);
  assert.equal(dropped.palette.length, 2);
  assert.ok(!dropped.palette.some((c) => near(c, BLUE)));
});

test('flat colours paint whole triangles, and missing sources are noted', () => {
  const input: PaintInput = {
    mesh: { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]) },
    uvs: null,
    faceMaterial: [0, 1],
    sources: new Map([[0, { kind: 'colour' as const, rgb: RED }], [1, { kind: 'colour' as const, rgb: GREEN }]]),
  };
  const r = paintModel(input, { colours: 2 });
  assert.equal(r.codes.size, 0);
  assert.notEqual(r.faceMaterial[0], r.faceMaterial[1]);
  input.sources.delete(1);
  const one = paintModel(input, { colours: 2 });
  assert.equal(one.unpainted, 1);
  assert.ok(one.notes[0].includes('1 triangles'));
});

test('vertex colours paint too', () => {
  const input: PaintInput = {
    mesh: { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]) },
    uvs: null,
    faceMaterial: [0, 0],
    // triangle 0 red at every corner, triangle 1 blue
    vertexColours: Uint8Array.from([...RED, ...RED, ...RED, ...BLUE, ...BLUE, ...BLUE]),
    sources: new Map([[0, { kind: 'vertex' as const }]]),
  };
  const r = paintModel(input, { colours: 2 });
  assert.equal(r.palette.length, 2);
  assert.equal(r.codes.size, 0);
  assert.ok(near(r.palette[r.faceMaterial[0]], RED));
  assert.ok(near(r.palette[r.faceMaterial[1]], BLUE));
});

test('cleaning takes out specks and smooths ragged borders', () => {
  const w = 16, h = 16;
  const labels = new Uint8Array(w * h);
  labels[5 * w + 5] = 1; // a lone texel
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) labels[y * w + x] = 1; // a 4 × 4 patch
  const out = clean(Uint8Array.from(labels), w, h, 2, 0, 4);
  assert.equal(out[5 * w + 5], 0, 'the speck takes the colour round it');
  assert.equal(out[11 * w + 11], 1, 'the patch stays');
  const smooth = clean(Uint8Array.from(labels), w, h, 2, 1, 0);
  assert.equal(smooth[5 * w + 5], 0, 'a majority filter takes it out too');
  // exposure brightens before the colours are matched
  const grey = picture(4, 4, () => [60, 60, 60]);
  const dark = reduce(grey, [[0, 0, 0], [255, 255, 255]], { ...DEFAULT_SETTINGS, smoothing: 0, speck: 0 });
  const light = reduce(grey, [[0, 0, 0], [255, 255, 255]], { ...DEFAULT_SETTINGS, smoothing: 0, speck: 0, exposure: 1.5 });
  assert.equal(dark[0], 0);
  assert.equal(light[0], 1);
});

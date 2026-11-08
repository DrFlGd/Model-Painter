import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeDds, parseDds } from '../src/core/images/dds.ts';
import { decodeTga } from '../src/core/images/tga.ts';

// The fixtures were made with Pillow (test/fixtures): random blocks of every
// BC7 mode and of BC1, BC3, BC4 and BC5, and the RGBA Pillow decodes them to.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function differences(a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 0): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tolerance) n++;
  return n;
}

test('BC7 blocks of every mode decode as Pillow decodes them', () => {
  const pic = decodeDds(fixture('bc7.dds'));
  assert.equal(pic.width, 64);
  assert.equal(pic.height, 32);
  const want = fixture('bc7.rgba');
  assert.equal(pic.data.length, want.length);
  // block by block, so a wrong mode is named
  const bad = new Set<number>();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) for (let c = 0; c < 4; c++) {
    const i = (y * 64 + x) * 4 + c;
    if (pic.data[i] !== want[i]) bad.add(Math.floor((((y >> 2) * 16 + (x >> 2))) / 16));
  }
  assert.deepEqual([...bad], [], `modes with wrong texels: ${[...bad]}`);
});

test('BC1 to BC5 decode as Pillow decodes them', () => {
  for (const name of ['bc1', 'bc3', 'bc4', 'bc5']) {
    const pic = decodeDds(fixture(`${name}.dds`));
    const want = fixture(`${name}.rgba`);
    // BC5 has no blue: Pillow leaves it 0 as we do; interpolation may round one level apart
    assert.equal(differences(pic.data, want, 1), 0, name);
  }
});

test('a DDS file is read at the largest mip level within the size asked for', () => {
  // a 8 × 8 R8G8B8A8 file with 4 levels: 8, 4, 2, 1
  const header = new Uint8Array(128);
  const dv = new DataView(header.buffer);
  header.set([0x44, 0x44, 0x53, 0x20]);
  dv.setUint32(4, 124, true); dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000, true);
  dv.setUint32(12, 8, true); dv.setUint32(16, 8, true); dv.setUint32(28, 4, true);
  dv.setUint32(0x4c, 32, true); dv.setUint32(0x50, 0x41, true); dv.setUint32(0x58, 32, true);
  dv.setUint32(0x5c, 0xff, true); dv.setUint32(0x60, 0xff00, true); dv.setUint32(0x64, 0xff0000, true); dv.setUint32(0x68, 0xff000000, true);
  const levels = [8, 4, 2, 1].map((s, k) => new Uint8Array(s * s * 4).fill(k * 50 + 10));
  const file = new Uint8Array(128 + levels.reduce((n, l) => n + l.length, 0));
  file.set(header);
  let at = 128;
  for (const l of levels) { file.set(l, at); at += l.length; }
  assert.equal(parseDds(file).codec, 'MASK');
  const full = decodeDds(file);
  assert.equal(full.width, 8);
  assert.equal(full.data[0], 10);
  const small = decodeDds(file, 2);
  assert.equal(small.width, 2);
  assert.equal(small.data[0], 110);
});

test('TGA pictures read packed and plain, from the bottom row up', () => {
  for (const name of ['rle32', 'raw24']) {
    const pic = decodeTga(fixture(`${name}.tga`));
    assert.equal(pic.width, 13);
    assert.equal(pic.height, 7);
    assert.equal(differences(pic.data, fixture(`${name}.rgba`)), 0, name);
  }
});

test('PNG pictures read exactly as stored: colour, palette, grey, interlaced', async () => {
  const { decodePicture } = await import('../src/core/images/index.ts');
  for (const [file, want] of [['rgba.png', 'rgba.rgba'], ['palette.png', 'palette.rgba'], ['grey.png', 'grey.rgba'], ['interlaced.png', 'rgba.rgba']]) {
    const pic = await decodePicture(file, fixture(file));
    assert.equal(pic.width, 23, file);
    assert.equal(pic.height, 11, file);
    assert.equal(differences(pic.data, fixture(want)), 0, file);
  }
});

// Colours: sRGB to Oklab (where distances match how different colours look),
// hex strings, and the 6-bit colour cube the texture painter reduces
// pictures through (every colour of a picture falls in one of 262,144 cells,
// so choosing a palette and reducing a picture to it look at cells, not
// texels).

export type RGB = [number, number, number];

export function parseHex(text: string): RGB {
  let s = String(text).trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`Not a colour: '${text}' (use #rrggbb)`);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function toHex(rgb: ArrayLike<number>): string {
  let s = '#';
  for (let i = 0; i < 3; i++) s += Math.max(0, Math.min(255, Math.round(rgb[i]))).toString(16).padStart(2, '0').toUpperCase();
  return s;
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** sRGB 0..1 → Oklab, into `out` at `at`. */
export function oklab(r: number, g: number, b: number, out: Float32Array | number[] = [0, 0, 0], at = 0): Float32Array | number[] {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  out[at] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[at + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[at + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}

/** Brightness (−1..1, added), contrast (0..3, round mid grey) and saturation (0 grey .. 3) applied to the texture colours before they are reduced. */
export interface Adjust { brightness: number; contrast: number; saturation: number }
export const NO_ADJUST: Adjust = { brightness: 0, contrast: 1, saturation: 1 };

export const CUBE_BITS = 6;
export const CUBE_CELLS = 1 << (3 * CUBE_BITS);
const SHIFT = 8 - CUBE_BITS;

/** The cell of the colour cube an 8-bit colour falls in. */
export const cubeKey = (r: number, g: number, b: number): number => ((r >> SHIFT) << (2 * CUBE_BITS)) | ((g >> SHIFT) << CUBE_BITS) | (b >> SHIFT);

const adjustKey = (a: Adjust) => `${a.brightness.toFixed(3)}|${a.contrast.toFixed(3)}|${a.saturation.toFixed(3)}`;
const cache = new Map<string, { rgb: Float32Array; lab: Float32Array }>();

/**
 * The colour every cell of the cube stands for (its middle), after the
 * adjustments: as sRGB 0..1 and as Oklab, three numbers per cell.
 */
export function cube(adjust: Adjust = NO_ADJUST): { rgb: Float32Array; lab: Float32Array } {
  const key = adjustKey(adjust);
  let hit = cache.get(key);
  if (hit) return hit;
  const rgb = new Float32Array(CUBE_CELLS * 3), lab = new Float32Array(CUBE_CELLS * 3);
  const mask = (1 << CUBE_BITS) - 1, half = (1 << SHIFT) / 2 - 0.5;
  const { brightness, contrast, saturation } = adjust;
  const plain = brightness === 0 && contrast === 1 && saturation === 1;
  for (let k = 0; k < CUBE_CELLS; k++) {
    let r = ((((k >> (2 * CUBE_BITS)) & mask) << SHIFT) + half) / 255;
    let g = ((((k >> CUBE_BITS) & mask) << SHIFT) + half) / 255;
    let b = (((k & mask) << SHIFT) + half) / 255;
    if (!plain) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * saturation; g = luma + (g - luma) * saturation; b = luma + (b - luma) * saturation;
      r = (r - 0.5) * contrast + 0.5 + brightness; g = (g - 0.5) * contrast + 0.5 + brightness; b = (b - 0.5) * contrast + 0.5 + brightness;
      r = Math.min(1, Math.max(0, r)); g = Math.min(1, Math.max(0, g)); b = Math.min(1, Math.max(0, b));
    }
    rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = b;
    oklab(r, g, b, lab, k * 3);
  }
  hit = { rgb, lab };
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  cache.set(key, hit);
  return hit;
}

/** The nearest palette colour (Oklab) of every cell, after the adjustments: the lookup a picture is reduced through. */
export function paletteLut(palette: RGB[], adjust: Adjust = NO_ADJUST): Uint8Array {
  const { lab } = cube(adjust);
  const plab = new Float32Array(palette.length * 3);
  palette.forEach((c, i) => oklab(c[0] / 255, c[1] / 255, c[2] / 255, plab, i * 3));
  const lut = new Uint8Array(CUBE_CELLS);
  const k = palette.length;
  for (let c = 0; c < CUBE_CELLS; c++) {
    const L = lab[c * 3], A = lab[c * 3 + 1], B = lab[c * 3 + 2];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < k; i++) {
      const d = (L - plab[i * 3]) ** 2 + (A - plab[i * 3 + 1]) ** 2 + (B - plab[i * 3 + 2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    lut[c] = best;
  }
  return lut;
}

/** Relative luminance 0..255 of a colour, to choose black or white text on it. */
export const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

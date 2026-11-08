// Vendored from DrFlGd/Print-Factory (MIT, see LICENSE-print-factory in this folder), adapted to this repo's imports.
// Changed here: `quantize` learns its palette from flat pixels only, so the blended pixels along smooth (anti-aliased)
// edges cannot take a palette slot from a real colour.
/**
 * Images to outlines.
 *
 * The pipeline every image-based generator shares (lightbox, magnet, clicker artwork,
 * laser engraving):
 *
 *   decodeImage → adjust → removeBackground → quantize → cleanLabels → traceLabels
 *
 * Each step is a plain function over a `Raster` (RGBA bytes), so a module can stop early
 * (a one-colour stencil only needs `threshold` and `traceMask`) or insert its own step.
 * Output contours are in pixels with Y up and the origin at the image's bottom-left;
 * callers scale them to millimetres with `@pf/shapes` `fitInto` or `scale`.
 */
import { reverse, signedArea, simplify, weld, type Contour, type RGB } from './contour.ts';
import { contours as d3contours } from 'd3-contour';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  data: Uint8ClampedArray;
}

export function createRaster(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

/* ------------------------------------------------------------------ decode */

/**
 * Decodes PNG, JPEG, WebP, GIF or BMP in a page or worker, scaled down so the longer
 * side is at most `maxSide` pixels (tracing cost grows with the pixel count, and print
 * resolution rarely needs more than 1000 px).
 */
/** SVG has no pixels of its own: draw it through an <img> at the size asked for. */
async function svgBitmap(blob: Blob, maxSide: number): Promise<ImageBitmap> {
  if (typeof Image === 'undefined') throw new Error('SVG files can only be read on the page, not in a worker.');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth || maxSide;
    const h0 = img.naturalHeight || maxSide;
    const k = maxSide / Math.max(w0, h0);
    return await createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(w0 * k)), resizeHeight: Math.max(1, Math.round(h0 * k)) });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeImage(src: Blob | ArrayBuffer | Uint8Array, maxSide = 1024): Promise<Raster> {
  const blob = src instanceof Blob ? src : new Blob([src as BlobPart]);
  const bmp = /svg/i.test(blob.type) ? await svgBitmap(blob, maxSide) : await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('This browser cannot read images in the background.');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

/** Nearest-neighbour-free box downscale, for rasters that did not come through decodeImage. */
export function downscale(img: Raster, maxSide: number): Raster {
  const k = maxSide / Math.max(img.width, img.height);
  if (k >= 1) return img;
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const out = createRaster(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / k);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) / k));
      const y0 = Math.floor(y / k);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) / k));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < Math.min(y1, img.height); yy++)
        for (let xx = x0; xx < Math.min(x1, img.width); xx++) {
          const i = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c]! += img.data[i + c]!;
          n++;
        }
      out.data.set(acc.map((v) => v / Math.max(1, n)), (y * w + x) * 4);
    }
  return out;
}

/* ------------------------------------------------------------------ colour */

/** sRGB 0..255 to OKLab, where Euclidean distance tracks perceived difference. */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function oklabToRgb(L: number, a: number, b: number): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return [enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

/* ------------------------------------------------------------------ adjust */

export interface Adjustments {
  /** Stops of light, -2..2. */
  exposure?: number;
  /** -1..1. */
  contrast?: number;
  /** -1 (grey) .. 1. */
  saturation?: number;
  /** Midtone gamma, 0.2..5 (1 = unchanged). */
  gamma?: number;
  invert?: boolean;
}

export function adjust(img: Raster, a: Adjustments): Raster {
  const ex = 2 ** (a.exposure ?? 0);
  const ct = 1 + (a.contrast ?? 0);
  const sat = 1 + (a.saturation ?? 0);
  const gm = 1 / (a.gamma ?? 1);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let c = (v / 255) * ex;
    c = (c - 0.5) * ct + 0.5;
    c = Math.max(0, c) ** gm;
    lut[v] = Math.round(c * 255);
  }
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    let r = lut[img.data[i]!]!;
    let g = lut[img.data[i + 1]!]!;
    let b = lut[img.data[i + 2]!]!;
    if (sat !== 1) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = y + (r - y) * sat;
      g = y + (g - y) * sat;
      b = y + (b - y) * sat;
    }
    if (a.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = img.data[i + 3]!;
  }
  return { width: img.width, height: img.height, data: out };
}

/* ------------------------------------------------------------------ background */

export interface BackgroundOptions {
  /** OKLab distance, 0..0.5. About 0.08 removes a flat backdrop with JPEG noise. */
  tolerance?: number;
  /** Colour to remove; default the median of the border pixels. */
  color?: RGB;
  /** 'flood' removes only background connected to the border (keeps white eyes on a white page); 'global' removes every matching pixel. */
  mode?: 'flood' | 'global';
}

/** The median colour of the outermost pixels: what a flat backdrop is. */
export function borderColor(img: Raster): RGB {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3]! < 128) return;
    rs.push(img.data[i]!);
    gs.push(img.data[i + 1]!);
    bs.push(img.data[i + 2]!);
  };
  for (let x = 0; x < img.width; x++) {
    take(x, 0);
    take(x, img.height - 1);
  }
  for (let y = 0; y < img.height; y++) {
    take(0, y);
    take(img.width - 1, y);
  }
  const med = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1]! : 255);
  return [med(rs), med(gs), med(bs)];
}

/** Makes the backdrop transparent. Pixels already transparent stay so. */
export function removeBackground(img: Raster, opts: BackgroundOptions = {}): Raster {
  const tol = opts.tolerance ?? 0.08;
  const bg = oklab(...(opts.color ?? borderColor(img)));
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(img.data);
  const near = (p: number) => {
    const i = p * 4;
    if (out[i + 3]! < 128) return true;
    const c = oklab(out[i]!, out[i + 1]!, out[i + 2]!);
    return Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) <= tol;
  };
  if (opts.mode === 'global') {
    for (let p = 0; p < w * h; p++) if (near(p)) out[p * 4 + 3] = 0;
    return { width: w, height: h, data: out };
  }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!seen[p] && near(p)) {
      seen[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    out[p * 4 + 3] = 0;
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  return { width: w, height: h, data: out };
}

/* ------------------------------------------------------------------ quantise */

export interface Quantized {
  width: number;
  height: number;
  /** Palette index per pixel; -1 is transparent. */
  labels: Int16Array;
  palette: RGB[];
  /** Pixels per palette entry. */
  counts: number[];
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Reduces the image to `colors` flat colours by k-means in OKLab (k-means++ seeding, a
 * fixed seed so the same image always gives the same palette). Palette entries are sorted
 * by pixel count, largest first; empty clusters are dropped.
 */
export function quantize(img: Raster, colors: number, seed = 7): Quantized {
  const n = img.width * img.height;
  const labels = new Int16Array(n).fill(-1);
  const lab = new Float32Array(n * 3);
  const opaque: number[] = [];
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (img.data[i + 3]! < 128) continue;
    const c = oklab(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
    lab.set(c, p * 3);
    opaque.push(p);
  }
  if (!opaque.length) return { width: img.width, height: img.height, labels, palette: [], counts: [] };
  const k = Math.max(1, Math.min(colors, opaque.length));
  const rand = rng(seed);
  // learn the palette from flat pixels: ones whose four neighbours are opaque and nearly the same colour. The blend
  // along a smooth edge (red into a removed white, say) is then never a palette colour of its own; every pixel is still
  // given its nearest colour below. A noisy photo has few flat pixels, so it falls back to all of them.
  const w = img.width;
  const FLAT = 0.04 * 0.04;
  const isFlat = (p: number) => {
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= n || img.data[q * 4 + 3]! < 128) return false;
      const a = lab[p * 3]! - lab[q * 3]!, b = lab[p * 3 + 1]! - lab[q * 3 + 1]!, e = lab[p * 3 + 2]! - lab[q * 3 + 2]!;
      if (a * a + b * b + e * e > FLAT) return false;
    }
    return true;
  };
  const flat = opaque.filter(isFlat);
  const learn = flat.length >= Math.max(k * 16, opaque.length * 0.25) ? flat : opaque;
  const step = Math.max(1, Math.floor(learn.length / 20000));
  const sample = learn.filter((_, i) => i % step === 0);
  const d2 = (p: number, c: number[]) => {
    const a = lab[p * 3]! - c[0]!;
    const b = lab[p * 3 + 1]! - c[1]!;
    const e = lab[p * 3 + 2]! - c[2]!;
    return a * a + b * b + e * e;
  };
  const centres: number[][] = [];
  const first = sample[Math.floor(rand() * sample.length)]!;
  centres.push([lab[first * 3]!, lab[first * 3 + 1]!, lab[first * 3 + 2]!]);
  const dist = new Float64Array(sample.length).fill(Infinity);
  while (centres.length < k) {
    let total = 0;
    const last = centres[centres.length - 1]!;
    sample.forEach((p, i) => {
      dist[i] = Math.min(dist[i]!, d2(p, last));
      total += dist[i]!;
    });
    if (total === 0) break;
    let r = rand() * total;
    let pick = sample[sample.length - 1]!;
    for (let i = 0; i < sample.length; i++) {
      r -= dist[i]!;
      if (r <= 0) {
        pick = sample[i]!;
        break;
      }
    }
    centres.push([lab[pick * 3]!, lab[pick * 3 + 1]!, lab[pick * 3 + 2]!]);
  }
  const nearest = (p: number) => {
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < centres.length; c++) {
      const d = d2(p, centres[c]!);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  for (let iter = 0; iter < 16; iter++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const p of sample) {
      const c = sum[nearest(p)]!;
      c[0]! += lab[p * 3]!;
      c[1]! += lab[p * 3 + 1]!;
      c[2]! += lab[p * 3 + 2]!;
      c[3]!++;
    }
    let moved = 0;
    sum.forEach((s, i) => {
      if (!s[3]) return;
      const next = [s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]];
      moved = Math.max(moved, Math.hypot(next[0]! - centres[i]![0]!, next[1]! - centres[i]![1]!, next[2]! - centres[i]![2]!));
      centres[i] = next;
    });
    if (moved < 1e-4) break;
  }
  const counts = centres.map(() => 0);
  for (const p of opaque) {
    const c = nearest(p);
    labels[p] = c;
    counts[c]!++;
  }
  // Sort by size, drop empties, remap labels.
  const order = centres.map((_, i) => i).filter((i) => counts[i]! > 0).sort((a, b) => counts[b]! - counts[a]!);
  const remap = new Int16Array(centres.length).fill(-1);
  order.forEach((old, i) => (remap[old] = i));
  for (let p = 0; p < n; p++) if (labels[p]! >= 0) labels[p] = remap[labels[p]!]!;
  return {
    width: img.width,
    height: img.height,
    labels,
    palette: order.map((i) => oklabToRgb(centres[i]![0]!, centres[i]![1]!, centres[i]![2]!)),
    counts: order.map((i) => counts[i]!),
  };
}

/** Uses a fixed palette instead of finding one (e.g. the filaments the user owns). */
export function mapToPalette(img: Raster, palette: RGB[]): Quantized {
  const n = img.width * img.height;
  const labels = new Int16Array(n).fill(-1);
  const pal = palette.map((c) => oklab(...c));
  const counts = palette.map(() => 0);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (img.data[i + 3]! < 128) continue;
    const c = oklab(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
    let best = 0;
    let bd = Infinity;
    pal.forEach((q, k) => {
      const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    labels[p] = best;
    counts[best]!++;
  }
  return { width: img.width, height: img.height, labels, palette: [...palette], counts };
}

/**
 * Removes speckle: a few passes of a 3×3 majority filter, then merges connected regions
 * smaller than `minPixels` into their most common neighbour. Transparent stays transparent
 * unless `fillHoles` is set.
 */
export function cleanLabels(q: Quantized, opts: { passes?: number; minPixels?: number } = {}): Quantized {
  const { width: w, height: h } = q;
  let labels = new Int16Array(q.labels);
  const k = q.palette.length;
  for (let pass = 0; pass < (opts.passes ?? 1); pass++) {
    const next = new Int16Array(labels);
    const votes = new Int32Array(k + 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (labels[p]! < 0) continue;
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            votes[labels[yy * w + xx]! + 1]!++;
          }
        let best = labels[p]!;
        let bv = votes[best + 1]!;
        for (let c = 0; c < k; c++)
          if (votes[c + 1]! > bv) {
            bv = votes[c + 1]!;
            best = c;
          }
        if (bv >= 5) next[p] = best;
      }
    labels = next;
  }
  const minPixels = opts.minPixels ?? 0;
  if (minPixels > 1) {
    const comp = new Int32Array(w * h).fill(-1);
    const stack: number[] = [];
    let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (comp[s]! >= 0 || labels[s]! < 0) continue;
      const lab = labels[s]!;
      const members: number[] = [];
      const border = new Map<number, number>();
      comp[s] = id;
      stack.push(s);
      while (stack.length) {
        const p = stack.pop()!;
        members.push(p);
        const x = p % w;
        const ns = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * (h - 1) ? p + w : -1];
        for (const n of ns) {
          if (n < 0) continue;
          if (labels[n] === lab) {
            if (comp[n]! < 0) {
              comp[n] = id;
              stack.push(n);
            }
          } else if (labels[n]! >= 0) border.set(labels[n]!, (border.get(labels[n]!) ?? 0) + 1);
        }
      }
      if (members.length < minPixels && border.size) {
        const to = [...border.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        for (const p of members) labels[p] = to;
      }
      id++;
    }
  }
  const counts = q.palette.map(() => 0);
  for (const l of labels) if (l >= 0) counts[l]!++;
  return { ...q, labels, counts };
}

/* ------------------------------------------------------------------ masks and tracing */

/** 1 where the predicate holds, else 0. */
export function maskWhere(q: Quantized, pick: (label: number) => boolean): Float32Array {
  const m = new Float32Array(q.width * q.height);
  for (let p = 0; p < m.length; p++) m[p] = pick(q.labels[p]!) ? 1 : 0;
  return m;
}

export function alphaMask(img: Raster, cutoff = 128): Float32Array {
  const m = new Float32Array(img.width * img.height);
  for (let p = 0; p < m.length; p++) m[p] = img.data[p * 4 + 3]! >= cutoff ? 1 : 0;
  return m;
}

/** Luminance threshold, for one-colour stencils and engraving: 1 where darker than `level` (0..255). */
export function threshold(img: Raster, level = 128, invert = false): Float32Array {
  const m = new Float32Array(img.width * img.height);
  for (let p = 0; p < m.length; p++) {
    const i = p * 4;
    if (img.data[i + 3]! < 128) continue;
    const y = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
    m[p] = y < level !== invert ? 1 : 0;
  }
  return m;
}

/** Separable box blur, `radius` in pixels; softens mask edges before tracing. */
export function blurMask(m: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.round(radius);
  if (r <= 0) return m;
  const tmp = new Float32Array(m.length);
  const out = new Float32Array(m.length);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += m[y * w + Math.min(w - 1, Math.max(0, x))]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / d;
      acc += m[y * w + Math.min(w - 1, x + r + 1)]! - m[y * w + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / d;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

export interface TraceOptions {
  /** Blur radius in px before tracing: rounder edges, fewer jaggies. Default 1. */
  smooth?: number;
  /** Ramer–Douglas–Peucker tolerance in px. Default 0.6. */
  simplify?: number;
  /** Drop islands and holes smaller than this many square px. Default 16. */
  minArea?: number;
  /** Fill holes (keep only outer boundaries). */
  fillHoles?: boolean;
}

/**
 * Marching squares at the 0.5 level of a 0..1 mask. Returns contours in px, Y up (origin
 * bottom-left), outer boundaries counter-clockwise and holes clockwise. The mask is padded
 * so shapes touching the image edge still close.
 */
export function traceMask(mask: Float32Array, w: number, h: number, opts: TraceOptions = {}): Contour[] {
  const src = blurMask(mask, w, h, opts.smooth ?? 1);
  const pw = w + 2;
  const ph = h + 2;
  const padded = new Float64Array(pw * ph);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) padded[(y + 1) * pw + x + 1] = src[y * w + x]!;
  const [geo] = d3contours().size([pw, ph]).thresholds([0.5]).smooth(true)(Array.from(padded));
  const out: Contour[] = [];
  const minArea = opts.minArea ?? 16;
  const tol = opts.simplify ?? 0.6;
  for (const poly of geo?.coordinates ?? []) {
    poly.forEach((ring, ri) => {
      if (ri > 0 && opts.fillHoles) return;
      const c: number[] = [];
      for (let i = 0; i < ring.length - 1; i++) c.push(ring[i]![0]! - 1, h - (ring[i]![1]! - 1));
      let cc = weld(c);
      if (tol > 0) cc = simplify(cc, tol);
      if (cc.length < 6 || Math.abs(signedArea(cc)) < minArea) return;
      const ccw = signedArea(cc) > 0;
      out.push(ri === 0 ? (ccw ? cc : reverse(cc)) : ccw ? reverse(cc) : cc);
    });
  }
  return out;
}

export interface TracedRegion {
  index: number;
  color: RGB;
  pixels: number;
  contours: Contour[];
}

export interface TracedImage {
  width: number;
  height: number;
  /** Everything opaque, as one outline (holes filled unless asked otherwise). */
  silhouette: Contour[];
  regions: TracedRegion[];
}

/** Traces every palette colour and the overall silhouette in one pass. */
export function traceLabels(q: Quantized, opts: TraceOptions & { silhouetteHoles?: boolean; keep?: (index: number) => boolean } = {}): TracedImage {
  const keep = opts.keep ?? (() => true);
  const regions: TracedRegion[] = [];
  q.palette.forEach((color, index) => {
    if (!keep(index)) return;
    const contours = traceMask(maskWhere(q, (l) => l === index), q.width, q.height, opts);
    if (contours.length) regions.push({ index, color, pixels: q.counts[index] ?? 0, contours });
  });
  const silhouette = traceMask(
    maskWhere(q, (l) => l >= 0 && keep(l)),
    q.width,
    q.height,
    { ...opts, fillHoles: !opts.silhouetteHoles },
  );
  return { width: q.width, height: q.height, silhouette, regions };
}

/** The whole pipeline with sensible defaults, for modules that need nothing special. */
export function traceImage(
  img: Raster,
  opts: TraceOptions & { colors?: number; background?: BackgroundOptions | false; adjust?: Adjustments; passes?: number; minPixels?: number; silhouetteHoles?: boolean } = {},
): TracedImage & { quantized: Quantized } {
  let r = opts.adjust ? adjust(img, opts.adjust) : img;
  if (opts.background !== false) r = removeBackground(r, opts.background ?? {});
  const q = cleanLabels(quantize(r, opts.colors ?? 4), { passes: opts.passes ?? 1, minPixels: opts.minPixels ?? 24 });
  return { ...traceLabels(q, opts), quantized: q };
}

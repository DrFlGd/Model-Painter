// Prepare image: Print Factory's dialog for turning a picture into flat colour
// regions (packages/shell/src/prepare-image.ts in DrFlGd/print-factory, MIT),
// ported to this app's markup. Original and result side by side; background
// removal and its tolerance; the number of colours; a switch per colour to
// keep or drop it; smoothing and speck cleanup; exposure, contrast and
// saturation; one colour only, for silhouettes. Confirm traces with exactly
// what the result shows; Cancel changes nothing.

import type { Contour, RGB } from '../vendor/contour.ts';
import { adjust, cleanLabels, quantize, removeBackground, traceLabels, type Adjustments, type Quantized, type Raster } from '../vendor/trace.ts';

export interface ImageSettings {
  colors: number;
  removeBackground: boolean;
  tolerance: number;
  /** 0..3 majority-filter passes */
  smoothing: number;
  /** specks smaller than this share of the image (0..2 %) merge into their neighbours */
  speck: number;
  /** palette indices to drop */
  drop: number[];
  adjust: Required<Pick<Adjustments, 'exposure' | 'contrast' | 'saturation'>>;
  /** merge every kept colour into one (stencils, silhouettes) */
  single?: boolean;
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  colors: 4,
  removeBackground: true,
  tolerance: 0.08,
  smoothing: 1,
  speck: 0.15,
  drop: [],
  adjust: { exposure: 0, contrast: 0, saturation: 0 },
};

/** What the picture accessory is built from: the traced regions, no bitmap. Contours in px, y up. */
export interface PreparedImage {
  name: string;
  width: number;
  height: number;
  palette: RGB[];
  regions: { index: number; color: RGB; contours: Contour[] }[];
  silhouette: Contour[];
  settings: ImageSettings;
}

export const hex = (c: RGB) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

type Attrs = Record<string, unknown> | null;
/** A small element builder: attributes, `class`, `style` objects and `on…` handlers. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k === 'class' ? 'class' : k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function process(src: Raster, s: ImageSettings): Quantized {
  let r = adjust(src, s.adjust);
  if (s.removeBackground) r = removeBackground(r, { tolerance: s.tolerance });
  const total = src.width * src.height;
  const q = quantize(r, s.single ? 2 : s.colors);
  return cleanLabels(q, { passes: s.smoothing, minPixels: Math.round((s.speck / 100) * total) });
}

function drawLabels(canvas: HTMLCanvasElement, q: Quantized, drop: Set<number>) {
  canvas.width = q.width;
  canvas.height = q.height;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(q.width, q.height);
  for (let p = 0; p < q.labels.length; p++) {
    const l = q.labels[p];
    if (l < 0 || drop.has(l)) continue;
    const c = q.palette[l];
    img.data.set([c[0], c[1], c[2], 255], p * 4);
  }
  g.putImageData(img, 0, 0);
}

function drawRaster(canvas: HTMLCanvasElement, r: Raster) {
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
}

/** Traces with the given settings, no dialog. */
export function traceWith(src: Raster, s: ImageSettings, name = 'image'): PreparedImage {
  const q = process(src, s);
  const drop = new Set(s.drop);
  const t = traceLabels(q, { keep: (i) => !drop.has(i), smooth: 1, simplify: 0.5, minArea: 6 });
  let regions = t.regions.map((r) => ({ index: r.index, color: r.color, contours: r.contours }));
  if (s.single) regions = regions.length ? [{ index: 0, color: regions[0].color, contours: t.silhouette }] : [];
  return { name, width: q.width, height: q.height, palette: q.palette, regions, silhouette: t.silhouette, settings: s };
}

/** A modal dialog with a title, a body and a footer; closes on Escape, the backdrop or the close button. */
export function dialog(title: string, wide: boolean, onClose: () => void) {
  const body = h('div', { class: 'dialog-body' });
  const footer = h('div', { class: 'dialog-footer' });
  const el = h('dialog', { class: `dialog ${wide ? 'wide' : ''}` },
    h('header', { class: 'dialog-head' }, h('h2', null, title), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    body, footer);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.close();
    el.remove();
    onClose();
  };
  el.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  document.body.appendChild(el);
  el.showModal();
  return { body, footer, close, element: el };
}

/** Opens the dialog. Resolves with the traced image, or null when cancelled. */
export function prepareImage(src: Raster, name: string, initial: Partial<ImageSettings> = {}, opts: { title?: string; maxColors?: number } = {}): Promise<PreparedImage | null> {
  return new Promise((resolve) => {
    let s: ImageSettings = { ...DEFAULT_IMAGE_SETTINGS, ...initial, adjust: { ...DEFAULT_IMAGE_SETTINGS.adjust, ...initial.adjust } };
    let answer: PreparedImage | null = null;
    const d = dialog(opts.title ?? 'Prepare image', true, () => resolve(answer));
    d.element.id = 'prepare-image';
    const original = h('canvas', { class: 'prep-canvas checker' });
    const result = h('canvas', { class: 'prep-canvas checker', id: 'prep-result' });
    drawRaster(original, src);
    const chips = h('div', { class: 'prep-colors', id: 'prep-chips' });
    const status = h('p', { class: 'muted small', id: 'prep-status' });
    let zoom = 1;
    const views = h('div', { class: 'prep-views' },
      h('figure', null, h('figcaption', null, 'Original'), h('div', { class: 'prep-frame' }, original)),
      h('figure', null, h('figcaption', null, 'Result'), h('div', { class: 'prep-frame' }, result)));
    views.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom = Math.min(8, Math.max(1, zoom * Math.exp(-e.deltaY * 0.002)));
      views.style.setProperty('--zoom', String(zoom));
    }, { passive: false });

    const slider = (id: string, label: string, min: number, max: number, step: number, get: () => number, put: (v: number) => void, fmt = (v: number) => String(v)) => {
      const out = h('output', null, fmt(get()));
      const r = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(get()), 'aria-label': label });
      const fill = () => r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min)) * 100}%`);
      fill();
      r.addEventListener('input', () => { put(Number(r.value)); out.textContent = fmt(Number(r.value)); fill(); schedule(); });
      return h('label', { class: 'prep-slider' }, h('span', null, label), r, out);
    };
    const toggle = (id: string, label: string, get: () => boolean, put: (v: boolean) => void) => {
      const c = h('input', { type: 'checkbox', id, checked: get() });
      c.addEventListener('change', () => { put(c.checked); schedule(); });
      return h('label', { class: 'check' }, c, h('span', null, label));
    };

    const controls = h('div', { class: 'prep-controls' },
      toggle('prep-bg', 'Remove background', () => s.removeBackground, (v) => (s = { ...s, removeBackground: v })),
      slider('prep-tolerance', 'Background tolerance', 0.01, 0.3, 0.01, () => s.tolerance, (v) => (s = { ...s, tolerance: v }), (v) => v.toFixed(2)),
      slider('prep-colours', 'Colours', 1, opts.maxColors ?? 8, 1, () => s.colors, (v) => (s = { ...s, colors: v, drop: [] })),
      toggle('prep-single', 'One colour only (a silhouette)', () => !!s.single, (v) => (s = { ...s, single: v, drop: [] })),
      slider('prep-smoothing', 'Smoothing', 0, 3, 1, () => s.smoothing, (v) => (s = { ...s, smoothing: v })),
      slider('prep-speck', 'Remove specks', 0, 2, 0.05, () => s.speck, (v) => (s = { ...s, speck: v }), (v) => `${v.toFixed(2)} %`),
      slider('prep-exposure', 'Exposure', -2, 2, 0.1, () => s.adjust.exposure, (v) => (s = { ...s, adjust: { ...s.adjust, exposure: v } }), (v) => v.toFixed(1)),
      slider('prep-contrast', 'Contrast', -1, 1, 0.05, () => s.adjust.contrast, (v) => (s = { ...s, adjust: { ...s.adjust, contrast: v } }), (v) => v.toFixed(2)),
      slider('prep-saturation', 'Saturation', -1, 1, 0.05, () => s.adjust.saturation, (v) => (s = { ...s, adjust: { ...s.adjust, saturation: v } }), (v) => v.toFixed(2)),
      h('div', null, h('span', { class: 'field-label' }, 'Keep colours'), h('p', { class: 'small muted' }, 'Click a colour to drop it (a white backdrop the background removal missed, say). Each kept colour becomes an inlay.'), chips),
      status);
    d.body.append(h('div', { class: 'prep' }, views, controls));
    d.footer.append(
      h('span', { class: 'muted small grow' }, 'Ctrl + scroll to zoom the previews.'),
      h('button', { type: 'button', id: 'prep-cancel', onclick: () => d.close() }, 'Cancel'),
      h('button', {
        type: 'button', class: 'primary', id: 'prep-use',
        onclick: () => {
          answer = traceWith(src, s, name);
          if (!answer.regions.length) {
            status.textContent = 'Nothing is left to trace. Keep at least one colour or lower the background tolerance.';
            answer = null;
            return;
          }
          d.close();
        },
      }, 'Use this image'),
    );

    let timer = 0;
    function schedule() { clearTimeout(timer); timer = window.setTimeout(run, 60); }
    function run() {
      const q = process(src, s);
      const drop = new Set(s.drop);
      drawLabels(result, q, drop);
      chips.replaceChildren(...q.palette.map((c, i) => h('button', {
        type: 'button',
        class: `chip ${drop.has(i) ? '' : 'on'}`,
        'aria-pressed': String(!drop.has(i)),
        title: `${hex(c)}, ${((q.counts[i] / q.labels.length) * 100).toFixed(1)} % of the image`,
        onclick: () => {
          const next = new Set(s.drop);
          if (next.has(i)) next.delete(i); else next.add(i);
          s = { ...s, drop: [...next] };
          run();
        },
      }, h('span', { class: 'chip-swatch', style: { background: hex(c) } }), hex(c).toUpperCase())));
      const kept = q.palette.length - drop.size;
      status.textContent = `${src.width} × ${src.height} px, ${kept} of ${q.palette.length} colour${q.palette.length === 1 ? '' : 's'} kept.`;
    }
    run();
  });
}

/** A small SVG of the traced regions in their colours, for the panel. Contours are y up, anywhere (pixels from a trace, or a vector file's own units). */
export function tracedPreview(img: { width: number; height: number; regions: { color: RGB; contours: Contour[] }[] }, size = 220): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of img.regions) for (const c of r.contours) for (let i = 0; i < c.length; i += 2) {
    x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]); y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]);
  }
  if (!(x1 > x0 && y1 > y0)) { x0 = 0; y0 = 0; x1 = img.width || 1; y1 = img.height || 1; }
  const w = x1 - x0, ht = y1 - y0, pad = Math.max(w, ht) * 0.02;
  const svg = document.createElementNS(NS, 'svg');
  // y up: the drawing is flipped, so the view box spans -y1..-y0
  svg.setAttribute('viewBox', `${x0 - pad} ${-y1 - pad} ${w + 2 * pad} ${ht + 2 * pad}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(Math.round((size * (ht + 2 * pad)) / Math.max(1e-9, w + 2 * pad))));
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', 'scale(1 -1)');
  const prec = Math.max(0, Math.min(3, Math.ceil(-Math.log10(Math.max(w, ht) / 1000))));
  for (const r of img.regions) {
    let d = '';
    for (const c of r.contours) {
      if (c.length < 6) continue;
      d += `M${c[0].toFixed(prec)} ${c[1].toFixed(prec)}`;
      for (let i = 2; i < c.length; i += 2) d += `L${c[i].toFixed(prec)} ${c[i + 1].toFixed(prec)}`;
      d += 'Z';
    }
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', hex(r.color));
    p.setAttribute('fill-rule', 'evenodd');
    g.append(p);
  }
  svg.append(g);
  return svg;
}

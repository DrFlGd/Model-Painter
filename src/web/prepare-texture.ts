// Prepare texture: the Prepare image dialog's way of working, for painting a
// model from its textures. A texture and what painting will make of it side
// by side; the number of colours, merging close ones and leaving out ones
// that cover little; a chip per colour with the share of the model it
// covers, to keep or drop it or change it to the filament you have; the
// cleanup (smoothing and specks) and the exposure, contrast and saturation;
// and the smallest feature painting keeps. The colours come from every
// texture of the model, weighted by how much of its surface each texel
// covers, so the preview of one texture shows the palette the whole model
// gets. Paint the model hands back the settings, the palette made explicit.

import { dialog, h, hex } from './prepare-image.ts';
import { reducedPicture, MAX_COLOURS, type Picture, type TextureSettings, DEFAULT_SETTINGS } from '../core/texpaint.ts';
import { parseHex, type RGB } from '../core/colour.ts';
import { Cancelled, type TextureJobs } from './texture-jobs.ts';

export interface ColourEntry {
  /** the suggested colour */
  rgb: RGB;
  /** share of the model's surface it takes */
  coverage: number;
  keep: boolean;
  /** what the person changed it to */
  edited: RGB | null;
}

/** What the dialog settled on: the settings to paint with (the palette given) and the colours as the dialog showed them. */
export interface TexturePlan {
  settings: TextureSettings;
  entries: ColourEntry[];
}

export interface TextureChoice { material: number; name: string; picture: Picture }

/** The palette the entries give: the kept ones, as changed. */
export const planPalette = (entries: ColourEntry[]): RGB[] => entries.filter((e) => e.keep).map((e) => e.edited ?? e.rgb);

function drawPicture(canvas: HTMLCanvasElement, p: Picture) {
  canvas.width = p.width;
  canvas.height = p.height;
  const data = new Uint8ClampedArray(p.data.length);
  data.set(p.data);
  // the texture's own alpha is how a material is cut out, not a colour: show it opaque
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  canvas.getContext('2d')!.putImageData(new ImageData(data, p.width, p.height), 0, 0);
}

/** Opens the dialog. Resolves with the plan to paint with, or null when cancelled. */
export function prepareTexture(jobs: TextureJobs, textures: TextureChoice[], initial: TexturePlan | null): Promise<TexturePlan | null> {
  return new Promise((resolve) => {
    let s: TextureSettings = { ...DEFAULT_SETTINGS, ...(initial?.settings ?? {}), palette: null, drop: [] };
    let entries: ColourEntry[] | null = initial?.entries.length ? initial.entries.map((e) => ({ ...e })) : null;
    let answer: TexturePlan | null = null;
    let shown = 0;
    let generation = 0;
    const d = dialog('Prepare texture', true, () => { generation++; resolve(answer); });
    d.element.id = 'prepare-texture';
    const original = h('canvas', { class: 'prep-canvas' });
    const result = h('canvas', { class: 'prep-canvas', id: 'tex-result' });
    const chips = h('div', { class: 'prep-colors tex-chips', id: 'tex-chips' });
    const status = h('p', { class: 'muted small', id: 'tex-status' });
    let zoom = 1;
    const views = h('div', { class: 'prep-views' },
      h('figure', null, h('figcaption', null, 'Texture'), h('div', { class: 'prep-frame' }, original)),
      h('figure', null, h('figcaption', null, 'Painted as'), h('div', { class: 'prep-frame' }, result)));
    views.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom = Math.min(8, Math.max(1, zoom * Math.exp(-e.deltaY * 0.002)));
      views.style.setProperty('--zoom', String(zoom));
    }, { passive: false });
    // the two views scroll together when zoomed
    const frames = [...views.querySelectorAll<HTMLElement>('.prep-frame')];
    for (const f of frames) f.addEventListener('scroll', () => { for (const g of frames) if (g !== f) { g.scrollLeft = f.scrollLeft; g.scrollTop = f.scrollTop; } });

    const slider = (id: string, label: string, min: number, max: number, step: number, get: () => number, put: (v: number) => void, then: () => void, fmt = (v: number) => String(v)) => {
      const out = h('output', null, fmt(get()));
      const r = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(get()), 'aria-label': label });
      const fill = () => r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min)) * 100}%`);
      fill();
      r.addEventListener('input', () => { put(Number(r.value)); out.textContent = fmt(Number(r.value)); fill(); then(); });
      return h('label', { class: 'prep-slider' }, h('span', null, label), r, out);
    };

    const select = h('select', { id: 'tex-which', 'aria-label': 'Texture' }, ...textures.map((t, i) => h('option', { value: String(i) }, t.name)));
    select.addEventListener('change', () => { shown = Number(select.value); drawOriginal(); schedule(false); });
    const recount = () => schedule(true);
    const redraw = () => schedule(false);
    const controls = h('div', { class: 'prep-controls' },
      textures.length > 1 ? h('label', { class: 'field-stack' }, h('span', { class: 'field-label' }, 'Texture to look at'), select) : null,
      slider('tex-colours', 'Colours', 1, MAX_COLOURS, 1, () => s.colours, (v) => (s = { ...s, colours: v }), recount),
      slider('tex-tolerance', 'Merge similar colours', 0, 30, 1, () => s.tolerance, (v) => (s = { ...s, tolerance: v }), recount, (v) => (v ? String(v) : 'off')),
      slider('tex-share', 'Leave out colours under', 0, 10, 0.5, () => s.minShare, (v) => (s = { ...s, minShare: v }), recount, (v) => (v ? `${v} %` : 'off')),
      h('div', null,
        h('span', { class: 'field-label' }, 'Colours to paint'),
        h('p', { class: 'small muted' }, 'Click a colour to leave it out (its texels take the nearest colour kept). Click its swatch to change it to the filament you have.'),
        chips),
      slider('tex-smoothing', 'Smoothing', 0, 3, 1, () => s.smoothing, (v) => (s = { ...s, smoothing: v }), redraw),
      slider('tex-speck', 'Remove specks', 0, 64, 1, () => s.speck, (v) => (s = { ...s, speck: v }), redraw, (v) => (v ? `${v} texels` : 'off')),
      slider('tex-exposure', 'Exposure', -2, 2, 0.1, () => s.exposure, (v) => (s = { ...s, exposure: v }), recount, (v) => v.toFixed(1)),
      slider('tex-contrast', 'Contrast', -1, 1, 0.05, () => s.contrast, (v) => (s = { ...s, contrast: v }), recount, (v) => v.toFixed(2)),
      slider('tex-saturation', 'Saturation', -1, 1, 0.05, () => s.saturation, (v) => (s = { ...s, saturation: v }), recount, (v) => v.toFixed(2)),
      slider('tex-feature', 'Smallest feature', 0.1, 2, 0.05, () => s.feature, (v) => (s = { ...s, feature: v }), () => {}, (v) => `${v.toFixed(2)} mm`),
      h('p', { class: 'small muted' }, 'Painting splits each triangle until its pieces are one colour or this small. Smaller follows the texture more closely and makes a bigger file for the slicer.'),
      status);
    d.body.append(h('div', { class: 'prep' }, textures.length ? views : h('div', { class: 'prep-empty muted' }, 'This model has no textures to look at: it is painted from its colours.'), controls));
    const paintButton = h('button', {
      type: 'button', class: 'primary', id: 'tex-paint',
      onclick: () => {
        if (!entries) return;
        const palette = planPalette(entries);
        if (!palette.length) { status.textContent = 'Keep at least one colour.'; return; }
        answer = { settings: { ...s, palette: palette.map(hex), drop: [] }, entries };
        d.close();
      },
    }, 'Paint the model');
    d.footer.append(
      h('span', { class: 'muted small grow' }, 'Ctrl + scroll to zoom the previews.'),
      h('button', { type: 'button', id: 'tex-cancel', onclick: () => d.close() }, 'Cancel'),
      paintButton,
    );

    function drawOriginal() { if (textures[shown]) drawPicture(original, textures[shown].picture); }

    function drawChips() {
      if (!entries) { chips.replaceChildren(h('span', { class: 'small muted' }, 'Choosing colours…')); return; }
      chips.replaceChildren(...entries.map((e, i) => {
        const c = e.edited ?? e.rgb;
        const colour = h('input', { type: 'color', class: 'chip-colour', value: hex(c), title: 'Change this colour', 'aria-label': `Change colour ${i + 1}` });
        colour.addEventListener('input', () => { entries![i] = { ...entries![i], edited: parseHex(colour.value), keep: true }; drawChips(); redraw(); });
        return h('span', { class: `chip tex-chip ${e.keep ? 'on' : ''}` },
          colour,
          h('button', {
            type: 'button', class: 'chip-toggle', 'aria-pressed': String(e.keep),
            title: `${e.keep ? 'Leave out' : 'Keep'} ${hex(c).toUpperCase()}${e.edited ? ` (suggested ${hex(e.rgb).toUpperCase()})` : ''}`,
            onclick: () => { entries![i] = { ...entries![i], keep: !entries![i].keep }; drawChips(); redraw(); },
          }, `${hex(c).toUpperCase()} · ${(e.coverage * 100).toFixed(e.coverage < 0.1 ? 1 : 0)} %`),
          e.edited ? h('button', { type: 'button', class: 'chip-reset', title: 'Back to the suggested colour', onclick: () => { entries![i] = { ...entries![i], edited: null }; drawChips(); redraw(); } }, '↺') : null);
      }));
      const kept = entries.filter((e) => e.keep).length;
      paintButton.disabled = kept === 0;
    }

    let timer = 0;
    let wantSuggest = !entries;
    function schedule(suggest: boolean) {
      wantSuggest ||= suggest;
      clearTimeout(timer);
      timer = window.setTimeout(run, 120);
    }
    async function run() {
      const gen = ++generation;
      try {
        if (wantSuggest) {
          wantSuggest = false;
          status.textContent = 'Choosing the colours from the textures…';
          paintButton.disabled = true;
          const sug = await jobs.suggest({ ...s, palette: null, drop: [] });
          if (gen !== generation) return;
          entries = sug.palette.map((rgb, i) => ({ rgb, coverage: sug.coverage[i], keep: true, edited: null }));
          drawChips();
        }
        if (!entries) return;
        const palette = planPalette(entries);
        const t = textures[shown];
        if (!t || !palette.length) { status.textContent = palette.length ? `${palette.length} colour${palette.length === 1 ? '' : 's'} to paint.` : 'Keep at least one colour.'; return; }
        status.textContent = 'Reducing the texture…';
        const r = await jobs.reduce(t.material, palette.map(hex), s);
        if (gen !== generation) return;
        drawPicture(result, reducedPicture(r.labels, r.width, r.height, palette));
        status.textContent = `${t.picture.width} × ${t.picture.height} px. ${palette.length} colour${palette.length === 1 ? '' : 's'} to paint${entries.length > palette.length ? ` (${entries.length - palette.length} left out)` : ''}.`;
      } catch (err) {
        if (err instanceof Cancelled || gen !== generation) return;
        status.textContent = (err as Error).message;
      }
    }
    drawOriginal();
    drawChips();
    run();
  });
}

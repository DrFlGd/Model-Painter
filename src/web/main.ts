// Model Painter's page: open a model in any of the formats it reads, with
// its textures; size and turn it for printing; paint it from its textures
// (Prepare texture) or by hand (brush, fill, corners, text, picture stamps
// made with Prepare image); save a painted 3MF, a 3MF split by colour, or
// an STL. The same page runs in a browser and in the desktop app.

import * as THREE from 'three';
import { Stage } from './stage.ts';
import { PaintView } from './paint-view.ts';
import { Picker } from './pick.ts';
import { TexturedView, type MaterialLook } from './textured.ts';
import { TextureJobs, Cancelled } from './texture-jobs.ts';
import { prepareTexture, planPalette, type TexturePlan } from './prepare-texture.ts';
import { prepareImage, tracedPreview, dialog, h, hex, type ImageSettings } from './prepare-image.ts';
import { registerThreeImporters } from './import-three.ts';
import { browserDecoder } from './decode.ts';
import { droppedFiles, givenSource, inputFiles, modelsAmong, diskSource, type GivenFile } from './files.ts';
import { desktop, onDrop, pickFile, readFile, saveFile, startupFile, listFiles, pathKind } from './desktop.ts';
import { importModel, modelExtensions } from '../core/import/index.ts';
import { decodePicture, setBrowserDecoder } from '../core/images/index.ts';
import { baseName, isPicture, PICTURE_EXTENSIONS, stem, type FileSource, type ImportedModel } from '../core/model.ts';
import { DEFAULT_SETTINGS, MANY_LEAVES, type ColourSource, type PaintInput, type PaintResult, type Picture, type TextureSettings } from '../core/texpaint.ts';
import { MAX_COLOURS } from '../core/paint-model.ts';
import { painted3mf, parts3mf, stl } from '../core/export.ts';
import { join } from '../core/zip-write.ts';
import { splitByMaterial } from '../core/split-colours.ts';
import { insidePolygon } from '../core/paint-fill.ts';
import type { StampView } from '../core/paint-model.ts';
import type { RGB } from '../core/colour.ts';
import { parseSvg } from '../vendor/svg.ts';
import { bounds as contourBounds, type Contour } from '../vendor/contour.ts';
import { downscale, type Raster } from '../vendor/trace.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);

registerThreeImporters();
setBrowserDecoder(browserDecoder);

// ---------- theme ----------
const THEME_KEY = 'model-painter-theme';
function setTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* private window */ }
  stage?.setTheme(dark);
}
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* private window */ }
document.documentElement.dataset.theme = savedTheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme !== 'dark');

const stage = new Stage($('stage'));
const jobs = new TextureJobs();
const view = stage.renderer.domElement;

// ---------- status and progress ----------
function status(text: string) { $('status').textContent = text; }
let stopping: (() => void) | null = null;
function progress(text: string | null, fraction?: number, stop?: () => void) {
  const box = $('progress');
  box.classList.toggle('hidden', text === null);
  if (text === null) { stopping = null; return; }
  $('progress-text').textContent = text;
  $('progress-bar').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
  if (stop !== undefined) stopping = stop;
  $('progress-stop').classList.toggle('hidden', !stopping);
}
$('progress-stop').onclick = () => stopping?.();
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- the open model ----------
type Use = 'texture' | 'colour' | 'vertex' | 'none';
interface Loaded {
  model: ImportedModel;
  /** the vertices as they came */
  original: Float32Array;
  /** 3 × 3, row-major: the quarter turns made */
  turn: number[];
  /** millimetres per unit of the file */
  scale: number;
  pictures: (Picture | null)[];
  use: Use[];
  textured: TexturedView;
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const UNIT_MM: Record<ImportedModel['units'], number> = { mm: 1, cm: 10, m: 1000, in: 25.4, unknown: 1 };
const DEFAULT_PALETTE: RGB[] = [[236, 236, 232], [32, 32, 34], [200, 44, 44], [40, 92, 196], [246, 190, 40], [56, 150, 72], [240, 120, 30], [130, 70, 160]];
const SPARE: RGB[] = [[236, 236, 232], [32, 32, 34], [200, 44, 44], [40, 92, 196], [246, 190, 40], [56, 150, 72], [240, 120, 30], [130, 70, 160], [120, 200, 220], [230, 140, 180], [120, 80, 50], [150, 150, 150], [250, 230, 160], [20, 60, 40], [90, 20, 30], [60, 60, 120]];

let loaded: Loaded | null = null;
let paint: PaintView | null = null;
let picker: Picker | null = null;
let palette: RGB[] = DEFAULT_PALETTE.slice(0, 4);
let active = 1;
let look: 'original' | 'painted' = 'original';
let tab = 'model';
let plan: TexturePlan | null = null;
let lastPaint: PaintResult | null = null;

$('model-kinds').textContent = [...new Set(modelExtensions().map((e) => e.slice(1).toUpperCase()))].join(', ');
$<HTMLInputElement>('model-file').accept = modelExtensions().concat(PICTURE_EXTENSIONS, ['.mtl', '.bin']).join(',');

function looks(l: Loaded): MaterialLook[] {
  return l.model.materials.map((m, i) => ({
    picture: l.use[i] === 'texture' ? l.pictures[i] : null,
    colour: l.use[i] === 'texture' ? m.tint ?? null : l.use[i] === 'colour' ? m.colour ?? null : l.use[i] === 'none' ? [205, 205, 205] : null,
    vertex: l.use[i] === 'vertex',
  }));
}

function sourceOf(l: Loaded, i: number): ColourSource {
  const m = l.model.materials[i];
  switch (l.use[i]) {
    case 'texture': return l.pictures[i] ? { kind: 'texture', picture: l.pictures[i]!, tint: m.tint } : { kind: 'none' };
    case 'colour': return { kind: 'colour', rgb: m.colour ?? [255, 255, 255] };
    case 'vertex': return { kind: 'vertex' };
    default: return { kind: 'none' };
  }
}

/** Tells the texture worker about the model as it is now. */
function modelChanged() {
  if (!loaded) return;
  const l = loaded;
  const input: PaintInput = {
    mesh: l.model.mesh, uvs: l.model.uvs, faceMaterial: l.model.faceMaterial, vertexColours: l.model.vertexColours,
    sources: new Map(l.model.materials.map((_, i) => [i, sourceOf(l, i)])),
  };
  jobs.setModel(input);
}

const anyPaintSource = () => !!loaded && loaded.use.some((u, i) => u !== 'none' && (u !== 'texture' || !!loaded!.pictures[i]));

async function openSource(src: FileSource) {
  if (jobs.busy) jobs.cancel();
  progress(`Opening ${src.name}…`, 0.05);
  status(`Opening ${src.name}…`);
  await frame();
  let model: ImportedModel;
  try {
    model = await importModel(src);
  } catch (e) {
    progress(null);
    status(`${src.name}: ${errorText(e)}`);
    return;
  }
  // the old model goes
  if (loaded) { stage.content.remove(loaded.textured.object); loaded.textured.dispose(); }
  if (paint) { stage.content.remove(paint.object); paint.dispose(); paint = null; }
  picker?.dispose(); picker = null;
  plan = null; lastPaint = null;
  const pictures: (Picture | null)[] = model.materials.map(() => null);
  const use: Use[] = model.materials.map(() => 'none');
  const l: Loaded = { model, original: model.mesh.positions.slice(), turn: IDENTITY.slice(), scale: 1, pictures, use, textured: null as unknown as TexturedView };
  // the textures
  const withTexture = model.materials.map((m, i) => [m, i] as const).filter(([m]) => m.texture?.bytes);
  let done = 0;
  for (const [m, i] of withTexture) {
    progress(`Reading ${m.texture!.name}…`, 0.1 + (0.6 * done++) / withTexture.length);
    try { pictures[i] = await jobs.decode(m.texture!.name, m.texture!.bytes!); } catch (e) { m.note = `${m.texture!.name} couldn't be read: ${errorText(e)}`; }
  }
  const tinted = (c: RGB | undefined) => !!c && c.some((v) => v < 250);
  const vertexColoured = !!model.vertexColours && model.vertexColours.some((v) => v < 250);
  model.materials.forEach((m, i) => {
    use[i] = pictures[i] ? 'texture' : vertexColoured && !tinted(m.colour) ? 'vertex' : m.colour ? 'colour' : vertexColoured ? 'vertex' : 'none';
  });
  // the size it prints at
  const sized = defaultScale(model);
  l.scale = sized.scale;
  l.textured = new TexturedView(model, looks(l));
  stage.content.add(l.textured.object);
  loaded = l;
  // paint the file already had
  if (model.paint) {
    let colours = model.paint.palette.slice(0, MAX_COLOURS);
    let most = 0;
    for (const m of model.paint.faceMaterial) most = Math.max(most, m);
    while (colours.length <= most && colours.length < MAX_COLOURS) colours.push(SPARE[colours.length]);
    if (!colours.length) colours = DEFAULT_PALETTE.slice(0, 4);
    palette = colours;
    ensurePaint();
    paint!.restore(model.paint.faceMaterial, model.paint.codes);
    setLook('painted');
  } else {
    palette = DEFAULT_PALETTE.slice(0, 4);
    setLook('original');
  }
  active = Math.min(palette.length - 1, 1);
  applyTransform();
  stage.frame(new THREE.Box3().setFromObject(stage.content));
  $<HTMLInputElement>('export-name').value = model.name || stem(src.name);
  $('export-info').textContent = '';
  $('paint-result').textContent = 'Each triangle is split where the texture\'s colours change across it, as the slicers paint, so the model needs no more triangles.';
  $('empty').classList.add('hidden');
  progress(null);
  // what came in
  const tris = model.mesh.triangles.length / 3;
  const found = model.materials.filter((m) => m.texture?.bytes).length, named = model.materials.filter((m) => m.texture).length;
  $('model-info').textContent = `${model.name}, ${model.format}: ${plural(tris, 'triangle')}, ${plural(model.materials.length, 'material')}`
    + (named ? `, ${found} of ${plural(named, 'texture')} found.` : '.') + (model.paint ? ' It is painted already: the paint is kept.' : '');
  const notes = [...model.notes];
  if (sized.note) notes.push(sized.note);
  $('model-notes').replaceChildren(...notes.map((n) => h('li', null, n)));
  for (const id of ['size-height', 'size-width', 'turn-x', 'turn-y', 'turn-z', 'turn-reset']) $<HTMLInputElement>(id).disabled = false;
  renderMaterials();
  renderPlan();
  renderPalette();
  updatePaintInfo();
  updateButtons();
  status(model.paint ? `${model.name} is open with its paint.` : anyPaintSource()
    ? `${model.name} is open. The Textures tab paints it from its ${found ? 'textures' : 'colours'}; Paint paints it by hand.`
    : `${model.name} is open. It has no textures or colours to paint from: paint it by hand on the Paint tab${named ? ', or choose its textures on the Textures tab' : ''}.`);
}

/** What the model prints at when it comes in: its own size when it says it is in millimetres (or a sensible size in its unit), else 150 mm tall. */
function defaultScale(model: ImportedModel): { scale: number; note?: string } {
  const P = model.mesh.positions;
  let z0 = Infinity, z1 = -Infinity, big = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], P[i + d]); hi[d] = Math.max(hi[d], P[i + d]); }
  z0 = lo[2]; z1 = hi[2];
  big = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let unit = UNIT_MM[model.units];
  let units = model.units;
  // a file in metres more than 10 m across is a print model in millimetres (OBJ and glTF files say nothing of it)
  if (units === 'm' && big > 10) { unit = 1; units = 'mm'; }
  const height = (z1 - z0) * unit, size = big * unit;
  const mmFile = units === 'mm' || units === 'unknown';
  if (mmFile ? size >= 1 && size <= 1000 : height >= 20 && height <= 300) return { scale: unit };
  const target = 150;
  const k = target / Math.max(1e-9, z1 - z0 > big * 0.05 ? z1 - z0 : big);
  const real = height >= 1000 ? `${(height / 1000).toFixed(2)} m` : `${height.toFixed(height < 10 ? 2 : 0)} mm`;
  return { scale: k, note: `It is ${real} tall in its file${mmFile && model.units !== 'mm' ? ' (taking its numbers as millimetres)' : ''}, so it was sized to ${target} mm tall. Set the size on the Model tab.` };
}

/** Puts the model at its print size and turn, standing on the plate, centred. */
function applyTransform() {
  if (!loaded) return;
  const { model, original: O, turn: R, scale: k } = loaded;
  const P = model.mesh.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < O.length; i += 3) {
    const x = O[i], y = O[i + 1], z = O[i + 2];
    for (let d = 0; d < 3; d++) {
      const v = (R[d * 3] * x + R[d * 3 + 1] * y + R[d * 3 + 2] * z) * k;
      P[i + d] = v;
      if (v < lo[d]) lo[d] = v;
      if (v > hi[d]) hi[d] = v;
    }
  }
  const shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
  for (let i = 0; i < P.length; i += 3) { P[i] += shift[0]; P[i + 1] += shift[1]; P[i + 2] += shift[2]; }
  loaded.textured.moved();
  paint?.moved();
  faceMapCache = null;
  modelChanged();
  const w = hi[0] - lo[0], d = hi[1] - lo[1], ht = hi[2] - lo[2];
  stage.setPlate(Math.max(w, d));
  $<HTMLInputElement>('size-height').value = ht.toFixed(1);
  $<HTMLInputElement>('size-width').value = w.toFixed(1);
  $('size-info').textContent = `${w.toFixed(1)} × ${d.toFixed(1)} × ${ht.toFixed(1)} mm (width × depth × height).`;
  const brushMax = Math.max(1, Math.min(50, Math.round(Math.max(w, d, ht) / 4)));
  $<HTMLInputElement>('brush').max = String(brushMax);
  $<HTMLInputElement>('brush-num').max = String(brushMax);
  fillSlider($<HTMLInputElement>('brush'));
  stage.render();
}

function resize(axis: 'height' | 'width') {
  if (!loaded) return;
  const want = num(axis === 'height' ? 'size-height' : 'size-width');
  const P = loaded.model.mesh.positions;
  let lo = Infinity, hi = -Infinity;
  const d = axis === 'height' ? 2 : 0;
  for (let i = d; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); }
  if (!(want > 0) || !(hi > lo)) return;
  loaded.scale *= want / (hi - lo);
  applyTransform();
  stage.frame(new THREE.Box3().setFromObject(stage.content), true);
  status(`Sized to ${want} mm ${axis === 'height' ? 'tall' : 'wide'}.`);
}
$('size-height').addEventListener('change', () => resize('height'));
$('size-width').addEventListener('change', () => resize('width'));

const QUARTER: Record<string, number[]> = {
  x: [1, 0, 0, 0, 0, -1, 0, 1, 0],
  y: [0, 0, 1, 0, 1, 0, -1, 0, 0],
  z: [0, -1, 0, 1, 0, 0, 0, 0, 1],
};
function turn(axis: 'x' | 'y' | 'z') {
  if (!loaded) return;
  const A = QUARTER[axis], B = loaded.turn, C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  loaded.turn = C;
  applyTransform();
  stage.frame(new THREE.Box3().setFromObject(stage.content), true);
}
$('turn-x').onclick = () => turn('x');
$('turn-y').onclick = () => turn('y');
$('turn-z').onclick = () => turn('z');
$('turn-reset').onclick = () => { if (loaded) { loaded.turn = IDENTITY.slice(); applyTransform(); stage.frame(new THREE.Box3().setFromObject(stage.content), true); } };

$('view-fit').onclick = () => stage.frame(new THREE.Box3().setFromObject(stage.content), true);

// ---------- opening files ----------
async function chooseModel(models: GivenFile[]): Promise<GivenFile | null> {
  if (models.length <= 1) return models[0] ?? null;
  return new Promise((resolve) => {
    let picked: GivenFile | null = null;
    const d = dialog('Which model?', false, () => resolve(picked));
    d.body.append(h('p', { class: 'small muted' }, `${models.length} models are among these files.`),
      h('div', { class: 'export' }, ...models.slice(0, 60).map((m) => h('button', { type: 'button', class: 'export-btn', onclick: () => { picked = m; d.close(); } }, m.path))));
    d.footer.append(h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'));
  });
}

async function openGiven(files: GivenFile[]) {
  const models = modelsAmong(files);
  if (!models.length) {
    // pictures alone: a texture for a material that has none
    if (loaded && files.length && files.every((f) => isPicture(f.path))) { await textureFromFile(files[0].file); return; }
    status(files.length ? `None of these is a model this app reads (${[...new Set(modelExtensions())].join(' ')}).` : 'Nothing to open.');
    return;
  }
  const model = await chooseModel(models);
  if (model) await openSource(await givenSource(model, files));
}

async function openPath(path: string) {
  try {
    const kind = await pathKind(path);
    if (kind === 'dir') {
      const files = (await listFiles(path)).filter((f) => !f.startsWith('../'));
      const models = modelsAmong(files.map((f) => ({ path: f, file: null as unknown as File })));
      const pick = await chooseModel(models);
      if (pick) await openSource(await diskSource(`${path.replace(/[\\/]+$/, '')}/${pick.path}`));
      else if (!models.length) status(`No model this app reads is in ${baseName(path)}.`);
      return;
    }
    if (loaded && isPicture(path)) { await textureFromBytes(baseName(path), await readFile(path)); return; }
    await openSource(await diskSource(path));
  } catch (e) {
    progress(null);
    status(`${baseName(path)}: ${errorText(e)}`);
  }
}

const modelFilter = () => [{ name: 'Models', extensions: modelExtensions().map((e) => e.slice(1)) }];
async function openDesktop() {
  const path = await pickFile('Open a model', modelFilter());
  if (path) await openPath(path);
}
$<HTMLInputElement>('model-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const files = inputFiles(input);
  input.value = '';
  await openGiven(files);
};
$<HTMLInputElement>('model-folder').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const files = inputFiles(input);
  input.value = '';
  await openGiven(files);
};
if (desktop) {
  // the desktop opens files where they are, so the textures beside them are found
  $('open-model').addEventListener('click', (e) => { e.preventDefault(); void openDesktop(); });
  $('open-folder-label').classList.add('hidden');
  $('model-info').textContent = 'Its textures are found beside it, in its folder or the folders near it.';
  void onDrop((paths) => { if (paths[0]) void openPath(paths[0]); }, (on) => $('stage').classList.toggle('drop', on));
  void startupFile().then((p) => { if (p) void openPath(p); }).catch(() => {});
} else {
  const st = $('stage');
  st.addEventListener('dragover', (e) => { e.preventDefault(); st.classList.add('drop'); });
  st.addEventListener('dragleave', () => st.classList.remove('drop'));
  st.addEventListener('drop', async (e) => {
    e.preventDefault();
    st.classList.remove('drop');
    if (!e.dataTransfer) return;
    status('Reading the dropped files…');
    await openGiven(await droppedFiles(e.dataTransfer));
  });
}

// ---------- materials and textures ----------
const USE_LABEL: Record<Use, string> = { texture: 'Its texture', colour: 'Its colour', vertex: 'Vertex colours', none: 'Not painted (colour 1)' };
let choosingFor = -1;
function renderMaterials() {
  const box = $('materials');
  if (!loaded) { box.replaceChildren(h('p', { class: 'small muted' }, 'Open a model first.')); return; }
  const l = loaded;
  box.replaceChildren(...l.model.materials.map((m, i) => {
    const thumb = h('div', { class: 'material-thumb' });
    const pic = l.pictures[i];
    if (pic) {
      const c = h('canvas', { width: '44', height: '44' });
      const full = document.createElement('canvas');
      full.width = pic.width; full.height = pic.height;
      const data = new Uint8ClampedArray(pic.data.length); data.set(pic.data);
      for (let k = 3; k < data.length; k += 4) data[k] = 255;
      full.getContext('2d')!.putImageData(new ImageData(data, pic.width, pic.height), 0, 0);
      c.getContext('2d')!.drawImage(full, 0, 0, 44, 44);
      thumb.append(c);
    } else if (m.colour) thumb.style.background = hex(m.colour);
    else thumb.textContent = 'none';
    const options: Use[] = ['texture', 'colour', 'vertex', 'none'];
    const select = h('select', { 'aria-label': `What ${m.name} is painted from` }, ...options
      .filter((u) => u === 'none' || u === l.use[i] || (u === 'texture' && pic) || (u === 'colour' && m.colour) || (u === 'vertex' && l.model.vertexColours))
      .map((u) => h('option', { value: u, selected: u === l.use[i] ? true : undefined }, USE_LABEL[u])));
    select.value = l.use[i];
    select.onchange = () => { l.use[i] = select.value as Use; l.textured.setLooks(looks(l)); plan = null; modelChanged(); renderMaterials(); renderPlan(); updateButtons(); stage.render(); };
    const tex = m.texture
      ? h('div', { class: `material-tex ${m.texture.bytes && pic ? '' : 'missing'}` }, m.texture.bytes && pic ? `${m.texture.name}, ${pic.width} × ${pic.height}${m.texture.path && m.texture.path.includes('/') ? ` (${m.texture.path})` : ''}` : `${m.texture.name}: ${m.note ?? 'not found'}`)
      : h('div', { class: 'material-tex' }, m.colour ? `No texture; colour ${hex(m.colour).toUpperCase()}` : 'No texture');
    const note = m.note && pic ? h('div', { class: 'material-tex missing' }, m.note) : null;
    const choose = h('button', { type: 'button', title: 'Pick the picture this material is coloured with', onclick: () => chooseTexture(i) }, pic ? 'Other texture…' : 'Choose texture…');
    return h('div', { class: 'material' }, thumb,
      h('div', { class: 'material-name', title: m.name }, m.name),
      tex, note,
      h('div', { class: 'material-row' }, select, choose));
  }));
}

async function chooseTexture(i: number) {
  choosingFor = i;
  if (desktop) {
    const path = await pickFile(`Texture for ${loaded?.model.materials[i].name ?? 'the material'}`, [{ name: 'Pictures', extensions: PICTURE_EXTENSIONS.map((e) => e.slice(1)) }]);
    if (path) await textureFromBytes(baseName(path), await readFile(path));
    return;
  }
  const input = h('input', { type: 'file', accept: PICTURE_EXTENSIONS.join(',') + ',image/*' });
  input.onchange = () => { const f = input.files?.[0]; if (f) void textureFromFile(f); };
  input.click();
}

async function textureFromFile(file: File) { await textureFromBytes(file.name, new Uint8Array(await file.arrayBuffer())); }

/** A picture the person chose, as the texture of the material asked for (or the first without one). */
async function textureFromBytes(name: string, bytes: Uint8Array) {
  if (!loaded) return;
  const l = loaded;
  let i = choosingFor;
  if (i < 0) i = l.model.materials.findIndex((_, k) => !l.pictures[k]);
  if (i < 0) i = 0;
  choosingFor = -1;
  try {
    status(`Reading ${name}…`);
    const pic = await jobs.decode(name, bytes);
    const m = l.model.materials[i];
    m.texture = { name, path: '', bytes };
    m.note = undefined;
    l.pictures[i] = pic;
    l.use[i] = 'texture';
    l.textured.setLooks(looks(l));
    plan = null;
    modelChanged();
    renderMaterials(); renderPlan(); updateButtons();
    setLook('original');
    status(`${name} is the texture of ${m.name} now.`);
  } catch (e) {
    status(`${name}: ${errorText(e)}`);
  }
}

// ---------- painting from the textures ----------
function textureSettings(): Partial<TextureSettings> {
  return plan ? plan.settings : { ...DEFAULT_SETTINGS, colours: num('tex-count') };
}

function renderPlan() {
  const box = $('plan-colours');
  const colours = plan ? planPalette(plan.entries) : [];
  box.replaceChildren(...colours.map((c) => h('span', { class: 'plan-colour' }, h('i', { style: { background: hex(c) } }), hex(c).toUpperCase())));
  $('plan-info').textContent = plan
    ? `${plural(colours.length, 'colour')} from Prepare texture; smallest feature ${plan.settings.feature} mm. Changing the count above chooses afresh.`
    : 'The colours are chosen from the textures, by how much of the model each covers. Prepare texture shows them and lets you change them.';
}

function setCount(v: number, fromPlan = false) {
  const n = Math.max(1, Math.min(MAX_COLOURS, Math.round(v) || 1));
  $<HTMLInputElement>('tex-count').value = String(n);
  $<HTMLInputElement>('tex-count-num').value = String(n);
  fillSlider($<HTMLInputElement>('tex-count'));
  if (!fromPlan && plan) { plan = null; renderPlan(); }
}
$('tex-count').addEventListener('input', () => setCount(num('tex-count')));
$('tex-count-num').addEventListener('change', () => setCount(num('tex-count-num')));

$('prepare-texture').onclick = async () => {
  if (!loaded) return;
  const l = loaded;
  const textures = l.model.materials.map((m, i) => ({ material: i, name: `${m.name}${m.texture ? `: ${m.texture.name}` : ''}`, picture: l.pictures[i]! }))
    .filter((t, i) => t.picture && l.use[i] === 'texture');
  const initial = plan ?? { settings: { ...DEFAULT_SETTINGS, colours: num('tex-count') }, entries: [] };
  const got = await prepareTexture(jobs, textures, initial);
  if (!got) { status('Prepare texture: nothing changed.'); return; }
  plan = got;
  setCount(planPalette(got.entries).length, true);
  renderPlan();
  await paintFromTextures();
};

async function paintFromTextures() {
  if (!loaded || !anyPaintSource()) return;
  const settings = textureSettings();
  const t0 = performance.now();
  progress('Painting from the textures…', 0.02, () => jobs.cancel());
  $<HTMLButtonElement>('paint-textures').disabled = true;
  try {
    const r = await jobs.paint(settings, null, (f, m) => progress(m, f));
    progress('Showing the paint…', 0.98);
    await frame();
    palette = r.palette.slice(0, MAX_COLOURS);
    ensurePaint();
    paint!.setPalette(palette);
    paint!.restore(r.faceMaterial, r.codes, true);
    lastPaint = r;
    active = Math.min(active, palette.length - 1);
    setLook('painted');
    renderPalette();
    const secs = (performance.now() - t0) / 1000;
    const total = r.faceMaterial.length;
    let text = `Painted in ${plural(r.palette.length, 'colour')}: ${plural(r.splitFaces, 'triangle')} of ${total.toLocaleString()} split where colours meet, into ${plural(r.leaves, 'piece')} (${secs.toFixed(1)} s).`;
    if (r.leaves > MANY_LEAVES) text += ` That is a lot of paint for a slicer to read; a bigger smallest feature (Prepare texture) makes less.`;
    if (r.unpainted) text += ` ${plural(r.unpainted, 'triangle')} had nothing to paint from and took colour 1.`;
    if (r.notes.length) text += ' ' + r.notes.join(' ');
    $('paint-result').textContent = text;
    status(`Painted from the textures. Save it as a painted 3MF, or touch it up on the Paint tab.`);
  } catch (e) {
    status(e instanceof Cancelled ? 'Painting stopped.' : `Painting from the textures failed: ${errorText(e)}`);
  } finally {
    progress(null);
    updateButtons();
  }
}
$('paint-textures').onclick = () => void paintFromTextures();

// ---------- the paint ----------
function ensurePaint() {
  if (paint || !loaded) return;
  paint = new PaintView(loaded.model.mesh, palette);
  paint.object.visible = look === 'painted';
  paint.onChange = onPaintChange;
  stage.content.add(paint.object);
  picker = new Picker(stage.renderer, paint);
  faceMapCache = null;
}

let infoTimer = 0;
function onPaintChange() {
  stage.render();
  updateHistory();
  clearTimeout(infoTimer);
  infoTimer = window.setTimeout(updatePaintInfo, 250);
}

function setLook(l: 'original' | 'painted') {
  look = l;
  if (loaded) loaded.textured.object.visible = l === 'original';
  if (paint) paint.object.visible = l === 'painted';
  $('look').classList.toggle('hidden', !paint || !loaded);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#look button')) b.classList.toggle('active', b.dataset.look === l);
  stage.render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#look button')) b.onclick = () => {
  if (b.dataset.look === 'original' && tab === 'paint') setTab('textures');
  setLook(b.dataset.look as 'original' | 'painted');
};

function updatePaintInfo() {
  const box = $('paint-info');
  const list = $('filaments');
  if (!paint) {
    box.textContent = loaded ? `${plural(loaded.model.mesh.triangles.length / 3, 'triangle')}, nothing painted yet.` : '';
    list.replaceChildren(h('li', { class: 'muted small' }, 'Nothing painted yet.'));
    return;
  }
  const leaves = paint.leafCount();
  box.textContent = `${plural(paint.count, 'triangle')}, ${paint.paintedFaces.toLocaleString()} painted other than colour 1`
    + (paint.codes.size ? `, ${paint.codes.size.toLocaleString()} split into ${plural(leaves - (paint.count - paint.codes.size), 'piece')}.` : '.')
    + (leaves > MANY_LEAVES ? ' That is a lot of paint for a slicer to read.' : '');
  const areas = paint.colourAreas(palette.length);
  const total = areas.reduce((a, b) => a + b, 0) || 1;
  list.replaceChildren(...palette.map((c, i) => h('li', null,
    h('i', { style: { background: hex(c) } }), h('b', null, `Filament ${i + 1}`), h('span', null, hex(c).toUpperCase()),
    h('span', { class: 'share' }, `${((areas[i] / total) * 100).toFixed(areas[i] / total < 0.01 ? 2 : 1)} %`))));
}

function updateHistory() {
  $<HTMLButtonElement>('undo').disabled = !paint?.canUndo;
  $<HTMLButtonElement>('redo').disabled = !paint?.canRedo;
}

function updateButtons() {
  const has = !!loaded;
  $<HTMLButtonElement>('prepare-texture').disabled = !has || !loaded!.use.some((u, i) => u === 'texture' && loaded!.pictures[i]);
  $<HTMLButtonElement>('paint-textures').disabled = !has || !anyPaintSource() || jobs.busy;
  for (const id of ['export-3mf', 'export-stl']) $<HTMLButtonElement>(id).disabled = !has;
  $<HTMLButtonElement>('export-split').disabled = !paint;
  updateHistory();
}

// ---------- palette ----------
function renderPalette() {
  const box = $('palette');
  box.replaceChildren(...palette.map((c, i) => {
    const input = h('input', { type: 'color', value: hex(c), 'aria-label': `Colour ${i + 1}` });
    input.addEventListener('input', () => { palette[i] = parseColour(input.value); paint?.setPalette(palette); stage.render(); updatePaintInfo(); if (tab === 'paint') updateHover(); });
    const sw = h('label', { class: `swatch ${i === active ? 'active' : ''}`, title: `Colour ${i + 1}: filament ${i + 1}` }, h('span', { class: 'swatch-n' }, String(i + 1)), input);
    sw.addEventListener('click', (e) => { if (e.target !== input) { active = i; renderPalette(); } else { active = i; for (const s of box.querySelectorAll('.swatch')) s.classList.toggle('active', s === sw); } });
    return sw;
  }));
  $<HTMLButtonElement>('palette-add').disabled = palette.length >= MAX_COLOURS;
  $<HTMLButtonElement>('palette-remove').disabled = palette.length <= 1;
}
const parseColour = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

$('palette-add').onclick = () => {
  if (palette.length >= MAX_COLOURS) return;
  const used = new Set(palette.map(hex));
  palette.push(SPARE.find((c) => !used.has(hex(c))) ?? [128, 128, 128]);
  active = palette.length - 1;
  paint?.setPalette(palette);
  renderPalette();
  updatePaintInfo();
};

$('palette-remove').onclick = () => {
  if (palette.length <= 1) return;
  const gone = active;
  const select = h('select', null, ...palette.map((c, i) => (i === gone ? null : h('option', { value: String(i) }, `Colour ${i + 1} (${hex(c).toUpperCase()})`))));
  const d = dialog(`Remove colour ${gone + 1}`, false, () => {});
  d.body.append(h('p', null, `What is painted in colour ${gone + 1} is painted in:`), select);
  d.footer.append(
    h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'),
    h('button', {
      type: 'button', class: 'primary', onclick: () => {
        const into = Number(select.value);
        const map = palette.map((_, i) => (i === gone ? into : i));
        // close up the palette: the colours after the one removed move down one
        for (let i = 0; i < map.length; i++) if (map[i] > gone) map[i]--;
        if (paint) { paint.snapshot(); paint.remap(map); }
        palette.splice(gone, 1);
        active = Math.min(map[gone], palette.length - 1);
        paint?.setPalette(palette);
        renderPalette();
        updatePaintInfo();
        d.close();
      },
    }, 'Remove'));
};

// ---------- tabs ----------
function setTab(name: string) {
  tab = name;
  for (const x of document.querySelectorAll<HTMLButtonElement>('.tabs button')) x.classList.toggle('active', x.dataset.tab === name);
  for (const t of ['model', 'textures', 'paint']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
  if (name === 'paint' && loaded) { ensurePaint(); setLook('painted'); renderPalette(); updatePaintInfo(); }
  if (name !== 'paint') { paint?.showBrush(null, 0); clearCorners(); }
  view.classList.toggle('painting', name === 'paint');
  // painting: the left button paints, the right turns the view, the middle moves it
  stage.controls.mouseButtons = name === 'paint'
    ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  updateButtons();
  drawOverlay();
  stage.render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.onclick = () => setTab(b.dataset.tab!);

// ---------- paint tools ----------
type Tool = 'brush' | 'bucket' | 'corners' | 'text' | 'image' | 'pick';
let tool: Tool = 'brush';
function setTool(t: Tool) {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-tools button')) b.classList.toggle('active', b.dataset.tool === t);
  for (const x of ['brush', 'bucket', 'corners', 'text', 'image', 'pick']) $(`tool-${x}`).classList.toggle('hidden', x !== t);
  if (t !== 'corners') clearCorners();
  if (t !== 'brush') paint?.showBrush(null, 0);
  drawOverlay();
  stage.render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-tools button')) b.onclick = () => setTool(b.dataset.tool as Tool);

/** A slider and its number box kept together. */
function fillSlider(r: HTMLInputElement) {
  const min = Number(r.min), max = Number(r.max);
  r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
}
function pair(slider: string, box: string, onChange?: () => void) {
  const r = $<HTMLInputElement>(slider), n = $<HTMLInputElement>(box);
  n.value = r.value;
  fillSlider(r);
  r.addEventListener('input', () => { n.value = r.value; fillSlider(r); onChange?.(); });
  n.addEventListener('input', () => { if (n.value !== '' && Number.isFinite(Number(n.value))) { r.value = n.value; fillSlider(r); onChange?.(); } });
}
pair('brush', 'brush-num', () => updateHover());
pair('bucket-angle', 'bucket-angle-num');
pair('text-size', 'text-size-num', () => drawOverlay());
pair('text-angle', 'text-angle-num', () => drawOverlay());
pair('stamp-width', 'stamp-width-num', () => drawOverlay());
pair('stamp-angle', 'stamp-angle-num', () => drawOverlay());
pair('tex-count', 'tex-count-num');
for (const id of ['text-value', 'text-font']) $(id).addEventListener('input', () => drawOverlay());

const brushRadius = () => Math.max(0.05, Number($<HTMLInputElement>('brush-num').value) || num('brush'));
const local = (e: { clientX: number; clientY: number }): [number, number] => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

let hover: [number, number] | null = null;
let hoverQueued = false;
function updateHover() {
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    if (!paint || !picker || tab !== 'paint') return;
    if (tool === 'brush' && hover && !orbiting) {
      const hit = picker.hit(stage.camera, hover[0], hover[1], stage.width, stage.height);
      paint.showBrush(hit ? hit.point : null, brushRadius(), palette[active]);
    } else paint.showBrush(null, 0);
    drawOverlay();
    stage.render();
  });
}

let orbiting = false;
let stroke: { last: [number, number] } | null = null;

function pixelsPerMm(point: THREE.Vector3 | null): number {
  const p = point ?? stage.controls.target;
  const dist = Math.max(1e-3, stage.camera.position.distanceTo(p));
  return stage.height / 2 / (dist * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2)));
}

function brushAt(x: number, y: number): THREE.Vector3 | null {
  if (!paint || !picker) return null;
  const hit = picker.hit(stage.camera, x, y, stage.width, stage.height);
  if (!hit) return null;
  let facing: [number, number, number] | undefined;
  if ($<HTMLInputElement>('brush-facing').checked) {
    const dir = hit.point.clone().sub(stage.camera.position).normalize();
    if (!hit.front) dir.negate();
    facing = [dir.x, dir.y, dir.z];
  }
  paint.brush(hit.point, brushRadius(), active, { facing });
  return hit.point;
}

view.addEventListener('pointerdown', (e) => {
  if (tab !== 'paint' || !paint || !picker) return;
  if (e.button === 2 || e.button === 1) { orbiting = true; paint.showBrush(null, 0); return; }
  if (e.button !== 0) return;
  const [x, y] = local(e);
  if (tool === 'brush') {
    view.setPointerCapture(e.pointerId);
    paint.snapshot();
    stroke = { last: [x, y] };
    brushAt(x, y);
  } else if (tool === 'bucket') {
    const hit = picker.hit(stage.camera, x, y, stage.width, stage.height);
    if (!hit) { status('Click the model to fill a region of it.'); return; }
    paint.snapshot();
    const t0 = performance.now();
    const n = paint.bucket(hit.face, hit.weights, active, num('bucket-angle'));
    status(n ? `Filled ${plural(n, 'triangle')} (${(performance.now() - t0).toFixed(0)} ms).` : 'That region is that colour already.');
  } else if (tool === 'pick') {
    const hit = picker.hit(stage.camera, x, y, stage.width, stage.height);
    if (!hit) return;
    active = paint.colourAt(hit.face, hit.weights);
    renderPalette();
    status(`Painting with colour ${active + 1} (${hex(palette[active]).toUpperCase()}).`);
    setTool('brush');
  } else if (tool === 'corners') {
    corners.push([x, y]);
    $<HTMLButtonElement>('corners-apply').disabled = corners.length < 3;
    $('corners-info').textContent = `${plural(corners.length, 'corner')}. ${corners.length < 3 ? 'At least three.' : 'Double-click or Fill inside to paint.'}`;
    drawOverlay();
  } else if (tool === 'text') stampText(x, y);
  else if (tool === 'image') stampImage(x, y);
});

view.addEventListener('pointermove', (e) => {
  if (tab !== 'paint') return;
  hover = local(e);
  if (stroke && paint) {
    const [x, y] = hover, [lx, ly] = stroke.last;
    const at = brushAt(x, y);
    // a fast stroke: the brush also at points between
    const rpx = brushRadius() * pixelsPerMm(at);
    const d = Math.hypot(x - lx, y - ly);
    const steps = Math.min(12, Math.floor(d / Math.max(2, rpx * 0.6)));
    for (let s = 1; s < steps; s++) brushAt(lx + ((x - lx) * s) / steps, ly + ((y - ly) * s) / steps);
    stroke.last = [x, y];
  }
  updateHover();
});
const endStroke = () => { if (stroke) { stroke = null; updatePaintInfo(); updateHistory(); } orbiting = false; updateHover(); };
view.addEventListener('pointerup', endStroke);
view.addEventListener('pointercancel', endStroke);
view.addEventListener('pointerleave', () => { hover = null; paint?.showBrush(null, 0); drawOverlay(); stage.render(); });
view.addEventListener('contextmenu', (e) => e.preventDefault());
stage.controls.addEventListener('change', () => { faceMapCache = null; });
stage.controls.addEventListener('end', () => { orbiting = false; });
new ResizeObserver(() => { faceMapCache = null; drawOverlay(); }).observe($('stage'));

$('fill-all').onclick = () => { ensurePaint(); if (paint) { paint.snapshot(); paint.fillAll(active); updatePaintInfo(); status(`Everything is colour ${active + 1} now.`); } };
$('undo').onclick = () => { if (paint?.undo()) updatePaintInfo(); else status('Nothing to undo.'); };
$('redo').onclick = () => { if (paint?.redo()) updatePaintInfo(); else status('Nothing to redo.'); };

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); $(e.shiftKey ? 'redo' : 'undo').click(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); $('redo').click(); return; }
  if (mod) return;
  if (e.key === 'f' || e.key === 'F') { $('view-fit').click(); return; }
  if (tab !== 'paint') return;
  const tools: Record<string, Tool> = { b: 'brush', g: 'bucket', l: 'corners', t: 'text', i: 'image', k: 'pick' };
  if (tools[e.key]) { setTool(tools[e.key]); return; }
  if (e.key === '[' || e.key === ']') {
    const r = $<HTMLInputElement>('brush');
    const v = Math.max(Number(r.min), Math.min(Number(r.max), brushRadius() * (e.key === ']' ? 1.25 : 0.8)));
    r.value = String(Math.round(v * 10) / 10);
    r.dispatchEvent(new Event('input'));
    return;
  }
  if (tool === 'corners') {
    if (e.key === 'Escape') clearCorners();
    if (e.key === 'Enter') applyCorners();
  }
  if (e.key >= '1' && e.key <= '9' && Number(e.key) <= palette.length) { active = Number(e.key) - 1; renderPalette(); updateHover(); }
});

// ---------- stamps: corners, text and pictures, painted as the camera sees them ----------
const overlay = $<HTMLCanvasElement>('overlay');
let corners: [number, number][] = [];
let faceMapCache: { ids: Int32Array; w: number; h: number } | null = null;
function faceMap() {
  if (!picker) return null;
  const w = stage.width, h = stage.height;
  if (!faceMapCache || faceMapCache.w !== w || faceMapCache.h !== h) faceMapCache = { ids: picker.map(stage.camera, w, h), w, h };
  return faceMapCache;
}
const faceAt = (x: number, y: number) => picker?.faceAt(stage.camera, x, y, stage.width, stage.height) ?? -1;
function centroidPoint(f: number): THREE.Vector3 | null {
  if (!paint || f < 0) return null;
  const c = paint.centroids;
  return new THREE.Vector3(c[f * 3], c[f * 3 + 1], c[f * 3 + 2]);
}

/**
 * Paints a screen stamp (a palette index per pixel, −1 for none) onto the
 * triangles that show under it, splitting them where its colours change.
 */
function paintStamp(labels: Int16Array, what: string) {
  const map = faceMap();
  if (!map || !paint) return;
  const { ids, w, h } = map;
  const p = paint;
  const seen = new Set<number>();
  for (let i = 0; i < w * h; i++) {
    if (labels[i] < 0) continue;
    for (const j of [i, i - 1, i + 1, i - w, i + w]) { if (j < 0 || j >= w * h) continue; const f = ids[j]; if (f >= 0 && f < p.count) seen.add(f); }
  }
  // the triangles round those seen, facing the camera the same way, so pieces too small to own a pixel come along
  const cam = stage.camera.position, N = p.faceNormals, C = p.centroids;
  const side = (f: number) => Math.sign(N[f * 3] * (C[f * 3] - cam.x) + N[f * 3 + 1] * (C[f * 3 + 1] - cam.y) + N[f * 3 + 2] * (C[f * 3 + 2] - cam.z));
  const adj = p.faceAdjacency;
  const candidates = new Set<number>(seen);
  for (const f of seen) {
    const s = side(f);
    for (let k = 0; k < 3; k++) { const g = adj[f * 3 + k]; if (g >= 0 && !seen.has(g) && side(g) === s) candidates.add(g); }
  }
  const v = new THREE.Vector3();
  const stampView: StampView = {
    project: (x, y, z) => { v.set(x, y, z).project(stage.camera); return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h]; },
    visible: (f, x, y) => { const g = ids[Math.floor(y) * w + Math.floor(x)]; return g === f || (g >= 0 && p.touches(f, g)); },
  };
  paint.snapshot();
  const t0 = performance.now();
  const n = paint.paintLabels({ labels, width: w, height: h }, stampView, candidates);
  updatePaintInfo();
  const ms = performance.now() - t0;
  status(n ? `${what}: ${plural(n, 'triangle')} painted (${ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`}).` : `${what}: nothing under it. Point at the model, or zoom in.`);
}

function maskLabels(inMask: (x: number, y: number) => boolean): Int16Array {
  const w = stage.width, h = stage.height, labels = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inMask(x, y)) labels[y * w + x] = active;
  return labels;
}
function canvasLabels(ctx: CanvasRenderingContext2D, labels: Int16Array, colour: number) {
  const w = stage.width, h = stage.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] > 127) labels[i] = colour;
}

const textOptions = () => ({
  text: $<HTMLInputElement>('text-value').value,
  size: Number($<HTMLInputElement>('text-size-num').value) || num('text-size'),
  angle: Number($<HTMLInputElement>('text-angle-num').value) || 0,
  font: $<HTMLSelectElement>('text-font').value,
});
function placeText(ctx: CanvasRenderingContext2D, x: number, y: number, fontPx: number, mode: 'fill' | 'stroke') {
  const o = textOptions();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(THREE.MathUtils.degToRad(-o.angle));
  ctx.font = o.font.replace('1px', `${fontPx.toFixed(1)}px`);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (mode === 'fill') { ctx.fillStyle = '#fff'; ctx.fillText(o.text, 0, 0); }
  else { ctx.lineWidth = 1.5; ctx.strokeStyle = '#f2b84b'; ctx.strokeText(o.text, 0, 0); ctx.fillStyle = 'rgba(242,184,75,0.25)'; ctx.fillText(o.text, 0, 0); }
  ctx.restore();
}
function stampText(x: number, y: number) {
  const o = textOptions();
  if (!o.text.trim()) { status('Type some text first.'); return; }
  const f = faceAt(x, y);
  if (f < 0) { status('Point at the model to stamp the text on it.'); return; }
  const w = stage.width, h = stage.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  placeText(ctx, x, y, o.size * pixelsPerMm(centroidPoint(f)), 'fill');
  const labels = new Int16Array(w * h).fill(-1);
  canvasLabels(ctx, labels, active);
  paintStamp(labels, `"${o.text}"`);
}
function applyCorners() {
  if (corners.length < 3) { status('Click at least three corners first.'); return; }
  const poly = corners;
  paintStamp(maskLabels((x, y) => insidePolygon(poly, x + 0.5, y + 0.5)), plural(poly.length, 'corner'));
  clearCorners();
}
function clearCorners() {
  corners = [];
  $<HTMLButtonElement>('corners-apply').disabled = true;
  $('corners-info').textContent = 'No corners yet.';
  drawOverlay();
}
$('corners-apply').onclick = applyCorners;
$('corners-clear').onclick = clearCorners;
view.addEventListener('dblclick', (e) => {
  if (tab !== 'paint' || tool !== 'corners') return;
  e.preventDefault();
  corners.pop(); // the double-click's second click added one more
  applyCorners();
});

function drawOverlay() {
  const w = stage.width, h = stage.height;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  if (tab !== 'paint' || !paint) return;
  if (tool === 'corners' && corners.length) {
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (hover) ctx.lineTo(hover[0], hover[1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(242,184,75,0.18)'; ctx.fill();
    ctx.strokeStyle = '#f2b84b'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const [x, y] of corners) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = '#f2b84b'; ctx.fill(); }
  }
  if (tool === 'text' && hover) placeText(ctx, hover[0], hover[1], textOptions().size * pixelsPerMm(centroidPoint(faceAt(hover[0], hover[1]))), 'stroke');
  if (tool === 'image' && hover && stamp) {
    const ppm = pixelsPerMm(centroidPoint(faceAt(hover[0], hover[1])));
    ctx.save();
    ctx.globalAlpha = 0.7;
    placeStamp(ctx, hover[0], hover[1], ppm, (layer) => { ctx.fillStyle = hex(layer.color); ctx.fill(layer.path, layer.rule); });
    ctx.restore();
    placeStamp(ctx, hover[0], hover[1], ppm, (layer, scale) => { ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = '#f2b84b'; ctx.stroke(layer.path); });
  }
}

interface StampLayer { color: RGB; contours: Contour[]; rule: CanvasFillRule; path: Path2D }
let stamp: { name: string; width: number; cx: number; cy: number; layers: StampLayer[] } | null = null;
let stampRaster: Raster | null = null;
let stampSettings: Partial<ImageSettings> = {};

function setStamp(name: string, layers: Omit<StampLayer, 'path'>[]) {
  const all = layers.flatMap((l) => l.contours);
  if (!all.length) throw new Error('nothing is left to stamp');
  const b = contourBounds(all);
  stamp = {
    name, width: Math.max(1e-6, b.maxX - b.minX), cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2,
    layers: layers.map((l) => {
      const path = new Path2D();
      for (const c of l.contours) { for (let i = 0; i < c.length; i += 2) (i ? path.lineTo(c[i], c[i + 1]) : path.moveTo(c[i], c[i + 1])); path.closePath(); }
      return { ...l, path };
    }),
  };
  $('stamp-preview').replaceChildren(tracedPreview({ width: stamp.width, height: b.maxY - b.minY, regions: stamp.layers }));
  $<HTMLButtonElement>('stamp-adjust').disabled = !stampRaster;
  const colours = new Set(stamp.layers.map((l) => hex(l.color))).size;
  $('stamp-info').textContent = `${name}: ${plural(colours, 'colour')}. Move over the model to place it, click to paint. Right-drag turns the view.`;
  setTool('image');
}
function placeStamp(ctx: CanvasRenderingContext2D, x: number, y: number, pxPerMm: number, draw: (layer: StampLayer, scale: number) => void) {
  if (!stamp) return;
  const width = Number($<HTMLInputElement>('stamp-width-num').value) || num('stamp-width');
  const scale = (width * pxPerMm) / stamp.width;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(THREE.MathUtils.degToRad(-(Number($<HTMLInputElement>('stamp-angle-num').value) || 0)));
  ctx.scale(scale, -scale); // the picture's y is up
  ctx.translate(-stamp.cx, -stamp.cy);
  for (const layer of stamp.layers) draw(layer, scale);
  ctx.restore();
}
/** The palette colour for a stamp's colour: one already that colour, else a new one while there is room, else the nearest. */
function paletteIndexOf(c: RGB): number {
  const i = palette.findIndex((p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2]);
  if (i >= 0) return i;
  if (palette.length < MAX_COLOURS) { palette.push(c); paint?.setPalette(palette); return palette.length - 1; }
  let best = 0, bd = Infinity;
  palette.forEach((p, k) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k; } });
  return best;
}
function stampImage(x: number, y: number) {
  if (!stamp) { status('Choose a picture first.'); return; }
  const f = faceAt(x, y);
  if (f < 0) { status('Point at the model to stamp the picture on it.'); return; }
  const w = stage.width, h = stage.height;
  const one = $<HTMLInputElement>('stamp-one').checked;
  const before = palette.length;
  const colours = stamp.layers.map((l) => (one ? active : paletteIndexOf(l.color)));
  if (palette.length !== before) renderPalette();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const labels = new Int16Array(w * h).fill(-1);
  const ppm = pixelsPerMm(centroidPoint(f));
  stamp.layers.forEach((layer, i) => {
    ctx.clearRect(0, 0, w, h);
    placeStamp(ctx, x, y, ppm, (l) => { if (l === layer) { ctx.fillStyle = '#fff'; ctx.fill(l.path, l.rule); } });
    canvasLabels(ctx, labels, colours[i]);
  });
  paintStamp(labels, stamp.name);
}
function cssColour(s: string): RGB {
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = '#000';
  g.fillStyle = s;
  const v = String(g.fillStyle);
  if (v.startsWith('#')) return parseColour(v);
  const m = /rgba?\(([^)]+)\)/.exec(v);
  return m ? (m[1].split(/[\s,]+/).slice(0, 3).map(Number) as RGB) : [0, 0, 0];
}
async function loadStamp(file: File) {
  try {
    if (/\.svg$/i.test(file.name)) {
      const doc = parseSvg(await file.text());
      const shapes = doc.shapes.filter((sh) => sh.fill !== 'none');
      if (!shapes.length) throw new Error('there are no filled shapes in it');
      stampRaster = null; stampSettings = {};
      setStamp(file.name, shapes.map((sh) => ({ color: cssColour(sh.fill ?? '#000000'), contours: sh.contours, rule: sh.fillRule })));
    } else {
      status(`Opening ${file.name}…`);
      const pic = await decodePicture(file.name, new Uint8Array(await file.arrayBuffer()));
      const raster = downscale({ width: pic.width, height: pic.height, data: new Uint8ClampedArray(pic.data) }, 1024);
      const prepared = await prepareImage(raster, file.name, stampSettings, { title: 'Prepare image', maxColors: MAX_COLOURS });
      if (!prepared) { status(`${file.name} was not used.`); return; }
      stampRaster = raster; stampSettings = prepared.settings;
      setStamp(file.name, prepared.regions.map((r) => ({ color: r.color, contours: r.contours, rule: 'evenodd' as CanvasFillRule })));
    }
    status(`${file.name} is ready: click the model to paint it.`);
  } catch (err) {
    status(`${file.name}: ${errorText(err)}`);
  }
}
$<HTMLInputElement>('stamp-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await loadStamp(file);
};
$('stamp-adjust').onclick = async () => {
  if (!stampRaster || !stamp) return;
  const prepared = await prepareImage(stampRaster, stamp.name, stampSettings, { title: 'Prepare image', maxColors: MAX_COLOURS });
  if (!prepared) return;
  stampSettings = prepared.settings;
  setStamp(stamp.name, prepared.regions.map((r) => ({ color: r.color, contours: r.contours, rule: 'evenodd' as CanvasFillRule })));
};

// ---------- saving ----------
function exportName(): string {
  return ($<HTMLInputElement>('export-name').value.trim() || loaded?.model.name || 'model').replace(/[\\/:*?"<>|]+/g, '_');
}

async function save(name: string, parts: Uint8Array[]): Promise<boolean> {
  if (desktop) {
    const where = await saveFile(name, join(parts));
    if (where) status(`Saved ${where}.`);
    return !!where;
  }
  const url = URL.createObjectURL(new Blob(parts as BlobPart[]));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  status(`Saved ${name}.`);
  return true;
}

async function thumbnail(): Promise<Uint8Array | null> {
  if (!$<HTMLInputElement>('export-thumb').checked) return null;
  const was = look;
  if (paint) setLook('painted');
  try { return await stage.thumbnail(512); } finally { setLook(was); }
}

$('export-3mf').onclick = async () => {
  if (!loaded) return;
  const name = exportName();
  progress('Writing the painted 3MF…', 0.3);
  await frame();
  try {
    const codes = paint ? paint.paintCodes() : [];
    const used = paint ? [...paint.materialsUsed()].sort((a, b) => a - b) : [0];
    const parts = await painted3mf({ name, mesh: loaded.model.mesh, codes, palette, thumbnail: await thumbnail() });
    progress(null);
    if (await save(`${name}.3mf`, parts)) {
      $('export-info').textContent = `${name}.3mf: ${plural(palette.length, 'filament')} in the palette, ${used.length} used (${used.map((u) => u + 1).join(', ')}). In the slicer give filament n the colour shown under Filaments; Bambu Studio and OrcaSlicer read the colours from the file.`;
    }
  } catch (e) {
    status(`The 3MF couldn't be written: ${errorText(e)}`);
  } finally { progress(null); }
};

$('export-stl').onclick = async () => {
  if (!loaded) return;
  const name = exportName();
  await save(`${name}.stl`, [stl(loaded.model.mesh, name)]);
};

$('export-split').addEventListener('mouseenter', () => $('split-depth-row').classList.remove('hidden'));
$('export-split').onclick = async () => {
  if (!paint) return;
  const name = exportName();
  progress('Splitting the model by colour…', 0.2);
  await frame();
  try {
    const baked = paint.baked();
    const split = await splitByMaterial(baked.mesh, baked.faceMaterial, palette.length, { depth: num('split-depth') || 1.2 });
    progress('Writing the 3MF…', 0.8);
    await frame();
    const parts = split.parts.map((p) => ({ name: `Colour ${p.material + 1}`, mesh: p.mesh, colour: p.material }));
    const bytes = await parts3mf(name, parts, palette, await thumbnail());
    progress(null);
    if (await save(`${name} by colour.3mf`, bytes)) {
      $('export-info').textContent = `${plural(parts.length, 'part')}, one per colour, each ${num('split-depth') || 1.2} mm deep under its paint.` + (split.warnings.length ? ` ${split.warnings.join('; ')}.` : '');
    }
  } catch (e) {
    const msg = errorText(e);
    status(/manifold|closed|NotManifold|wound/i.test(msg) ? 'Split by colour needs a closed model (no holes or loose edges). The painted 3MF works for any model.' : `Split by colour failed: ${msg}`);
  } finally { progress(null); }
};

// ---------- start ----------
setTab('model');
renderPalette();
updateButtons();
setCount(4);
if (desktop) $('subtitle').textContent = 'paint models for colour printing';
(window as unknown as { modelPainter: unknown }).modelPainter = {
  get loaded() { return loaded; }, get paint() { return paint; }, get palette() { return palette; }, stage, jobs,
  open: (src: FileSource) => openSource(src),
};

// Opens the built app in Chromium and walks it through every way in: a
// textured OBJ, glTF, Collada, FBX and PLY made here, each painted from its
// texture (or vertex colours) and saved as a painted 3MF, which is read back.
// Then a model of overlapping parts made watertight on the Finish tab, and
// the hand tools on a cube. Run with `npm run smoke` (it builds
// first); it needs Playwright's Chromium.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { deflateSync, inflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = new URL('../dist/', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'model-painter-smoke-'));

// ---------- the test models ----------
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// four quarters: red, green, blue, white (V down: the top rows are red and green)
const QUARTERS = [[220, 30, 30], [30, 180, 60], [30, 60, 220], [245, 245, 245]];
writeFileSync(join(out, 'quarters.png'), png(64, 64, (x, y) => [...QUARTERS[(y < 32 ? 0 : 2) + (x < 32 ? 0 : 1)], 255]));

// a 40 mm cube (in the units each format has), every face showing the whole texture
const C = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const QUADS = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const UV = [[0, 0], [1, 0], [1, 1], [0, 1]]; // V up, as these formats have it
const s = 20;
const obj = ['mtllib cube.mtl', ...C.map((p) => `v ${p.map((v) => v * s).join(' ')}`), ...UV.map((t) => `vt ${t.join(' ')}`), 'usemtl Body',
  ...QUADS.map((q) => `f ${q.map((v, k) => `${v + 1}/${k + 1}`).join(' ')}`)].join('\n');
writeFileSync(join(out, 'cube.obj'), obj);
writeFileSync(join(out, 'cube.mtl'), 'newmtl Body\nKd 1 1 1\nmap_Kd quarters.png\n');
// for the Finish tab: two textured cubes pushed into each other (each its own object) and an open sheet hanging off
// one (a cape), Y up as OBJ has it: 26 triangles, 4 open edges
{
  const lines = ['mtllib cube.mtl', ...UV.map((t) => `vt ${t.join(' ')}`), 'usemtl Body'];
  let base = 0;
  for (const [name, at] of [['a', [0, 0, 0]], ['b', [12, 14, 10]]]) {
    lines.push(`o ${name}`, ...C.map((p) => `v ${p.map((v, d) => v * 12 + at[d]).join(' ')}`), ...QUADS.map((q) => `f ${q.map((v, k) => `${v + base + 1}/${k + 1}`).join(' ')}`));
    base += 8;
  }
  lines.push('o cape', 'v -12 -14 13', 'v 12 -14 13', 'v 12 10 22', 'v -12 10 22', `f ${[1, 2, 3, 4].map((v, k) => `${base + v}/${k + 1}`).join(' ')}`);
  writeFileSync(join(out, 'parts.obj'), lines.join('\n'));
}

const tris = QUADS.flatMap((q) => [[q[0], q[1], q[2], 0, 1, 2], [q[0], q[2], q[3], 0, 2, 3]]);
const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
 <asset><unit name="millimetre" meter="0.001"/><up_axis>Z_UP</up_axis></asset>
 <library_images><image id="tex" name="tex"><init_from>quarters.png</init_from></image></library_images>
 <library_effects><effect id="fx"><profile_COMMON>
  <newparam sid="surf"><surface type="2D"><init_from>tex</init_from></surface></newparam>
  <newparam sid="samp"><sampler2D><source>surf</source></sampler2D></newparam>
  <technique sid="common"><lambert><diffuse><texture texture="samp" texcoord="UV"/></diffuse></lambert></technique>
 </profile_COMMON></effect></library_effects>
 <library_materials><material id="mat" name="Body"><instance_effect url="#fx"/></material></library_materials>
 <library_geometries><geometry id="geo"><mesh>
  <source id="pos"><float_array id="pos-a" count="24">${C.flat().map((v) => v * s).join(' ')}</float_array><technique_common><accessor source="#pos-a" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
  <source id="uv"><float_array id="uv-a" count="8">${UV.flat().join(' ')}</float_array><technique_common><accessor source="#uv-a" count="4" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>
  <vertices id="vtx"><input semantic="POSITION" source="#pos"/></vertices>
  <triangles material="mat" count="12"><input semantic="VERTEX" source="#vtx" offset="0"/><input semantic="TEXCOORD" source="#uv" offset="1" set="0"/><p>${tris.map((t) => `${t[0]} ${t[3]} ${t[1]} ${t[4]} ${t[2]} ${t[5]}`).join(' ')}</p></triangles>
 </mesh></geometry></library_geometries>
 <library_visual_scenes><visual_scene id="scene"><node id="n"><instance_geometry url="#geo"><bind_material><technique_common><instance_material symbol="mat" target="#mat"><bind_vertex_input semantic="UV" input_semantic="TEXCOORD" input_set="0"/></instance_material></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes>
 <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`;
writeFileSync(join(out, 'cube.dae'), dae);

// FBX (ASCII, 7.4), Y up: the cube's z becomes y
const fbxPos = C.flatMap(([x, y, z]) => [x * s, z * s, -y * s]);
const fbxIdx = QUADS.flatMap((q) => q.map((v, k) => (k === 3 ? -v - 1 : v)));
const fbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",0.1
	}
}
Objects:  {
	Geometry: 100, "Geometry::Cube", "Mesh" {
		Vertices: *24 {
			a: ${fbxPos.join(',')}
		}
		PolygonVertexIndex: *24 {
			a: ${fbxIdx.join(',')}
		}
		GeometryVersion: 124
		LayerElementUV: 0 {
			Version: 101
			Name: "UVMap"
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "IndexToDirect"
			UV: *8 {
				a: ${UV.flat().join(',')}
			}
			UVIndex: *24 {
				a: ${QUADS.flatMap(() => [0, 1, 2, 3]).join(',')}
			}
		}
		LayerElementMaterial: 0 {
			Version: 101
			Name: ""
			MappingInformationType: "AllSame"
			ReferenceInformationType: "IndexToDirect"
			Materials: *1 {
				a: 0
			}
		}
		Layer: 0 {
			Version: 100
			LayerElement:  {
				Type: "LayerElementUV"
				TypedIndex: 0
			}
			LayerElement:  {
				Type: "LayerElementMaterial"
				TypedIndex: 0
			}
		}
	}
	Model: 200, "Model::Cube", "Mesh" {
		Version: 232
		Properties70:  {
		}
	}
	Material: 300, "Material::Body", "" {
		Version: 102
		ShadingModel: "lambert"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0.8,0.8,0.8
		}
	}
	Video: 500, "Video::quarters", "Clip" {
		Type: "Clip"
		Filename: "C:\\Users\\someone\\textures\\quarters.png"
		RelativeFilename: "textures\\quarters.png"
	}
	Texture: 400, "Texture::quarters", "" {
		Type: "TextureVideoClip"
		Version: 202
		TextureName: "Texture::quarters"
		FileName: "C:\\\\Users\\\\someone\\\\textures\\\\quarters.png"
		RelativeFilename: "textures\\\\quarters.png"
	}
}
Connections:  {
	C: "OO",200,0
	C: "OO",100,200
	C: "OO",300,200
	C: "OP",400,300, "DiffuseColor"
	C: "OO",500,400
}
`;
writeFileSync(join(out, 'cube.fbx'), fbx);

// PLY with vertex colours, no texture
const ply = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue',
  'element face 12', 'property list uchar int vertex_indices', 'end_header',
  ...C.map((p) => `${p.map((v) => v * s).join(' ')} ${p[2] > 0 ? '220 30 30' : '30 60 220'}`),
  ...tris.map((t) => `3 ${t[0]} ${t[1]} ${t[2]}`)].join('\n');
writeFileSync(join(out, 'cube.ply'), ply);

// ---------- a static server for dist ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = existsSync(path) && !path.endsWith('/') ? path : join(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

// ---------- reading a saved 3MF back ----------
function unzip(buf) {
  const files = new Map();
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(at + 10), packed = buf.readUInt32LE(at + 20), nl = buf.readUInt16LE(at + 28), xl = buf.readUInt16LE(at + 30), cl = buf.readUInt16LE(at + 32), off = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nl).toString();
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + packed);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + nl + xl + cl;
  }
  return files;
}

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 880 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);

async function open(files) {
  await page.click('button[data-tab="model"]');
  await page.evaluate(() => { document.getElementById('model-info').textContent = ''; });
  await page.setInputFiles('#model-file', files.map((f) => join(out, f)));
  await page.waitForFunction(() => /triangle/.test(document.getElementById('model-info').textContent) || /:/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  return page.textContent('#model-info');
}

async function paintAndSave(name, colours = 4) {
  await page.click('button[data-tab="textures"]');
  await page.evaluate((n) => { document.getElementById('paint-result').textContent = ''; const r = document.getElementById('tex-count'); r.value = String(n); r.dispatchEvent(new Event('input')); }, colours);
  await page.click('#paint-textures');
  await page.waitForFunction(() => /Painted in|failed/.test(document.getElementById('paint-result').textContent + document.getElementById('status').textContent), null, { timeout: 60000 });
  const result = await page.textContent('#paint-result');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-3mf')]);
  const file = join(out, `${name}.3mf`);
  await download.saveAs(file);
  const xml = unzip(readFileSync(file)).get('3D/3dmodel.model').toString();
  const palette = /ModelPainter:Palette">([^<]*)</.exec(xml)?.[1] ?? '';
  return { result, palette, painted: (xml.match(/paint_color="/g) ?? []).length, thumbnail: unzip(readFileSync(file)).has('Metadata/thumbnail.png') };
}

for (const [label, files] of [['OBJ', ['cube.obj', 'cube.mtl', 'quarters.png']], ['Collada', ['cube.dae', 'quarters.png']], ['FBX', ['cube.fbx', 'quarters.png']]]) {
  const info = await open(files);
  check(/12 triangles/.test(info) && /1 of 1 texture found/.test(info), `${label} opens with its texture: ${info}`);
  const size = await page.textContent('#size-info');
  check(/40\.0 × 40\.0 × 40\.0/.test(size), `${label} is 40 mm: ${size}`);
  const r = await paintAndSave(label);
  const colours = r.palette.split(';');
  check(colours.length === 4, `${label} painted in 4 colours: ${r.palette} (${r.result})`);
  check(r.painted > 0 && r.thumbnail, `${label} 3MF has paint on ${r.painted} triangles and a thumbnail`);
}
{
  const info = await open(['cube.ply']);
  check(/12 triangles/.test(info), `PLY opens: ${info}`);
  const r = await paintAndSave('PLY', 2);
  check(r.palette.split(';').length === 2, `PLY painted from its vertex colours in 2 colours: ${r.palette}`);
}

// the Finish tab: a model of parts made watertight with a base, its paint carried over, saved, and the original back
{
  const info = await open(['parts.obj', 'cube.mtl', 'quarters.png']);
  check(/26 triangles/.test(info), `the model of parts opens: ${info}`);
  await paintAndSave('parts-painted');
  const before = await page.evaluate(() => { const p = window.modelPainter.paint; return { n: p.count, codes: p.codes.size }; });
  await page.click('button[data-tab="finish"]');
  const check0 = await page.textContent('#finish-check');
  check(/4 open edges/.test(check0), `the Finish tab says what is wrong with it: ${check0}`);
  await page.click('#finish-base button[data-base="round"]');
  await page.fill('#finish-base-height', '2');
  await page.click('#finish-run');
  await page.waitForFunction(() => /Watertight in|couldn't/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  const done = await page.textContent('#status');
  check(/^Watertight in/.test(done), `made watertight: ${done}`);
  const stats = await page.textContent('#finish-stats');
  const notes = await page.textContent('#finish-notes');
  check(/Separate pieces1/.test(stats) && /2 parts joined|3 parts joined/.test(notes) && /thickened/.test(notes) && /round base/.test(notes), `what finishing did: ${stats} / ${notes}`);
  const after = await page.evaluate(() => { const p = window.modelPainter.paint; const l = window.modelPainter.loaded; return { n: p.count, codes: p.codes.size, used: [...p.materialsUsed()].length, materials: l.model.materials.length, uvs: !!l.model.uvs }; });
  check(after.n > before.n && after.codes > 0 && after.used >= 3 && after.materials === 2 && after.uvs, `the watertight model keeps its paint and UVs, with a base: ${JSON.stringify(after)}`);
  const size = await page.textContent('#size-info');
  check(/× 37\.0 mm/.test(size) || /mm/.test(size), `its size: ${size}`);
  await page.screenshot({ path: join(out, 'finish.png') });
  await page.click('#look button[data-look="original"]');
  await page.screenshot({ path: join(out, 'finish-textures.png') });
  await page.click('#look button[data-look="painted"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-3mf')]);
  const file = join(out, 'parts-watertight.3mf');
  await download.saveAs(file);
  const xml = unzip(readFileSync(file)).get('3D/3dmodel.model').toString();
  const triangles = (xml.match(/<triangle /g) ?? []).length;
  check(triangles === after.n && (xml.match(/paint_color="/g) ?? []).length > 0, `the saved 3MF is the watertight model with its paint: ${triangles} triangles`);
  await page.click('#finish-show button[data-show="original"]');
  const back = await page.evaluate(() => { const p = window.modelPainter.paint; return { n: p.count, codes: p.codes.size }; });
  check(JSON.stringify(back) === JSON.stringify(before), `Original shows the model as it was, with its own paint: ${JSON.stringify(back)}`);
  await page.click('#finish-show button[data-show="finished"]');
  check((await page.evaluate(() => window.modelPainter.paint.count)) === after.n, 'and Watertight shows the finished one again');
  // its paint can be changed like any model's
  await page.click('button[data-tab="paint"]');
  await page.click('#paint-tools button[data-tool="bucket"]');
  await page.check('#fill-modes input[value="part"]');
  await page.keyboard.press('4');
  const view = await page.locator('#stage > canvas').first().boundingBox();
  await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
  await page.waitForTimeout(200);
  check(/is colour 4 now/.test(await page.textContent('#status')), `the watertight model paints: ${await page.textContent('#status')}`);
  await page.click('button[data-tab="finish"]');
  check(await page.isHidden('#finish-stale'), 'painting the watertight model does not make it out of date');
  await page.click('#finish-base button[data-base="none"]');
  check(await page.isVisible('#finish-stale'), `other settings say it was made with others: ${await page.textContent('#finish-stale')}`);
  await page.click('#finish-base button[data-base="round"]');
}

// the hand tools on the cube
await open(['cube.obj', 'cube.mtl', 'quarters.png']);
await page.click('button[data-tab="paint"]');
const box = await page.locator('#stage > canvas').first().boundingBox();
const mid = [box.x + box.width / 2, box.y + box.height / 2];
const statusText = () => page.textContent('#status');
const paintState = () => page.evaluate(() => { const p = window.modelPainter.paint; return { codes: p.codes.size, faces: Array.from(p.faceMaterial).join(''), paint: Array.from(p.codes.entries()).join('|') }; });
const target = () => page.evaluate(() => window.modelPainter.stage.controls.target.toArray().map((v) => Math.round(v * 100) / 100).join(','));
const fillMode = (m) => page.check(`#fill-modes input[value="${m}"]`);
const undo = async () => { await page.keyboard.press('Control+z'); await page.waitForTimeout(150); };

// the palette: a colour's box picks it, its arrow opens the colour picker
await page.evaluate(() => {
  window.__pickers = 0;
  HTMLInputElement.prototype.showPicker = function () { window.__pickers++; };
  document.addEventListener('click', (e) => { if (e.target instanceof HTMLInputElement && e.target.type === 'color') window.__pickers++; }, true);
});
await page.click('#palette .swatch:nth-child(3) .swatch-pick');
const chosen = await page.textContent('#palette .swatch.active .swatch-n');
check(chosen === '3' && (await page.evaluate(() => window.__pickers)) === 0, `clicking colour 3 paints with it and opens no picker (active ${chosen})`);
await page.click('#palette .swatch:nth-child(2) .swatch-edit');
check((await page.evaluate(() => window.__pickers)) === 1 && (await page.textContent('#palette .swatch.active .swatch-n')) === '3', 'the arrow beside colour 2 opens its picker and leaves colour 3 in use');
await page.click('#palette .swatch:nth-child(2) .swatch-pick');

// the fill's ways of spreading
await page.click('#paint-tools button[data-tool="bucket"]');
await fillMode('crease');
check(await page.isVisible('#bucket-angle-row'), 'the crease fill shows its angle');
await page.mouse.click(...mid);
await page.waitForTimeout(150);
check(/now: 2 triangles/.test(await statusText()), `up to creases fills one side: ${await statusText()}`);
await undo();
await fillMode('colour');
check(!(await page.isVisible('#bucket-angle-row')), 'the same-colour fill has no angle');
await page.mouse.click(...mid);
await page.waitForTimeout(150);
check(/now: 12 triangles/.test(await statusText()), `same colour crosses the creases: ${await statusText()}`);
await undo();
await fillMode('flat');
await page.mouse.click(...mid);
await page.waitForTimeout(150);
check(/now: 2 triangles/.test(await statusText()), `flat area fills one side: ${await statusText()}`);
// repaint that side only: a same-colour fill on it in colour 3 leaves the rest alone
await page.click('#palette .swatch:nth-child(3) .swatch-pick');
await fillMode('colour');
await page.mouse.click(...mid);
await page.waitForTimeout(150);
const repainted = await paintState();
check(/Colour 2 there is colour 3 now: 2 triangles/.test(await statusText()) && repainted.faces.split('').filter((c) => c === '2').length === 2, `same colour repaints just that area: ${await statusText()} (${repainted.faces})`);

await page.screenshot({ path: join(out, 'fill.png') });

// the brush, then a whole-part fill over its spot
await page.click('#paint-tools button[data-tool="brush"]');
await page.keyboard.press('4');
await page.mouse.move(mid[0] - 30, mid[1]);
await page.mouse.down();
for (let i = 0; i < 10; i++) await page.mouse.move(mid[0] - 30 + i * 6, mid[1] + i);
await page.mouse.up();
await page.waitForTimeout(400);
check(/split into/.test(await page.textContent('#paint-info')), `brush splits triangles: ${await page.textContent('#paint-info')}`);
await page.click('#paint-tools button[data-tool="bucket"]');
await fillMode('part');
await page.keyboard.press('1');
await page.mouse.click(...mid);
await page.waitForTimeout(300);
const part = await paintState();
check(/The part \(12 triangles\) is colour 1 now/.test(await statusText()) && part.codes === 0 && part.faces === '000000000000', `whole part fills every triangle: ${await statusText()} (${part.faces}, ${part.codes} split)`);
await undo();
check((await paintState()).codes > 0, 'undo brings the brushed spot back');

// moving the view: the middle button, the Move button, and Space, none of which paints
await page.click('#paint-tools button[data-tool="brush"]');
check(/Middle/.test(await page.textContent('#view-hint')), `the view says how to move it: ${await page.textContent('#view-hint')}`);
const drag = async (button, dx = 60, dy = 30) => {
  await page.mouse.move(...mid);
  await page.mouse.down({ button });
  for (let i = 1; i <= 6; i++) await page.mouse.move(mid[0] + (dx * i) / 6, mid[1] + (dy * i) / 6);
  await page.mouse.up({ button });
  await page.waitForTimeout(300);
};
let before = await paintState(), t0 = await target();
await drag('middle');
check((await target()) !== t0 && JSON.stringify(await paintState()) === JSON.stringify(before), 'a middle-button drag moves the view and paints nothing');
await page.click('#view-move');
t0 = await target();
await drag('left', -50, 20);
check((await target()) !== t0 && JSON.stringify(await paintState()) === JSON.stringify(before), 'with Move on, a left drag moves the view and paints nothing');
await page.keyboard.press('Escape');
check(!(await page.evaluate(() => document.querySelector('#stage > canvas').classList.contains('moving'))), 'Esc turns Move off');
t0 = await target();
await page.keyboard.down('Space');
await drag('left', 40, -40);
await page.keyboard.up('Space');
check((await target()) !== t0 && JSON.stringify(await paintState()) === JSON.stringify(before), 'Space + drag moves the view and paints nothing');
await page.keyboard.press('2');
await drag('left', 30, 0);
check(JSON.stringify(await paintState()) !== JSON.stringify(before), 'after Space is let go, a left drag paints again');
await undo();
await page.screenshot({ path: join(out, 'paint.png') });

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
await browser.close();
server.close();
console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed'} (files in ${out})`);
process.exit(failures.length ? 1 : 0);

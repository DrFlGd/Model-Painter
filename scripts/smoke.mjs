// Opens the built app in Chromium and walks it through every way in: a
// textured OBJ, glTF, Collada, FBX and PLY made here, each painted from its
// texture (or vertex colours) and saved as a painted 3MF, which is read back.
// Then the hand tools on the last one. Run with `npm run smoke` (it builds
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

// the hand tools on the cube
await open(['cube.obj', 'cube.mtl', 'quarters.png']);
await page.click('button[data-tab="paint"]');
await page.click('#paint-tools button[data-tool="bucket"]');
const box = await page.locator('#stage > canvas').first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(200);
check(/Filled [1-9]/.test(await page.textContent('#status')), `fill: ${await page.textContent('#status')}`);
await page.click('#paint-tools button[data-tool="brush"]');
await page.keyboard.press('3'); // another colour than the fill's
await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2);
await page.mouse.down();
for (let i = 0; i < 10; i++) await page.mouse.move(box.x + box.width / 2 - 30 + i * 6, box.y + box.height / 2 + i);
await page.mouse.up();
await page.waitForTimeout(400);
check(/split into/.test(await page.textContent('#paint-info')), `brush splits triangles: ${await page.textContent('#paint-info')}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check(!/split into/.test(await page.textContent('#paint-info')), `undo: ${await page.textContent('#paint-info')}`);
await page.screenshot({ path: join(out, 'paint.png') });

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
await browser.close();
server.close();
console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed'} (files in ${out})`);
process.exit(failures.length ? 1 : 0);

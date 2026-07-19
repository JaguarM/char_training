// probe-snap.mjs — measure MuPDF wasm's ACTUAL subpixel snap grid by pixels.
// Renders one glyph at fine fractional pen steps, hashes the rasters, prints
// where the raster changes. Run for isotropic AND anisotropic matrices to
// answer: does [emx,0,0,-emy] (Tz-style stretch) move the snap boundaries?
//
//   node tools/probe-snap.mjs --emx 12.36 --emy 12 --cp 101 --steps 128
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const EMX = parseFloat(optS('emx', '12.36'));
const EMY = parseFloat(optS('emy', String(EMX)));
const CP = parseInt(optS('cp', '101'));
const STEPS = parseInt(optS('steps', '128'));
const FONTF = optS('font', 'fonts/cour.ttf');

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const font = new mupdf.Font('F', readFileSync(`${root}/${FONTF}`));
const gid = font.encodeCharacter(CP);

const W = 40, H = 40, PENX = 12, BASEY = 26;
function render(fx, fy) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const text = new mupdf.Text();
  text.showGlyph(font, [EMX, 0, 0, -EMY, PENX + fx, BASEY + fy], gid, CP, 0);
  dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  dev.close();
  const h = createHash('sha1').update(Buffer.from(pix.getPixels())).digest('hex').slice(0, 8);
  pix.destroy();
  return h;
}

function sweep(axis) {
  const hashes = [];
  for (let k = 0; k < STEPS; k++) {
    const t = k / STEPS;
    hashes.push(axis === 'x' ? render(t, 0.3) : render(0.3, t));
  }
  const uniq = [...new Set(hashes)];
  const bounds = [];
  for (let k = 1; k < STEPS; k++) if (hashes[k] !== hashes[k - 1]) bounds.push(k);
  console.log(`  ${axis}: ${uniq.length} distinct rasters; boundaries at k/${STEPS} = ${bounds.map(k => (k / STEPS).toFixed(4)).join(', ') || '(none)'}`);
  return uniq.length;
}

console.log(`cp ${CP} '${String.fromCodePoint(CP)}'  em [${EMX}, ${EMY}]  font ${FONTF}`);
const nx = sweep('x');
const ny = sweep('y');
// 2-D separability check on a 16x16 grid
const set2 = new Set();
for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) set2.add(render(i / 16, j / 16));
console.log(`  2-D distinct on 16x16 grid: ${set2.size} (separable would be ${nx}*${ny} = ${nx * ny})`);

// ftdebug.mjs — one-case diff: ftclone vs fillText
//   node tools/ftdebug.mjs --cp 46 --emx 12.36 --emy 12.36 --fx64 32 --fy64 32
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CP = parseInt(optS('cp', '46'));
const EMX = parseFloat(optS('emx', '12.36'));
const EMY = parseFloat(optS('emy', '12.36'));
const FX64 = parseInt(optS('fx64', '32'));
const FY64 = parseInt(optS('fy64', '32'));
const em64x = Math.trunc(EMX * 64), em64y = Math.trunc(EMY * 64);

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fontFile = `${root}/fonts/cour.ttf`;
const mf = new mupdf.Font('F', readFileSync(fontFile));
const W = 30, H = 30, PENX = 8, BASEY = 20;

const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
pix.clear(255);
const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
const text = new mupdf.Text();
text.showGlyph(mf, [EMX, 0, 0, -EMY, PENX + FX64 / 64, BASEY + FY64 / 64], mf.encodeCharacter(CP), CP, 0);
dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
dev.close();
const ref = Buffer.from(pix.getPixels());

const clone = new FTClone(fontFile, W, H);
const got = clone.render(CP, em64x, em64y, PENX * 64 + FX64, BASEY * 64 + FY64, 1);

const r0 = Math.max(0, BASEY - Math.ceil(EMY) - 2), r1 = Math.min(H, BASEY + 4);
console.log(`cp ${CP} '${String.fromCodePoint(CP)}' em64 (${em64x},${em64y}) pen64 (+${FX64},+${FY64})`);
for (const [label, buf] of [['fillText', ref], ['ftclone', got]]) {
  console.log(`--- ${label}:`);
  for (let r = r0; r < r1; r++) console.log('  ' + Array.from({ length: W }, (_, c) => String(buf[r * W + c]).padStart(4)).join(''));
}
console.log('--- diff (text - clone):');
for (let r = r0; r < r1; r++) console.log('  ' + Array.from({ length: W }, (_, c) => {
  const d = ref[r * W + c] - got[r * W + c];
  return String(d === 0 ? '.' : d).padStart(4);
}).join(''));

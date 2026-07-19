// pathdiff.mjs — where do fillPath and fillText differ? dump both + diff.
//   node tools/pathdiff.mjs --cp 101 --fx 0 --fy 0 --emx 12.36 --emy 12
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { GlyphRenderer } from './pathrender.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CP = parseInt(optS('cp', '101'));
const FX = parseFloat(optS('fx', '0'));
const FY = parseFloat(optS('fy', '0'));
const EMX = parseFloat(optS('emx', '12.36'));
const EMY = parseFloat(optS('emy', '12'));

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fontFile = `${root}/fonts/cour.ttf`;
const mf = new mupdf.Font('F', readFileSync(fontFile));
const W = 26, H = 20, PENX = 6, BASEY = 14;

const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
pix.clear(255);
const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
const text = new mupdf.Text();
text.showGlyph(mf, [EMX, 0, 0, -EMY, PENX + FX, BASEY + FY], mf.encodeCharacter(CP), CP, 0);
dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
dev.close();
const ref = Buffer.from(pix.getPixels());

const R = new GlyphRenderer(fontFile, W, H);
const got = R.render(CP, EMX, EMY, PENX + FX, BASEY + FY, 1);

const dump = (label, buf) => {
  console.log(label);
  for (let r = 0; r < H; r++) console.log('  ' + Array.from({ length: W }, (_, c) => String(buf[r * W + c]).padStart(4)).join(''));
};
dump(`--- fillText (cp ${CP} '${String.fromCodePoint(CP)}' em [${EMX},${EMY}] phase ${FX},${FY}):`, ref);
dump('--- fillPath:', got);
console.log('--- diff (text - path):');
for (let r = 0; r < H; r++) console.log('  ' + Array.from({ length: W }, (_, c) => {
  const d = ref[r * W + c] - got[r * W + c];
  return String(d === 0 ? '.' : d).padStart(4);
}).join(''));

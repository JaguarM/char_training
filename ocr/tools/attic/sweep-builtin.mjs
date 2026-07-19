// sweep-builtin.mjs — fillText sweep with mupdf's BUILT-IN base14 Courier
// (URW Nimbus Mono). Pens are snap-limited (x quarters, y integers), but any
// target whose true pen lands on a representable spot can go EXACT — one hit
// confirms the font identity without porting the CFF pipeline.
//
//   node tools/sweep-builtin.mjs --emx 12.359375 --emy0 780 --emy1 815 --draws 1,2
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const EMX = parseFloat(optS('emx', String(791 / 64)));
const EMY0 = parseInt(optS('emy0', '780'));    // em64 units
const EMY1 = parseInt(optS('emy1', '815'));
const DRAWS = optS('draws', '1,2').split(',').map(Number);
const FONTNAME = optS('font', 'Courier');

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
const font = new mupdf.Font(FONTNAME);

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}
function inkBbox(px, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (px[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
for (const t of targets) {
  t.pgm = readPgm(`${root}/targets/${t.id}.pgm`);
  t.bbox = inkBbox(t.pgm.px, t.pgm.w, t.pgm.h);
}
const byCp = new Map();
for (const t of targets) {
  if (!byCp.has(t.cp)) byCp.set(t.cp, []);
  byCp.get(t.cp).push(t);
}

const W = 40, H = 40, PENX = 10, BASEY = 28;
function render(cp, emy, fx, draws) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const gid = font.encodeCharacter(cp);
  for (let d = 0; d < draws; d++) {
    const text = new mupdf.Text();
    text.showGlyph(font, [EMX, 0, 0, -emy, PENX + fx, BASEY], gid, cp, 0);
    dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  }
  dev.close();
  const bytes = Buffer.from(pix.getPixels());
  pix.destroy();
  return bytes;
}
function exactAt(t, cand, cb) {
  if (!cb || !t.bbox) return false;
  if (cb.x1 - cb.x0 !== t.bbox.x1 - t.bbox.x0 || cb.y1 - cb.y0 !== t.bbox.y1 - t.bbox.y0) return false;
  const dx = cb.x0 - t.bbox.x0, dy = cb.y0 - t.bbox.y0;
  const { w, h, px } = t.pgm;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const rr = r + dy, cc = c + dx;
    const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
    if (v !== px[r * w + c]) return false;
  }
  for (let r = -1; r <= h; r++) for (const c of [-1, w]) {
    const rr = r + dy, cc = c + dx;
    if (rr >= 0 && rr < H && cc >= 0 && cc < W && cand[rr * W + cc] < 250) return false;
  }
  return true;
}
function sadAt(t, cand, cb) {
  if (!cb || !t.bbox) return Infinity;
  const dx = Math.round((cb.x0 + cb.x1 - t.bbox.x0 - t.bbox.x1) / 2);
  const dy = Math.round((cb.y0 + cb.y1 - t.bbox.y0 - t.bbox.y1) / 2);
  const { w, h, px } = t.pgm;
  let sad = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const rr = r + dy, cc = c + dx;
    const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
    sad += Math.abs(v - px[r * w + c]);
  }
  return sad;
}

for (let emy64 = EMY0; emy64 <= EMY1; emy64++) {
  const emy = emy64 / 64;
  let exact = [], tot = 0, n = 0;
  for (const [cp, list] of byCp) {
    const bestPer = new Map();
    for (const fx of [0, 0.25, 0.5, 0.75]) for (const draws of DRAWS) {
      const cand = render(cp, emy, fx, draws);
      const cb = inkBbox(cand, W, H);
      for (const t of list) {
        if (exactAt(t, cand, cb)) exact.push(`${t.id}'${t.ch}' fx${fx} d${draws}`);
        const s = sadAt(t, cand, cb);
        const b = bestPer.get(t.id);
        if (b === undefined || s < b) bestPer.set(t.id, s);
      }
    }
    for (const s of bestPer.values()) { tot += s; n++; }
  }
  console.log(`em64y ${emy64} (${emy.toFixed(4)}): EXACT ${exact.length}  meanBestSad ${(tot / n).toFixed(0)}${exact.length ? '   ' + exact.slice(0, 6).join(' ') : ''}`);
}

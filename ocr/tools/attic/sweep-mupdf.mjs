// sweep-mupdf.mjs — em × phase oracle sweep for the double-draw MuPDF law.
// MuPDF quantizes glyph positions to ¼ px in x and ½ px in y, so per em and
// draw-count each glyph has exactly 8 possible rasters. For each candidate em
// this renders all 8 per glyph, slides each target against its glyph's set,
// and reports exact hits + mean best sad. The right em must produce EXACT.
//
//   node tools/sweep-mupdf.mjs --draws 2 --em0 12.30 --em1 12.42 --step 0.01
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DRAWS = parseInt(optS('draws', '2'));
const EM0 = parseFloat(optS('em0', '12.30'));
const EM1 = parseFloat(optS('em1', '12.42'));
const EMY = parseFloat(optS('emy', '0'));
const STEP = parseFloat(optS('step', '0.01'));
const FONTF = optS('font', 'fonts/cour.ttf');

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const font = new mupdf.Font('F', readFileSync(`${root}/${FONTF}`));
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}
for (const t of targets) t.pgm = readPgm(`${root}/targets/${t.id}.pgm`);
const cps = [...new Set(targets.map(t => t.cp))];

const BOLDOFFS = optS('boldoffs', '0').split(',').map(Number);   // x-offset of 2nd draw (faux bold)
const W = 40, H = 40, PENX = 10, BASEY = 28;
function renderGlyph(cp, em, fx, fy, boldOff) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const gid = font.encodeCharacter(cp);
  for (let d = 0; d < DRAWS; d++) {
    const text = new mupdf.Text();
    const dx = d === 0 ? 0 : boldOff;
    text.showGlyph(font, [em, 0, 0, -(EMY || em), PENX + fx + dx, BASEY + fy], gid, cp, 0);
    dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  }
  dev.close();
  return Buffer.from(pix.getPixels());
}
function slideSad(tgt, cand) {
  let best = Infinity;
  for (let dy = -tgt.h + 1; dy < H; dy++) for (let dx = -tgt.w + 1; dx < W; dx++) {
    let sad = 0;
    for (let r = 0; r < tgt.h && sad < best; r++) for (let c = 0; c < tgt.w; c++) {
      const rr = r + dy, cc = c + dx;
      const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
      sad += Math.abs(v - tgt.px[r * tgt.w + c]);
    }
    if (sad < best) best = sad;
  }
  return best;
}

const phases = [];
for (const fx of [0, 0.25, 0.5, 0.75]) for (const fy of [0, 0.5]) phases.push([fx, fy]);

for (let em = EM0; em <= EM1 + 1e-9; em += STEP) {
  const sets = new Map();
  for (const cp of cps) {
    const list = [];
    for (const off of BOLDOFFS) for (const [fx, fy] of phases) list.push(renderGlyph(cp, em, fx, fy, off));
    sets.set(cp, list);
  }
  let exact = 0, total = 0;
  for (const t of targets) {
    let best = Infinity;
    for (const cand of sets.get(t.cp)) {
      const sad = slideSad(t.pgm, cand);
      if (sad < best) best = sad;
    }
    if (best === 0) exact++;
    total += best;
  }
  console.log(`em ${em.toFixed(4)}  EXACT ${exact}/${targets.length}  meanBestSad ${(total / targets.length).toFixed(0)}  (offs ${BOLDOFFS.join('/')})`);
}

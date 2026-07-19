// residual.mjs — render the mupdf double-draw candidate at a given config,
// oracle-pick the best of the 8 snap phases per target, and dump aligned
// target / candidate / signed-diff grids for the N closest targets.
//
//   node tools/residual.mjs --emx 12.36 --emy 12 --draws 2 --best 3
//   node tools/residual.mjs --emx 12.36 --emy 12 --draws 2 --id 101_p2_v2
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const EMX = parseFloat(optS('emx', '12.36'));
const EMY = parseFloat(optS('emy', '12'));
const DRAWS = parseInt(optS('draws', '2'));
const DX2 = parseFloat(optS('dx2', '0'));   // 2nd-draw x offset
const DY2 = parseFloat(optS('dy2', '0'));   // 2nd-draw y offset
const RSHIFT = args.includes('--rshift');
const BESTN = parseInt(optS('best', '3'));
const ONLY = optS('id', null);
const FONTF = optS('font', 'fonts/cour.ttf');

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const font = new mupdf.Font('F', readFileSync(`${root}/${FONTF}`));
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}

const W = 40, H = 40, PENX = 10, BASEY = 28;
function render(cp, fx, fy) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const gid = font.encodeCharacter(cp);
  for (let d = 0; d < DRAWS; d++) {
    const text = new mupdf.Text();
    text.showGlyph(font, [EMX, 0, 0, -EMY, PENX + fx + (d ? DX2 : 0), BASEY + fy + (d ? DY2 : 0)], gid, cp, 0);
    dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  }
  dev.close();
  const bytes = Buffer.from(pix.getPixels());
  pix.destroy();
  if (RSHIFT) for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 128 && bytes[i] <= 253) bytes[i]++;
  return bytes;
}

function slide(tgt, cand) {
  let best = { sad: Infinity, dx: 0, dy: 0 };
  for (let dy = -tgt.h + 1; dy < H; dy++) for (let dx = -tgt.w + 1; dx < W; dx++) {
    let sad = 0;
    for (let r = 0; r < tgt.h && sad < best.sad; r++) for (let c = 0; c < tgt.w; c++) {
      const rr = r + dy, cc = c + dx;
      const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
      sad += Math.abs(v - tgt.px[r * tgt.w + c]);
    }
    if (sad < best.sad) best = { sad, dx, dy };
  }
  return best;
}

const phases = [];
for (const fx of [0, 0.25, 0.5, 0.75]) for (const fy of [0, 0.5]) phases.push([fx, fy]);

const rows = [];
const cache = new Map();
for (const t of targets) {
  if (ONLY && t.id !== ONLY) continue;
  t.pgm = readPgm(`${root}/targets/${t.id}.pgm`);
  let bb = null;
  for (const [fx, fy] of phases) {
    const key = `${t.cp}_${fx}_${fy}`;
    let cand = cache.get(key);
    if (!cand) { cand = render(t.cp, fx, fy); cache.set(key, cand); }
    const b = slide(t.pgm, cand);
    if (!bb || b.sad < bb.sad) bb = { ...b, fx, fy, cand };
  }
  rows.push({ t, bb });
}
rows.sort((a, b) => a.bb.sad - b.bb.sad);

const show = ONLY ? rows : rows.slice(0, BESTN);
console.log(`config: em [${EMX}, ${EMY}] draws ${DRAWS} dx2 ${DX2} dy2 ${DY2}${RSHIFT ? ' rshift' : ''}  — mean best sad ${(rows.reduce((s, r) => s + r.bb.sad, 0) / rows.length).toFixed(0)} over ${rows.length}`);
for (const { t, bb } of show) {
  const { pgm } = t;
  console.log(`\n=== ${t.id} '${t.ch}'  sad ${bb.sad} avg ${(bb.sad / (pgm.w * pgm.h)).toFixed(1)}  phase (${bb.fx},${bb.fy})  frac ${JSON.stringify(t.frac)}`);
  const line = (label, fn) => {
    console.log(label);
    for (let r = 0; r < pgm.h; r++)
      console.log('  ' + Array.from({ length: pgm.w }, (_, c) => String(fn(r, c)).padStart(5)).join(''));
  };
  const cv = (r, c) => {
    const rr = r + bb.dy, cc = c + bb.dx;
    return rr >= 0 && rr < H && cc >= 0 && cc < W ? bb.cand[rr * W + cc] : 255;
  };
  line('--- target:', (r, c) => pgm.px[r * pgm.w + c]);
  line('--- candidate:', cv);
  line('--- diff (target - candidate):', (r, c) => {
    const d = pgm.px[r * pgm.w + c] - cv(r, c);
    return d === 0 ? '.' : d;
  });
}

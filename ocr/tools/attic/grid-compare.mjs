// grid-compare.mjs — compare each cell of a render grid (from render-gdip2 or
// similar: pitch 24, 16x16 cells anchored at 8+ix*24, 8+iy*24) against a page
// cut. Bbox-aligned full-window compare + SAD; also counts distinct rasters
// (position-quantization fingerprint).
//   node tools/attic/grid-compare.mjs --render x.pgm --rect 524,274,14,13
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const REN = optS('render', null);
const PAGE = optS('page', 'pages/EFTA00038617/page-0001.pgm');
const [RX, RY, RW, RH] = optS('rect', '524,274,14,13').split(',').map(Number);
const PITCH = 24, NX = 16, CELLS = 256;

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}
const ren = readPgm(REN);
const pg = readPgm(PAGE);
const tgt = new Uint8Array(RW * RH);
for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) tgt[r * RW + c] = pg.px[(RY + r) * pg.w + (RX + c)];

function inkBbox(px, w, x0, y0, x1, y1) {
  let bx0 = x1, by0 = y1, bx1 = -1, by1 = -1;
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++)
    if (px[r * w + c] < 255) { if (c < bx0) bx0 = c; if (c > bx1) bx1 = c; if (r < by0) by0 = r; if (r > by1) by1 = r; }
  return bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1, y1: by1 };
}
const tb = inkBbox(tgt, RW, 0, 0, RW, RH);

let best = null;
const exact = [];
const sigs = new Map();
for (let i = 0; i < CELLS; i++) {
  const ix = i % NX, iy = Math.floor(i / NX);
  const ax = 8 + ix * PITCH, ay = 8 + iy * PITCH;
  const cb = inkBbox(ren.px, ren.w, ax - 6, ay - 6, ax + PITCH + 2, ay + PITCH + 6);
  if (!cb) continue;
  // signature: bbox-normalized bytes
  const sw = cb.x1 - cb.x0 + 1, sh = cb.y1 - cb.y0 + 1;
  let sig = `${sw}x${sh}:`;
  for (let r = cb.y0; r <= cb.y1; r++) for (let c = cb.x0; c <= cb.x1; c++) sig += String.fromCharCode(ren.px[r * ren.w + c]);
  sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
  const dimsOk = sw === tb.x1 - tb.x0 + 1 && sh === tb.y1 - tb.y0 + 1;
  const dx = dimsOk ? cb.x0 - tb.x0 : Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2);
  const dy = dimsOk ? cb.y0 - tb.y0 : Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
  let sad = 0, same = dimsOk;
  for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
    const v = ren.px[(r + dy) * ren.w + (c + dx)];
    const t = tgt[r * RW + c];
    if (v !== t) same = false;
    sad += Math.abs(v - t);
  }
  if (same) exact.push(i);
  if (!best || sad < best.sad) best = { i, sad, fx: (i % 64) / 64, fy: Math.floor(i / 64) / 4 };
}
console.log('distinct rasters:', sigs.size, 'of', CELLS, 'cells');
console.log('exact cells:', exact.length ? exact.join(',') : 'NONE');
console.log('best:', JSON.stringify(best));

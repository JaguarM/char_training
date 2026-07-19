// sweep-compare.mjs — compare each draw of a pdf-sweep render against a page
// cut: bbox-aligned full-window byte compare + SAD. No post law: the render
// IS the candidate producer byte space.
//   node tools/attic/sweep-compare.mjs --render <pgm> --page <pgm> --rect x,y,w,h
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const REN = optS('render', null);
const PAGE = optS('page', 'pages/EFTA00038617/page-0001.pgm');
const [RX, RY, RW, RH] = optS('rect', '524,274,14,13').split(',').map(Number);
const STEPS = +optS('steps', '128'), PERCOL = 64;

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}
const ren = readPgm(REN);
const pg = readPgm(PAGE);
const tgt = new Uint8Array(RW * RH);
for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) tgt[r * RW + c] = pg.px[(RY + r) * pg.w + (RX + c)];

function inkBbox(px, w, h, x0, y0, x1, y1) {
  let bx0 = x1, by0 = y1, bx1 = -1, by1 = -1;
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++)
    if (px[r * w + c] < 255) { if (c < bx0) bx0 = c; if (c > bx1) bx1 = c; if (r < by0) by0 = r; if (r > by1) by1 = r; }
  return bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1, y1: by1 };
}
const tb = inkBbox(tgt, RW, RH, 0, 0, RW, RH);

let best = null;
const exact = [];
for (let i = 0; i < STEPS; i++) {
  const col = Math.floor(i / PERCOL), row = i % PERCOL;
  const xpx = Math.floor(100 + col * 300), ypx = 20 + row * 16;
  const cb = inkBbox(ren.px, ren.w, ren.h, xpx - 4, ypx - 14, xpx + 22, ypx + 6);
  if (!cb) continue;
  if (cb.x1 - cb.x0 !== tb.x1 - tb.x0 || cb.y1 - cb.y0 !== tb.y1 - tb.y0) {
    // still track SAD via center alignment
    const dx = Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2), dy = Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
    let sad = 0;
    for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++)
      sad += Math.abs(ren.px[(r + dy) * ren.w + (c + dx)] - tgt[r * RW + c]);
    if (!best || sad < best.sad) best = { i, sad, note: 'dims!' };
    continue;
  }
  const dx = cb.x0 - tb.x0, dy = cb.y0 - tb.y0;
  let sad = 0, same = true;
  for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
    const v = ren.px[(r + dy) * ren.w + (c + dx)];
    const t = tgt[r * RW + c];
    if (v !== t) same = false;
    sad += Math.abs(v - t);
  }
  if (same) exact.push(i);
  if (!best || sad < best.sad) best = { i, sad };
}
console.log('exact draw indices (phase = i/128 px):', exact.length ? exact.join(',') : 'NONE');
console.log('best:', JSON.stringify(best));

// mupdf-direct.mjs — render a glyph with REAL mupdf fillText (the snap-phase
// pipeline) and compare to a page cut under the post laws. Bypasses ftclone
// entirely: tests whether the producer is stock mupdf + law with this font.
//   node tools/attic/mupdf-direct.mjs --font fonts/cand/calibri-jondot.ttf \
//     --cp 119 --rect 524,274,14,13 --em 16
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', 'fonts/cand/calibri-jondot.ttf');
const CP = +optS('cp', '119');
const PAGE = optS('page', 'pages/EFTA00038617/page-0001.pgm');
const [RX, RY, RW, RH] = optS('rect', '524,274,14,13').split(',').map(Number);
const EM = +optS('em', '16');

const b = readFileSync(PAGE);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
const pw = +m[1], px = b.subarray(m[0].length);
const tgt = new Uint8Array(RW * RH);
for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) tgt[r * RW + c] = px[(RY + r) * pw + (RX + c)];

function inkBbox(p, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (p[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
const tb = inkBbox(tgt, RW, RH);

const LAWS = {
  none: v => v,
  linA: v => v >= 128 && v <= 253 ? v + 1 : v,
  linB: v => v >= 128 && v <= 254 ? v + 1 : v,
};

const W = 30, H = 34, PENX = 8, BASEY = 24;
const mf = new mupdf.Font('F', readFileSync(FONT));
const gid = mf.encodeCharacter(CP);

let best = null;
const exact = [];
// fillText can reach x phases 0,16,32,48 (subpixel_adjust) and y phases 0,32
// via round-to-int/half — sweep pen in 1/64 steps anyway; mupdf will snap.
for (let fy = 0; fy < 64; fy += 8) for (let fx = 0; fx < 64; fx += 4) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const text = new mupdf.Text();
  text.showGlyph(mf, [EM, 0, 0, -EM, PENX + fx / 64, BASEY + fy / 64], gid, CP, 0);
  dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  dev.close();
  const cand = Buffer.from(pix.getPixels());
  pix.destroy();
  const cb = inkBbox(cand, W, H);
  if (!cb) continue;
  const dimsOk = cb.x1 - cb.x0 === tb.x1 - tb.x0 && cb.y1 - cb.y0 === tb.y1 - tb.y0;
  const dx = dimsOk ? cb.x0 - tb.x0 : Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2);
  const dy = dimsOk ? cb.y0 - tb.y0 : Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
  for (const [law, f] of Object.entries(LAWS)) {
    let sad = 0, same = dimsOk;
    for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
      const rr = r + dy, cc = c + dx;
      const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
      const lv = f(v);
      const t = tgt[r * RW + c];
      if (lv !== t) same = false;
      sad += Math.abs(lv - t);
    }
    if (same) exact.push({ fx, fy, law });
    if (law === 'linB' && (!best || sad < best.sad)) best = { fx, fy, sad };
  }
}
console.log('exact hits:', exact.length ? JSON.stringify(exact) : 'NONE');
console.log('best SAD(linB):', JSON.stringify(best));

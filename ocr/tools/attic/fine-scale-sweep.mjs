// fine-scale-sweep.mjs — calibri hunt: sweep FRACTIONAL em64 (1/32 steps =
// full 16.16 scale granularity at upm 2048) x pen fx, testing byte-exactness
// under the linB post law (+1 for 128..254). Finds the producer's true scale
// if it sits between ftclone's integer em64 lattice points.
//
//   node tools/attic/fine-scale-sweep.mjs --rect 524,274,14,13 --cp 119 \
//     --font fonts/cand/calibri-jondot.ttf --center 1024 --span 2 --fy 0
import { readFileSync } from 'node:fs';
import { FTClone } from '../ftclone.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PAGE = optS('page', 'pages/EFTA00038617/page-0001.pgm');
const [RX, RY, RW, RH] = optS('rect', '524,274,14,13').split(',').map(Number);
const CP = +optS('cp', '119');
const FONT = optS('font', 'fonts/cand/calibri-jondot.ttf');
const CENTER = +optS('center', '1024');
const SPAN = +optS('span', '2');          // em64 units each way
const FYS = optS('fy', '0').split(',').map(Number);
const YSPAN = +optS('yspan', '0');        // also sweep em64y +/- this

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
const linB = v => v >= 128 && v <= 254 ? v + 1 : v;

const W = 30, H = 32, PENX = 8, BASEY = 22;
const clone = new FTClone(FONT, W, H);

let best = null;
const exact = [];
for (let sy = -YSPAN * 32; sy <= YSPAN * 32; sy++) {
  const emy = CENTER + sy / 32;
  for (let s = -SPAN * 32; s <= SPAN * 32; s++) {
    const emx = CENTER + s / 32;
    for (const fy of FYS) for (let fx = 0; fx < 64; fx++) {
      const cand = clone.render(CP, emx, emy, PENX * 64 + fx, BASEY * 64 + fy, 1);
      const cb = inkBbox(cand, W, H);
      if (!cb) continue;
      const dx = Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2);
      const dy = Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
      let sad = 0, same = true;
      for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
        const rr = r + dy, cc = c + dx;
        const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
        const t = tgt[r * RW + c];
        const lv = linB(v);
        if (lv !== t) same = false;
        sad += Math.abs(lv - t);
      }
      if (same) exact.push({ emx, emy, fx, fy });
      if (!best || sad < best.sad) best = { emx, emy, fx, fy, sad };
    }
  }
}
console.log(`cp=${CP} target ${tb.x1 - tb.x0 + 1}x${tb.y1 - tb.y0 + 1}`);
console.log('exact(linB):', exact.length ? JSON.stringify(exact.slice(0, 12)) + (exact.length > 12 ? ` +${exact.length - 12} more` : '') : 'NONE');
console.log(`best SAD(linB) ${best.sad} at emx=${best.emx} emy=${best.emy} fx=${best.fx} fy=${best.fy}`);

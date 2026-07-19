// lattice-lut-probe.mjs — step-3 compass for the calibri hunt: sweep the FULL
// 1/64-px pen lattice of ftclone (certified unhinted pipeline) against a
// hand-cut page glyph. Reports exact hits, best-SAD config, and at the best
// alignment the clone->page byte scatter with a monotone-LUT consistency
// check (page = LUT(clone) iff scatter is a function with monotone fit).
//
//   node tools/attic/lattice-lut-probe.mjs --page pages/EFTA00038617/page-0001.pgm \
//     --rect 513,271,6,16 --cp 108 --font C:/Windows/Fonts/calibri.ttf --ems 1024
import { readFileSync } from 'node:fs';
import { FTClone } from '../ftclone.mjs';
import { FTCloneOld } from './rastold.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PAGE = optS('page', 'pages/EFTA00038617/page-0001.pgm');
const [RX, RY, RW, RH] = optS('rect', '513,271,6,16').split(',').map(Number);
const CP = +optS('cp', '108');
const FONT = optS('font', 'C:/Windows/Fonts/calibri.ttf');
const EMS = optS('ems', '1024').split(',').map(Number);
const EMX = optS('emx', null)?.split(',').map(Number);
const EMY = optS('emy', null)?.split(',').map(Number);
const DUMP = args.includes('--dump');

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
console.log(`target cp=${CP} rect=${RX},${RY},${RW},${RH} ink=${tb.x1 - tb.x0 + 1}x${tb.y1 - tb.y0 + 1}`);

const W = 26, H = 32, PENX = 8, BASEY = 22;
// --raster line=old|prod,conic=bisect|dda,sign=neg|not,div=recip|exact  (or --old = all-2.4.12)
const RAST = optS('raster', null);
const clone = RAST
  ? new FTCloneOld(FONT, W, H, Object.fromEntries(RAST.split(',').map(kv => kv.split('='))))
  : args.includes('--old') ? new FTCloneOld(FONT, W, H) : new FTClone(FONT, W, H);

// candidate bytes now come from covLaw(coverage) directly; law slot is identity
const LAWS = { mid: v => v };
// coverage law (2026-07-19, fitted on the l anchors): byte moves 1 away from
// the midpoint of t = 255-cov, clamped. Applied to COVERAGE, not blend byte.
const covLaw = cov => {
  const t = 255 - cov;
  return Math.max(0, Math.min(255, t + (t >> 7) - ((255 - t) >> 7)));
};

let best = null;
const exact = [];
const emPairs = [];
if (EMX && EMY) { for (const ex of EMX) for (const ey of EMY) emPairs.push([ex, ey]); }
else for (const em of EMS) emPairs.push([em, em]);
for (const [emx, emy] of emPairs) {
  const em = `${emx}x${emy}`;
  for (let fy = 0; fy < 64; fy++) for (let fx = 0; fx < 64; fx++) {
    const cov = clone.coverage(CP, emx, emy, PENX * 64 + fx, BASEY * 64 + fy);
    if (!cov) continue;
    // 'mid' pipeline: page byte straight from coverage via covLaw
    const cand = new Uint8Array(W * H);
    for (let i = 0; i < cand.length; i++) cand[i] = covLaw(cov[i]);
    const cb = inkBbox(cand, W, H);
    if (!cb) continue;
    // bbox-align exact (dims must match), full window, under each law
    if (cb.x1 - cb.x0 === tb.x1 - tb.x0 && cb.y1 - cb.y0 === tb.y1 - tb.y0) {
      const dx = cb.x0 - tb.x0, dy = cb.y0 - tb.y0;
      for (const [law, f] of Object.entries(LAWS)) {
        let same = true;
        for (let r = 0; r < RH && same; r++) for (let c = 0; c < RW; c++) {
          const rr = r + dy, cc = c + dx;
          const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
          if (f(v) !== tgt[r * RW + c]) { same = false; break; }
        }
        if (same) exact.push({ em, fx, fy, law });
      }
    }
    // SAD under linA for ranking
    const dx = Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2);
    const dy = Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
    let sad = 0;
    for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
      const rr = r + dy, cc = c + dx;
      const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
      sad += Math.abs(LAWS.mid(v) - tgt[r * RW + c]);
    }
    if (!best || sad < best.sad) best = { em, fx, fy, sad, dx, dy, cand: cand.slice() };
  }
}
console.log('exact hits:', exact.length ? JSON.stringify(exact) : 'NONE');
console.log(`best SAD(linA) ${best.sad} at em64=${best.em} fx=${best.fx} fy=${best.fy} (avg |d| ${(best.sad / (RW * RH)).toFixed(1)}/px)`);

// scatter at best alignment
const buckets = new Map(); // cloneByte -> [min,max,count] of page bytes
const pts = [];
for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
  const rr = r + best.dy, cc = c + best.dx;
  const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? best.cand[rr * W + cc] : 255;
  const t = tgt[r * RW + c];
  if (v === 255 && t === 255) continue;
  pts.push([v, t]);
  const bk = buckets.get(v) ?? [255, 0, 0];
  bk[0] = Math.min(bk[0], t); bk[1] = Math.max(bk[1], t); bk[2]++;
  buckets.set(v, bk);
}
console.log('scatter (cloneByte -> page min..max xN), sorted:');
const sk = [...buckets.keys()].sort((a, b2) => a - b2);
for (const v of sk) {
  const [mn, mx, n] = buckets.get(v);
  console.log(`  ${String(v).padStart(3)} -> ${String(mn).padStart(3)}..${String(mx).padStart(3)} x${n}${mx - mn > 24 ? '  SPREAD' : ''}`);
}
// monotone violation estimate: adjacent clone values whose page ranges invert
let inv = 0;
for (let i = 1; i < sk.length; i++) {
  const a = buckets.get(sk[i - 1]), b2 = buckets.get(sk[i]);
  if (b2[1] < a[0] - 8) inv++;
}
console.log('monotone inversions (rough):', inv, ' scatter points:', pts.length);

if (DUMP) {
  console.log('side-by-side at best (page | clone+linA | diff):');
  for (let r = 0; r < RH; r++) {
    let a = '', b2 = '', d = '';
    for (let c = 0; c < RW; c++) {
      const rr = r + best.dy, cc = c + best.dx;
      const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? best.cand[rr * W + cc] : 255;
      const t = tgt[r * RW + c];
      a += String(t).padStart(4); b2 += String(LAWS.mid(v)).padStart(4);
      const df = t - LAWS.mid(v);
      d += df === 0 ? '   .' : String(df).padStart(4);
    }
    console.log(a + '  |' + b2 + '  |' + d);
  }
}

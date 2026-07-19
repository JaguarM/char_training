// rowsample.mjs — hypothesis rasterizer for the calibri hunt: FT-identical
// outline transform + conic DDA flattening, but coverage computed by N
// y-sample rows per pixel (sample at (k+phi)/N), exact continuous x spans
// per row, nonzero winding, cov = floor(mean_overlap * 256) clamp 255.
// Verticals reproduce ftgrays exactly (floor(f*256)); slanted edges pick up
// per-row sampling error — the observed ±1 signature class.
//
//   node tools/attic/rowsample.mjs --cp 119 --rect 524,274,14,13 --fx 16 --N 16 --phi 0.5
//   node tools/attic/rowsample.mjs --fit    # sweep N/phi over all four anchors
import { readFileSync } from 'node:fs';
import { loadFont } from '../ttf.mjs';
import { mulfix } from '../ftclone.mjs';

const ONE = 256;                       // 26.8
const UP = x => x << 2;
const TR = x => x >> 8;

class Recorder {
  constructor() { this.segs = []; this.x = 0; this.y = 0; }
  moveTo(x, y) { this.x = x; this.y = y; }
  lineTo(x, y) {
    if (y !== this.y || x !== this.x) this.segs.push([this.x, this.y, x, y]);
    this.x = x; this.y = y;
  }
  // gray_render_conic DDA (2.13) — identical flattening to ftclone
  conicTo(cx6, cy6, tx6, ty6) {
    const p0x = this.x, p0y = this.y;
    const p1x = UP(cx6), p1y = UP(cy6);
    const p2x = UP(tx6), p2y = UP(ty6);
    const bx = p1x - p0x, by = p1y - p0y;
    const ax = p2x - p1x - bx, ay = p2y - p1y - by;
    let dx = Math.abs(ax), dyv = Math.abs(ay);
    if (dx < dyv) dx = dyv;
    if (dx <= ONE / 4) { this.lineTo(p2x, p2y); return; }
    let shift = 16;
    do { dx >>= 2; shift--; } while (dx > ONE / 4);
    let count = 0x10000 >>> shift;
    const P32 = 4294967296;
    let rx = ax * 2 ** (shift + shift), ry = ay * 2 ** (shift + shift);
    let qx = bx * 2 ** (shift + 17) + rx, qy = by * 2 ** (shift + 17) + ry;
    rx *= 2; ry *= 2;
    let px = p0x * P32, py = p0y * P32;
    do {
      px += qx; py += qy;
      qx += rx; qy += ry;
      this.lineTo(Math.floor(px / P32), Math.floor(py / P32));
    } while (--count);
  }
}

export function segments(font, cp, em64x, em64y, px64, py64) {
  const R = new Recorder();
  const o = font.rawOutline(cp);
  if (!o) return null;
  const half = (a, b) => Math.trunc((a + b) / 2);
  for (const raw of o.contours) {
    if (raw.length < 2) continue;
    const pts = raw.map(p => ({
      x: mulfix(p.x, Math.round(em64x * 32)) + px64,
      y: mulfix(p.y, -Math.round(em64y * 32)) + py64,
      on: p.on,
    }));
    let limit = pts.length - 1;
    let vStart = pts[0], vLast = pts[limit];
    let i = 0;
    if (!pts[0].on) {
      if (pts[limit].on) { vStart = vLast; limit--; }
      else {
        vStart = { x: half(vStart.x, vLast.x), y: half(vStart.y, vLast.y), on: true };
        vLast = vStart;
      }
      i--;
    }
    R.moveTo(UP(vStart.x), UP(vStart.y));
    let closedByConic = false;
    while (i < limit) {
      i++;
      if (pts[i].on) { R.lineTo(UP(pts[i].x), UP(pts[i].y)); continue; }
      let vControl = pts[i];
      let done = false;
      while (i < limit) {
        i++;
        const vec = pts[i];
        if (vec.on) { R.conicTo(vControl.x, vControl.y, vec.x, vec.y); done = true; break; }
        const vMiddle = { x: half(vControl.x, vec.x), y: half(vControl.y, vec.y) };
        R.conicTo(vControl.x, vControl.y, vMiddle.x, vMiddle.y);
        vControl = vec;
      }
      if (!done) { R.conicTo(vControl.x, vControl.y, vStart.x, vStart.y); closedByConic = true; break; }
    }
    if (!closedByConic) R.lineTo(UP(vStart.x), UP(vStart.y));
  }
  return R.segs;
}

// N-row sampled coverage over a W x H window (26.8 segment coords)
export function sampleCoverage(segs, W, H, N, phi, xround) {
  const cov = new Uint8Array(W * H);
  const acc = new Float64Array(W);     // per-column overlap accumulator (px units)
  for (let row = 0; row < H; row++) {
    acc.fill(0);
    let any = false;
    for (let k = 0; k < N; k++) {
      const ys = row * ONE + (k + phi) * (ONE / N);   // 26.8
      // collect crossings
      const xs = [];
      for (const [x0, y0, x1, y1] of segs) {
        if (y0 === y1) continue;
        const dir = y1 > y0 ? 1 : -1;
        const ylo = dir > 0 ? y0 : y1, yhi = dir > 0 ? y1 : y0;
        if (ys < ylo || ys >= yhi) continue;          // half-open [ylo, yhi)
        let x = x0 + (x1 - x0) * (ys - y0) / (y1 - y0);
        if (xround) x = Math.round(x / xround) * xround;
        xs.push([x, dir]);
      }
      if (!xs.length) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0, spanStart = 0;
      for (const [x, dir] of xs) {
        if (wind === 0) spanStart = x;
        wind += dir;
        if (wind === 0) {
          // span [spanStart, x) in 26.8 -> accumulate per column
          let a = spanStart / ONE, b = x / ONE;
          if (b > a) {
            any = true;
            const c0 = Math.max(0, Math.floor(a)), c1 = Math.min(W - 1, Math.ceil(b) - 1);
            for (let c = c0; c <= c1; c++) {
              const lo = Math.max(a, c), hi = Math.min(b, c + 1);
              if (hi > lo) acc[c] += hi - lo;
            }
          }
        }
      }
    }
    if (!any) continue;
    for (let c = 0; c < W; c++) {
      if (acc[c] <= 0) continue;
      let v = Math.floor(acc[c] * 256 / N + 1e-9);
      if (v > 255) v = 255;
      cov[row * W + c] = v;
    }
  }
  return cov;
}

const covLaw = cov => {
  const t = 255 - cov;
  return Math.max(0, Math.min(255, t + (t >> 7) - ((255 - t) >> 7)));
};

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('rowsample.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const PAGE = optS('page', 'pages/EFTA00038617/page-0001.pgm');
  const FONT = loadFont(optS('font', 'fonts/cand/calibri-jondot.ttf'));
  const b = readFileSync(PAGE);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
  const pw = +m[1], px = b.subarray(m[0].length);

  const W = 26, H = 32, PENX = 8, BASEY = 22;
  const anchors = [
    { name: 'l', cp: 108, rect: [513, 271, 5, 16] },
    { name: 'a', cp: 97, rect: [517, 274, 8, 13] },
    { name: 'x', cp: 120, rect: [162, 296, 8, 10] },
    { name: 'w', cp: 119, rect: [524, 274, 14, 13] },
  ];
  function inkBbox(p, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
      if (p[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }
  // score one anchor at given raster config: best over the ¼-px fx lattice
  function score(a, N, phi, xround) {
    const [RX, RY, RW, RH] = a.rect;
    const tgt = new Uint8Array(RW * RH);
    for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) tgt[r * RW + c] = px[(RY + r) * pw + (RX + c)];
    const tb = inkBbox(tgt, RW, RH);
    let best = Infinity;
    for (const fx of [0, 16, 32, 48]) {
      const segs = segments(FONT, a.cp, 1024, 1024, PENX * 64 + fx, BASEY * 64);
      const cov = sampleCoverage(segs, W, H, N, phi, 0);
      const cand = new Uint8Array(W * H);
      for (let i = 0; i < cand.length; i++) cand[i] = covLaw(cov[i]);
      const cb = inkBbox(cand, W, H);
      if (!cb) continue;
      const dx = Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2);
      const dy = Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
      let sad = 0;
      for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
        const rr = r + dy, cc = c + dx;
        const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
        sad += Math.abs(v - tgt[r * RW + c]);
      }
      if (sad < best) best = sad;
    }
    return best;
  }
  console.log('config      l   a   x   w   total');
  for (const N of [4, 8, 15, 16, 17, 32, 64]) {
    for (const phi of [0.5, 0]) {
      const s = anchors.map(a => score(a, N, phi, 0));
      console.log(`N=${String(N).padEnd(2)} phi=${phi}  ${s.map(v => String(v).padStart(3)).join(' ')}  ${s.reduce((x, y) => x + y, 0)}`);
    }
  }
}

// render-stretch.mjs — CANDIDATE RENDERER: coarse source raster (srcglyphs/)
// upscaled by a stretch factor with a resample kernel, sub-pixel phase
// fitted per target (oracle-phase: the producer is deterministic, so once
// the kernel+scale is right the best-fit phases will reveal their own law).
//
//   node tools/render-stretch.mjs --src srcglyphs/ggo10 --sx 1.23633 --sy 1.23633 \
//        --kernel bilinear --out st-ggo10-bl
//   kernels: bilinear | box | bicubic (Catmull-Rom a=-0.5) | nearest
//   --steps N   phase grid steps per axis (default 16)
//   --report    also print per-target best (sad, phase) lines
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SRC = optS('src', 'srcglyphs/ggo10');
const SX = parseFloat(optS('sx', '1.23633'));
const SY = parseFloat(optS('sy', optS('sx', '1.23633')));
const KERNEL = optS('kernel', 'bilinear');
const STEPS = parseInt(optS('steps', '16'));
const OUT = optS('out', 'stretch');
const REPORT = args.includes('--report');

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
const outDir = `${root}/candidates/${OUT}`;
mkdirSync(outDir, { recursive: true });

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}

// source ink as coverage 0..1 on an infinite white plane
function srcCov(src, x, y) {
  if (x < 0 || x >= src.w || y < 0 || y >= src.h) return 0;
  return (255 - src.px[y * src.w + x]) / 255;
}

const kernels = {
  nearest: { support: 0.5, f: t => (Math.abs(t) <= 0.5 ? 1 : 0) },
  bilinear: { support: 1, f: t => Math.max(0, 1 - Math.abs(t)) },
  box: { support: 0.5, f: t => (Math.abs(t) < 0.5 ? 1 : Math.abs(t) === 0.5 ? 0.5 : 0) },
  bicubic: {
    support: 2,
    f: t => {
      const a = -0.5, x = Math.abs(t);
      if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
      if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
      return 0;
    },
  },
};
const K = kernels[KERNEL];
if (!K) { console.error(`kernel ${KERNEL}?`); process.exit(1); }

// resample: dst pixel (X,Y) center maps to source coords ((X+0.5-ox)/SX-0.5, ...)
// ox,oy = phase offsets in DST px. Separable kernel evaluated in SOURCE space
// (magnification: kernel not widened).
function render(src, W, H, ox, oy) {
  const dst = new Float64Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const sy = (Y + 0.5 - oy) / SY - 0.5;
    const y0 = Math.ceil(sy - K.support), y1 = Math.floor(sy + K.support);
    for (let X = 0; X < W; X++) {
      const sx = (X + 0.5 - ox) / SX - 0.5;
      const x0 = Math.ceil(sx - K.support), x1 = Math.floor(sx + K.support);
      let acc = 0, wsum = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const wy = K.f(sy - yy);
        if (!wy) continue;
        for (let xx = x0; xx <= x1; xx++) {
          const wx = K.f(sx - xx);
          if (!wx) continue;
          acc += wy * wx * srcCov(src, xx, yy);
          wsum += wy * wx;
        }
      }
      dst[Y * W + X] = wsum > 0 ? acc / wsum : 0;
    }
  }
  return dst;
}

function slideSad(tgt, cand, W, H) {
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

const srcCache = new Map();
let n = 0, exact = 0, totalBest = 0;
const lines = [];
for (const t of targets) {
  const sp = `${root}/${SRC}/${t.cp}.pgm`;
  if (!existsSync(sp)) continue;
  let src = srcCache.get(t.cp);
  if (!src) { src = readPgm(sp); srcCache.set(t.cp, src); }
  const W = Math.ceil(src.w * SX) + 4, H = Math.ceil(src.h * SY) + 4;
  let best = { sad: Infinity, ox: 0, oy: 0, gray: null };
  for (let i = 0; i < STEPS; i++) for (let j = 0; j < STEPS; j++) {
    const ox = i / STEPS, oy = j / STEPS;
    const cov = render(src, W, H, ox, oy);
    const gray = Buffer.alloc(W * H);
    for (let k = 0; k < W * H; k++) gray[k] = Math.max(0, Math.min(255, Math.round(255 * (1 - cov[k]))));
    const sad = slideSad(t.pgm ?? (t.pgm = readPgm(`${root}/targets/${t.id}.pgm`)), gray, W, H);
    if (sad < best.sad) best = { sad, ox, oy, gray };
  }
  writeFileSync(`${outDir}/${t.id}.pgm`, Buffer.concat([Buffer.from(`P5\n${Math.ceil(src.w * SX) + 4} ${Math.ceil(src.h * SY) + 4}\n255\n`), best.gray]));
  n++;
  totalBest += best.sad;
  if (best.sad === 0) exact++;
  if (REPORT) lines.push(`${t.id} '${t.ch}' sad ${best.sad} phase (${best.ox.toFixed(3)},${best.oy.toFixed(3)})`);
}
if (REPORT) console.log(lines.join('\n'));
console.log(`wrote ${n} -> candidates/${OUT}  (src ${SRC} sx ${SX} sy ${SY} kernel ${KERNEL} steps ${STEPS})`);
console.log(`oracle-phase: ${exact} exact, mean best sad ${(totalBest / n).toFixed(0)}  — confirm with tools/check.mjs`);

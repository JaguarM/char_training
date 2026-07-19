// graylaw.mjs — fit the producer's coverage→byte law for NON-BLACK text runs.
// The mid law (FINDINGS-calibri.md) is the c=0 case; gray runs (e.g. the P2
// "On July 29" paragraph, min byte ~22) need byte = f(cov, c). This tool
// locates glyphs of a known text snippet with ftclone rasters under a
// PARAMETRIC blend hypothesis, then prints the (cov, pageByte) scatter so the
// exact rounding/quirk can be read off.
//
//   node tools/graylaw.mjs --page pages/EFTA00038617/page-0002.pgm \
//        --region 110,850,110,22 --c 22 [--em64 1024] [--font ...]
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', `${root}/fonts/cand/calibri-jondot.ttf`);
const EM64 = +optS('em64', '1024');
const C = +optS('c', '22');
const PAGE = optS('page', `${root}/pages/EFTA00038617/page-0002.pgm`);
const REGIONS = optS('region', '110,850,110,22').split(';').map(s => s.split(',').map(Number));
const CHARS = optS('chars', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,()’');

const b = readFileSync(PAGE);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
const pw = +m[1], ph = +m[2], px = b.subarray(m[0].length);

// hypothesis: srcover of color C with alpha=cov onto white
const law = cov => 255 - Math.round(cov * (255 - C) / 255);

const SIZE_PX = EM64 / 64;
const PENX = Math.ceil(SIZE_PX) + 3, BASEY = Math.ceil(SIZE_PX * 1.6) + 3;
const W = PENX + Math.ceil(SIZE_PX * 2.4), H = BASEY + Math.ceil(SIZE_PX * 0.9);
const clone = new FTClone(FONT, W, H);

const cands = [];
for (const ch of CHARS) {
  const cp = ch.codePointAt(0);
  for (const fx of [0, 16, 32, 48]) {
    const cov = clone.coverage(cp, EM64, EM64, PENX * 64 + fx, BASEY * 64);
    if (!cov) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < cov.length; i++) if (cov[i]) {
      const c = i % W, r = (i / W) | 0;
      if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r;
    }
    if (x1 < 0) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const cut = new Uint8Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) cut[r * w + c] = cov[(y0 + r) * W + x0 + c];
    cands.push({ ch, cp, fx, w, h, cov: cut });
  }
  clone.cache.clear();
}

// slide every candidate over the region; accept per-pixel |Δ|<=6 under law
const scatter = new Map();  // cov -> Map(byte -> count)
const hits = [];
for (const cd of cands) {
  for (const [RX, RY, RW, RH] of REGIONS) {
  for (let Y = RY; Y + cd.h <= RY + RH; Y++) {
    for (let X = RX; X + cd.w <= RX + RW; X++) {
      let ok = true, sad = 0, nInk = 0;
      for (let r = 0; r < cd.h && ok; r++)
        for (let c = 0; c < cd.w; c++) {
          const cov = cd.cov[r * cd.w + c];
          if (!cov) continue;
          nInk++;
          const d = Math.abs(px[(Y + r) * pw + X + c] - law(cov));
          if (d > 6) { ok = false; break; }
          sad += d;
        }
      if (!ok || nInk < 8) continue;
      // white margins left/right of the ink bbox
      for (let r = 0; r < cd.h && ok; r++)
        if (px[(Y + r) * pw + X - 1] < 200 || px[(Y + r) * pw + X + cd.w] < 200) ok = false;
      if (!ok) continue;
      hits.push({ ch: cd.ch, fx: cd.fx, X, Y, sad, nInk, cd });
    }
  }
  }
}
hits.sort((a, b) => a.sad / a.nInk - b.sad / b.nInk);
// NMS by position
const kept = [];
for (const h2 of hits) {
  if (kept.some(k => Math.abs(k.X - h2.X) < 3 && Math.abs(k.Y - h2.Y) < 3)) continue;
  kept.push(h2);
}
console.log(`${kept.length} glyph placements accepted (of ${hits.length} raw)`);
for (const k of kept.slice(0, 40))
  console.log(`  '${k.ch}' fx${k.fx} @${k.X},${k.Y} sad ${k.sad} ink ${k.nInk}`);
for (const k of kept) {
  const { cd } = k;
  for (let r = 0; r < cd.h; r++)
    for (let c = 0; c < cd.w; c++) {
      const cov = cd.cov[r * cd.w + c];
      if (!cov) continue;
      const byte = px[(k.Y + r) * pw + k.X + c];
      if (!scatter.has(cov)) scatter.set(cov, new Map());
      const mm = scatter.get(cov);
      mm.set(byte, (mm.get(byte) || 0) + 1);
    }
}
console.log('cov -> pageByte histogram vs law prediction:');
const covs = [...scatter.keys()].sort((a, b) => a - b);
for (const cov of covs) {
  const mm = [...scatter.get(cov).entries()].sort((a, b) => b[1] - a[1]);
  const pred = law(cov);
  const s = mm.map(([byt, n]) => `${byt}${byt !== pred ? `(${byt > pred ? '+' : ''}${byt - pred})` : ''}x${n}`).join(' ');
  console.log(`  cov ${String(cov).padStart(3)} pred ${String(pred).padStart(3)}: ${s}`);
}

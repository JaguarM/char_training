// dump-covmap.mjs — characterize the producer against ftclone coverage:
// 1) consensus cov->pageByte map over the four anchor glyphs at their best
//    ¼-lattice phases; 2) per-glyph Δcov grids (coverage error the producer's
//    rasterizer would need vs ftgrays), using the consensus map inverse.
import { readFileSync } from 'node:fs';
import { FTClone } from '../ftclone.mjs';

const FONT = 'fonts/cand/calibri-jondot.ttf';
const PAGE = 'pages/EFTA00038617/page-0001.pgm';
const GLYPHS = [
  { name: 'l', cp: 108, rect: [513, 271, 5, 16], fx: 0, fy: 0 },
  { name: 'a', cp: 97, rect: [517, 274, 8, 13], fx: 32, fy: 0 },
  { name: 'x', cp: 120, rect: [162, 296, 8, 10], fx: 16, fy: 0 },
  { name: 'w', cp: 119, rect: [524, 274, 14, 13], fx: 16, fy: 0 },
];

const b = readFileSync(PAGE);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
const pw = +m[1], px = b.subarray(m[0].length);

const W = 30, H = 34, PENX = 8, BASEY = 24;
const clone = new FTClone(FONT, W, H);

function inkBbox(p, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (p[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// pass 1: collect (cov, pageByte) counts
const map = Array.from({ length: 256 }, () => new Map());
const per = [];
for (const g of GLYPHS) {
  const [RX, RY, RW, RH] = g.rect;
  const tgt = new Uint8Array(RW * RH);
  for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) tgt[r * RW + c] = px[(RY + r) * pw + (RX + c)];
  const tb = inkBbox(tgt, RW, RH);
  const cov = clone.coverage(g.cp, 1024, 1024, PENX * 64 + g.fx, BASEY * 64 + g.fy);
  const ren = clone.render(g.cp, 1024, 1024, PENX * 64 + g.fx, BASEY * 64 + g.fy, 1);
  const cb = inkBbox(ren, W, H);
  const dx = cb.x0 - tb.x0, dy = cb.y0 - tb.y0;
  per.push({ g, tgt, RW, RH, dx, dy, cov });
  for (let r = 0; r < RH; r++) for (let c = 0; c < RW; c++) {
    const rr = r + dy, cc = c + dx;
    const cv = rr >= 0 && rr < H && cc >= 0 && cc < W ? cov[rr * W + cc] : 0;
    const t = tgt[r * RW + c];
    if (cv === 0 && t === 255) continue;
    const mm = map[cv];
    mm.set(t, (mm.get(t) ?? 0) + 1);
  }
}
console.log('cov -> page byte (count), consensus rows with data:');
const consensus = new Int16Array(256).fill(-1);
const bytesToCov = new Map(); // pageByte -> covs that produce it (consensus)
for (let cv = 0; cv < 256; cv++) {
  if (!map[cv].size) continue;
  const ent = [...map[cv].entries()].sort((a, b2) => b2[1] - a[1]);
  consensus[cv] = ent[0][0];
  console.log(`  cov ${String(cv).padStart(3)} -> ${ent.map(([v, n]) => `${v}x${n}`).join(' ')}`);
}
// invert consensus (nearest cov for each byte)
for (let cv = 0; cv < 256; cv++) if (consensus[cv] >= 0) {
  const by = consensus[cv];
  if (!bytesToCov.has(by)) bytesToCov.set(by, []);
  bytesToCov.get(by).push(cv);
}
// pass 2: Δcov grids — needed cov (from inverse consensus, nearest) minus ftclone cov
for (const { g, tgt, RW, RH, dx, dy, cov } of per) {
  console.log(`--- Δcov grid '${g.name}' (page needs minus ftclone; . = 0, ? = byte unseen)`);
  for (let r = 0; r < RH; r++) {
    let line = '';
    for (let c = 0; c < RW; c++) {
      const rr = r + dy, cc = c + dx;
      const cv = rr >= 0 && rr < H && cc >= 0 && cc < W ? cov[rr * W + cc] : 0;
      const t = tgt[r * RW + c];
      if (cv === 0 && t === 255) { line += '   .'; continue; }
      // needed cov: candidates mapping to byte t; pick nearest to cv
      let need = null;
      if (bytesToCov.has(t)) {
        for (const c2 of bytesToCov.get(t)) if (need === null || Math.abs(c2 - cv) < Math.abs(need - cv)) need = c2;
      }
      if (need === null) { line += '   ?'; continue; }
      const d = need - cv;
      line += d === 0 ? '   .' : String(d).padStart(4);
    }
    console.log(line);
  }
}

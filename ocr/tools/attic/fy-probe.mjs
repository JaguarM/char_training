// fy-probe.mjs — is a line sitting on a fractional y-phase baseline?
// Sweeps the full 64×64 pen lattice for one glyph against a page cut under
// the mid law and prints the best (fx, fy) SADs.
//   node tools/attic/fy-probe.mjs --page pages/DOC/page-0001.pgm \
//        --ch A --at 72,155 [--em64 1024] [--font fonts/cand/calibri-jondot.ttf]
import { readFileSync } from 'node:fs';
import { FTClone } from '../ftclone.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', `${root}/fonts/cand/calibri-jondot.ttf`);
const EM64 = +optS('em64', '1024');
const CH = optS('ch', 'A');
const [AX, AY] = optS('at', '72,155').split(',').map(Number); // page x,y of glyph ink top-left
const PAGE = optS('page', `${root}/pages/EFTA00038617/page-0001.pgm`);
const C = +optS('c', '0'); // ink color: 0 = black midlaw, >0 = gray blend

const b = readFileSync(PAGE);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
const pw = +m[1], px = b.subarray(m[0].length);

const midlaw = C === 0
  ? cov => {
      const t = 255 - cov;
      return Math.max(0, Math.min(255, t + (t >> 7) - ((255 - t) >> 7)));
    }
  : cov => 255 - Math.round(cov * (255 - C) / 255);
const SIZE_PX = EM64 / 64;
const PENX = Math.ceil(SIZE_PX) + 3, BASEY = Math.ceil(SIZE_PX * 1.6) + 3;
const W = PENX + Math.ceil(SIZE_PX * 2.4), H = BASEY + Math.ceil(SIZE_PX * 0.9);
const clone = new FTClone(FONT, W, H);
const cp = CH.codePointAt(0);

const best = [];
for (let fy = 0; fy < 64; fy++) {
  for (let fx = 0; fx < 64; fx++) {
    const cov = clone.coverage(cp, EM64, EM64, PENX * 64 + fx, BASEY * 64 + fy);
    if (!cov) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < cov.length; i++) if (cov[i]) {
      const c = i % W, r = (i / W) | 0;
      if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r;
    }
    if (x1 < 0) continue;
    for (let oy = -3; oy <= 3; oy++)
      for (let ox = -3; ox <= 3; ox++) {
        let sad = 0, n = 0;
        for (let r = y0; r <= y1; r++)
          for (let c = x0; c <= x1; c++) {
            const pv = px[(AY + oy + r - y0) * pw + AX + ox + c - x0];
            sad += Math.abs(pv - midlaw(cov[r * W + c]));
            n++;
          }
        best.push({ fx, fy, ox, oy, sad, n });
      }
  }
  clone.cache.clear();
}
best.sort((a, b2) => a.sad - b2.sad);
for (const r of best.slice(0, 12))
  console.log(`fx ${String(r.fx).padStart(2)} fy ${String(r.fy).padStart(2)} off ${r.ox},${r.oy}  SAD ${r.sad} over ${r.n}px`);

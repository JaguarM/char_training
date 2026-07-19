// render-font.mjs — CANDIDATE RENDERER: unhinted TTF outlines + exact-area
// analytic AA + linear byte law (measured from targets: byte = 255-255*cov),
// ¼-px pen phases from targets/index.json.
//
//   node tools/render-font.mjs --font fonts/times.ttf --size 15 --out f15
//   knobs: --ex E --ey E (embolden px/side)  --xoff X --yoff Y (pen frac)
//          --gamma G  --q65  --scalex S (horizontal-only extra scale)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadFont } from './ttf.mjs';
import { flatten, embolden, rasterize, covToPgm } from './rastlib.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const opt = (n, d) => parseFloat(optS(n, d));
const fontPath = optS('font', 'fonts/cour.ttf');
const SIZE = opt('size', 12.3613), EX = opt('ex', 0), EY = opt('ey', 0);
const XOFF = opt('xoff', 0), YOFF = opt('yoff', 0), GAMMA = opt('gamma', 1), SCALEX = opt('scalex', 1);
const Q65 = args.includes('--q65');
const outName = optS('out', `f${SIZE}`);

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const font = loadFont(`${root}/${fontPath}`);
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
const outDir = `${root}/candidates/${outName}`;
mkdirSync(outDir, { recursive: true });

const W = 48, H = 48, PENX = 16, PENY = 36;
const scale = SIZE / font.unitsPerEm;
const cache = new Map();
let n = 0, missing = 0;
for (const t of targets) {
  const key = `${t.cp}_${t.phx}`;
  let gray = cache.get(key);
  if (!gray) {
    const g = font.outline(t.cp);
    if (!g || !g.contours.length) { missing++; continue; }
    const scaled = g.contours.map(({ start, segs }) => ({
      start: [start[0] * scale * SCALEX, start[1] * scale],
      segs: segs.map(s => ({
        ...(s.ctrl ? { ctrl: [s.ctrl[0] * scale * SCALEX, s.ctrl[1] * scale] } : {}),
        ...(s.c1 ? { c1: [s.c1[0] * scale * SCALEX, s.c1[1] * scale], c2: [s.c2[0] * scale * SCALEX, s.c2[1] * scale] } : {}),
        to: [s.to[0] * scale * SCALEX, s.to[1] * scale],
      })),
    }));
    let polys = flatten(scaled);
    polys = embolden(polys, EX, EY);
    const cov = rasterize(polys, W, H, PENX + t.phx + XOFF, PENY + YOFF);
    gray = covToPgm(cov, W, H, { gamma: GAMMA, q65: Q65 });
    cache.set(key, gray);
  }
  writeFileSync(`${outDir}/${t.id}.pgm`, gray);
  n++;
}
console.log(`wrote ${n} -> candidates/${outName}  (font ${fontPath} size ${SIZE} ex ${EX} ey ${EY} xoff ${XOFF} yoff ${YOFF} gamma ${GAMMA} scalex ${SCALEX}${Q65 ? ' q65' : ''}; missing ${missing})`);

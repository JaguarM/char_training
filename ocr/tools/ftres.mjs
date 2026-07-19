// ftres.mjs — aligned target/candidate/diff dump for an ftclone config.
//   node tools/ftres.mjs --id 46_p1_v2 --em 791x768 --draws 1 --fx 46 --fy 59
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const ID = optS('id', '46_p1_v2');
const [EM64X, EM64Y] = optS('em', '791x768').split('x').map(Number);
const DRAWS = parseInt(optS('draws', '1'));
const FX = parseInt(optS('fx', '0'));
const FY = parseInt(optS('fy', '0'));

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
const t = targets.find(x => x.id === ID);
if (!t) { console.error('no target ' + ID); process.exit(1); }
const b = readFileSync(`${root}/targets/${ID}.pgm`);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
const tw = +m[1], th = +m[2], tpx = b.subarray(m[0].length);

const W = 40, H = 40, PENX = 10, BASEY = 28;
const FONT = optS('font', 'fonts/NimbusMonoPS-Regular.cff');
const clone = new FTClone(`${root}/${FONT}`, W, H);
if (FONT.endsWith('.cff')) {
  const mupdf = await import('mupdf');
  const bfont = new mupdf.Font(optS('builtin', 'Courier'));
  clone.setGidMap(new Map([[t.cp, bfont.encodeCharacter(t.cp)]]));
}
const cand = clone.render(t.cp, EM64X, EM64Y, PENX * 64 + FX, BASEY * 64 + FY, DRAWS);

function bbox(px, w, h, blank = 255) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (px[r * w + c] < blank) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return { x0, y0, x1, y1 };
}
const tb = bbox(tpx, tw, th), cb = bbox(cand, W, H);
const dx = Math.round((cb.x0 + cb.x1 - tb.x0 - tb.x1) / 2), dy = Math.round((cb.y0 + cb.y1 - tb.y0 - tb.y1) / 2);
console.log(`${ID} '${t.ch}' em64 (${EM64X},${EM64Y}) draws ${DRAWS} pen (+${FX}/64,+${FY}/64)  tgt ${tw}x${th} bbox ${tb.x1 - tb.x0 + 1}x${tb.y1 - tb.y0 + 1} cand bbox ${cb.x1 - cb.x0 + 1}x${cb.y1 - cb.y0 + 1}`);
const cv = (r, c) => { const rr = r + dy, cc = c + dx; return rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255; };
for (const [label, fn] of [['target', (r, c) => tpx[r * tw + c]], ['cand', cv],
  ['diff t-c', (r, c) => { const d = tpx[r * tw + c] - cv(r, c); return d === 0 ? '.' : d; }]]) {
  console.log(`--- ${label}:`);
  for (let r = 0; r < th; r++) console.log('  ' + Array.from({ length: tw }, (_, c) => String(fn(r, c)).padStart(4)).join(''));
}

// probe-dd.mjs — test synthesized-bold (double-draw with x-offset δ) for the
// EFTA00039208 red footer: two srcover draws of the same glyph, red ink
// (204,0,0), then gray-average + page palette. Target: footer 'F' page 2.
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const [pdf, palObj] = ['../NEW/EFTA00039208.pdf', '42'];
function readPGM(p) {
  const b = readFileSync(p);
  let i = 0, tok = [], s = '';
  while (tok.length < 4) {
    const c = b[i++];
    if (c === 35) { while (b[i++] !== 10); }
    else if (c <= 32) { if (s) { tok.push(s); s = ''; } }
    else s += String.fromCharCode(c);
  }
  return { w: +tok[1], h: +tok[2], d: b.subarray(i) };
}
const pg = readPGM('pages/EFTA00039208/page-0002.pgm');
const X0 = 210, X1 = 220, Y0 = 980, Y1 = 993;
const TW = X1 - X0 + 1, TH = Y1 - Y0 + 1;
const target = new Uint8Array(TW * TH);
for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++)
  target[y * TW + x] = pg.d[(Y0 + y) * pg.w + (X0 + x)];

// palette entries
const b = readFileSync(pdf);
const s = b.toString('latin1');
const m = new RegExp(palObj + ' 0 obj[^]*?stream\\r?\\n').exec(s);
const st = m.index + m[0].length, en = s.indexOf('endstream', st);
const pal = b.subarray(st, en);
const entries = [];
for (let k = 0; k + 2 < pal.length; k += 3) entries.push([pal[k], pal[k + 1], pal[k + 2]]);
function qGray(r, g, bl) {
  let best = null, bd = Infinity;
  for (const e of entries) {
    const d = (e[0] - r) ** 2 + (e[1] - g) ** 2 + (e[2] - bl) ** 2;
    if (d < bd || (d === bd && e[0] + e[1] + e[2] < best[0] + best[1] + best[2])) { bd = d; best = e; }
  }
  return Math.round((best[0] + best[1] + best[2]) / 3);
}

const mupdf = await import('mupdf');
const results = [];
for (const fontPath of ['fonts/NimbusSans-Regular.cff', 'fonts/NimbusSans-Bold.cff']) {
  const W = 28, H = 24;
  const ft = new FTClone(fontPath, W, H);
  const mf = new mupdf.Font('F', readFileSync(fontPath));
  ft.setGidMap(new Map([[70, mf.encodeCharacter(70)]]));
  for (let em = 680; em <= 725; em++) {
    for (const dd of [0, 8, 16, 24, 32, 40, 48]) {
      for (let fy = 0; fy < 64; fy += 4) for (let fx = 0; fx < 64; fx += 2) {
        const c1 = ft.coverage(70, em, em, 8 * 64 + fx, 16 * 64 + fy);
        if (!c1) continue;
        const c2 = dd ? ft.coverage(70, em, em, 8 * 64 + fx + dd, 16 * 64 + fy) : null;
        // srcover red (204,0,0): sequential draws
        const buf = [];
        let x0 = W, x1 = -1, y0 = H, y1 = -1;
        for (let i = 0; i < W * H; i++) {
          const a1 = c1[i] / 255, a2 = c2 ? c2[i] / 255 : 0;
          const a = 1 - (1 - a1) * (1 - a2);
          if (a > 0) {
            const x = i % W, y = (i / W) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
          buf.push(a);
        }
        if (x1 < 0) continue;
        const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
        if (gw > TW || gh > TH) continue;
        let best = null;
        for (let oy = 0; oy + gh <= TH; oy++) for (let ox = 0; ox + gw <= TW; ox++) {
          let bad = 0, maxd = 0, sad = 0;
          for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
            const a = buf[(y0 + y) * W + x0 + x];
            const r = Math.round(255 - a * (255 - 204)), g = Math.round(255 - a * 255);
            const pred = qGray(r, g, g);
            const t = target[(oy + y) * TW + ox + x];
            const d = Math.abs(pred - t);
            sad += d; if (d > maxd) maxd = d; if (d > 0) bad++;
          }
          if (!best || bad < best.bad || (bad === best.bad && sad < best.sad))
            best = { bad, sad, maxd, ox, oy };
        }
        if (best) results.push({ font: fontPath.split('/').pop(), em, dd, fx, fy, ...best, n: gw * gh });
      }
    }
    ft.cache.clear();
  }
}
results.sort((a, b) => a.bad - b.bad || a.sad - b.sad);
for (const r of results.slice(0, 10))
  console.log(`${r.font} em64=${r.em} dd=${r.dd}/64 pen=(${r.fx},${r.fy}) bad=${r.bad}/${r.n} maxd=${r.maxd} sad=${r.sad}`);

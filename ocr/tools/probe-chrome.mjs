// probe-chrome.mjs — render glyphs via headless Chrome canvas (Skia/DirectWrite
// path on Windows) and byte-compare against a window cut from an ingested page.
// The ftclone (unhinted FreeType) fails on EFTA00039208 body text; this tests
// the hinted-rasterizer hypothesis.
//
//   node tools/probe-chrome.mjs --page 2 --x 138..148 --y 141..153 --text d
import { readFileSync } from 'node:fs';
import puppeteer from '../../tools/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { findChrome } from '../../tools/paths.mjs';

const o = { page: 2, x0: 138, x1: 148, y0: 141, y1: 153, text: 'd',
  font: 'Times New Roman', sizes: ['16px', '12pt', '15.9px', '16.1px'] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--page') o.page = +next();
  else if (a === '--x') [o.x0, o.x1] = next().split('..').map(Number);
  else if (a === '--y') [o.y0, o.y1] = next().split('..').map(Number);
  else if (a === '--text') o.text = next();
  else if (a === '--font') o.font = next();
  else if (a === '--sizes') o.sizes = next().split(',');
}

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
const pg = readPGM(`pages/EFTA00039208/page-${String(o.page).padStart(4, '0')}.pgm`);
const TW = o.x1 - o.x0 + 1, TH = o.y1 - o.y0 + 1;
const target = [];
for (let y = 0; y < TH; y++) {
  const row = [];
  for (let x = 0; x < TW; x++) row.push(pg.d[(o.y0 + y) * pg.w + (o.x0 + x)]);
  target.push(row);
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true,
  args: ['--no-sandbox', '--disable-lcd-text', '--force-device-scale-factor=1'] });
const page = await browser.newPage();

const renders = await page.evaluate(({ text, font, sizes }) => {
  const out = [];
  const W = 48, H = 40;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const size of sizes) {
    for (let fy = 0; fy < 4; fy++) for (let fx = 0; fx < 8; fx++) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#000';
      ctx.font = `${size} "${font}"`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, 8 + fx / 8, 24 + fy / 4);
      const d = ctx.getImageData(0, 0, W, H).data;
      const g = [];
      for (let y = 0; y < H; y++) {
        const row = [];
        for (let x = 0; x < W; x++) {
          const o2 = (y * W + x) * 4;
          row.push(Math.round((d[o2] + d[o2 + 1] + d[o2 + 2]) / 3));
        }
        g.push(row);
      }
      out.push({ size, fx: fx / 8, fy: fy / 4, g });
    }
  }
  return out;
}, { text: o.text, font: o.font, sizes: o.sizes });
await browser.close();

// score each render against the target with free alignment (interior compare)
function score(g) {
  // ink bbox of render
  let x0 = 99, x1 = -1, y0 = 99, y1 = -1;
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++)
    if (g[y][x] < 250) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;
  const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
  if (gw > TW || gh > TH) return { bad: 1e9, sad: 1e9, gw, gh };
  let best = null;
  for (let oy = 0; oy + gh <= TH; oy++) for (let ox = 0; ox + gw <= TW; ox++) {
    let bad = 0, sad = 0, maxd = 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const d = Math.abs(g[y0 + y][x0 + x] - target[oy + y][ox + x]);
      sad += d; if (d > maxd) maxd = d; if (d > 1) bad++;
    }
    if (!best || bad < best.bad || (bad === best.bad && sad < best.sad))
      best = { bad, sad, maxd, ox, oy };
  }
  return { ...best, gw, gh, x0, y0 };
}

const scored = renders.map(r => ({ ...r, s: score(r.g) })).filter(r => r.s);
scored.sort((a, b) => a.s.bad - b.s.bad || a.s.sad - b.s.sad);
console.log('top 8:');
for (const r of scored.slice(0, 8))
  console.log(`  ${r.size} pen(+${r.fx},+${r.fy}) bad=${r.s.bad}/${r.s.gw * r.s.gh} maxd=${r.s.maxd} sad=${r.s.sad}`);

const b = scored[0];
if (b && b.s.bad < 1e9) {
  console.log(`\nbest: ${b.size} pen(+${b.fx},+${b.fy}) — render | target`);
  for (let y = 0; y < b.s.gh; y++) {
    const c1 = [], c2 = [];
    for (let x = 0; x < b.s.gw; x++) {
      c1.push(String(b.g[b.s.y0 + y][b.s.x0 + x]).padStart(3));
      c2.push(String(target[b.s.oy + y][b.s.ox + x]).padStart(3));
    }
    console.log('  ' + c1.join(' ') + '   |   ' + c2.join(' '));
  }
}

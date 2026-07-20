// probe-times.mjs — EFTA00039208 body-face hunt: fit a single glyph window
// cut from a page against ftclone renders over (font file, em64, pen phase).
// Scoring is a compass only (maxdiff/count>tol); the finish line is EXACT
// bytes (tol 0) or exact-under-proven-page-law.
//
//   node tools/probe-times.mjs --page 2 --x 138..148 --y 141..153 --cp 100 \
//        --ems 1000..1040 [--tol 1]
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const o = { page: 2, cp: 100, x0: 138, x1: 148, y0: 141, y1: 153,
  ems: [1000, 1040], tol: 1, fonts: [
    'C:/Windows/Fonts/times.ttf',
    '../assets/fonts/TimesNewRomanXP.ttf',
  ], top: 12, ystep: 1, xstep: 1 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--page') o.page = +next();
  else if (a === '--doc') o.doc = next();
  else if (a === '--cp') o.cp = +next();
  else if (a === '--x') [o.x0, o.x1] = next().split('..').map(Number);
  else if (a === '--y') [o.y0, o.y1] = next().split('..').map(Number);
  else if (a === '--ems') o.ems = next().split('..').map(Number);
  else if (a === '--tol') o.tol = +next();
  else if (a === '--font') o.fonts = [next()];
  else if (a === '--ystep') o.ystep = +next();
  else if (a === '--xstep') o.xstep = +next();
  else if (a === '--law') o.law = next();
  else if (a === '--ink') {                    // gray ink C[:law] — law: round (srcover, default) | floor | fz (FZ_BLEND: 255−((255−C)·e)>>8, e=cov+(cov>>7))
    const [c, lm] = next().split(':');
    o.ink = +c; o.inkLaw = lm ?? 'round';
  }
  else if (a === '--nolin') o.nolin = true;    // skip the +1 linear step inside the palette LUT
  else { console.error('unknown arg', a); process.exit(2); }
}

// --law palette:<pdf>:<objnum> — post-process candidate bytes with the proven
// family law: linear (+1 on [128,253]) then the page palette's RGB-nearest
// quantization (ties darker), then the ingest gray average. With the law on,
// the finish line is EXACT (run with --tol 0).
let LAW = null;
if (o.law) {
  {
    const [kind, pdf, obj] = o.law.split(':');
    if (kind !== 'palette') { console.error('unknown law', kind); process.exit(2); }
    const b = readFileSync(pdf);
    const s = b.toString('latin1');
    // indexOf, not a lazy regex — .*? over multi-MB latin1 strings hangs
    let at = -1, from = 0;
    while ((at = s.indexOf(obj + ' 0 obj', from)) >= 0) {
      if (at === 0 || /\s/.test(s[at - 1])) break;   // reject e.g. "1491 0 obj"
      from = at + 1;
    }
    if (at < 0) { console.error('palette obj not found'); process.exit(2); }
    let start = s.indexOf('stream', at) + 'stream'.length;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    const pal = b.subarray(start, end);
    const entries = [];
    for (let k = 0; k + 2 < pal.length; k += 3) entries.push([pal[k], pal[k + 1], pal[k + 2]]);
    LAW = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const lv = !o.nolin && v >= 128 && v <= 254 ? v + 1 : v;
      let best = null, bd = Infinity;
      for (const e of entries) {
        const d = (e[0] - lv) ** 2 + (e[1] - lv) ** 2 + (e[2] - lv) ** 2;
        if (d < bd || (d === bd && e[0] + e[1] + e[2] < best[0] + best[1] + best[2])) { bd = d; best = e; }
      }
      LAW[v] = Math.round((best[0] + best[1] + best[2]) / 3);
    }
  }
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

const pg = readPGM(`pages/${o.doc ?? 'EFTA00039208'}/page-${String(o.page).padStart(4, '0')}.pgm`);
const TW = o.x1 - o.x0 + 1, TH = o.y1 - o.y0 + 1;
const target = new Uint8Array(TW * TH);
for (let y = 0; y < TH; y++)
  for (let x = 0; x < TW; x++)
    target[y * TW + x] = pg.d[(o.y0 + y) * pg.w + (o.x0 + x)];

console.log(`target ${TW}x${TH} @ page ${o.page} (${o.x0},${o.y0}):`);
for (let y = 0; y < TH; y++)
  console.log('  ' + Array.from(target.subarray(y * TW, y * TW + TW))
    .map(v => String(v).padStart(3)).join(' '));

// Render candidate into a padded buffer, blend over white, then find the best
// integer alignment of the render against the target window.
const W = TW + 16, H = TH + 16;
const blend = cov => {
  let b;
  if (o.ink >= 0) {
    const a = 255 - o.ink;
    b = o.inkLaw === 'fz' ? 255 - ((a * (cov + (cov >> 7))) >> 8)
      : o.inkLaw === 'floor' ? 255 - ((cov * a / 255) | 0)
      : o.inkLaw === 'cov' ? (() => {                        // alpha scales COVERAGE, then black FZ_BLEND
          const c2 = Math.round(cov * a / 255), e = c2 + (c2 >> 7);
          return (255 * (256 - e)) >> 8;
        })()
      : 255 - Math.round(cov * a / 255);                     // srcover gray ink
  } else b = (255 * (256 - (cov + (cov >> 7)))) >> 8;        // FZ_BLEND over white
  return LAW ? LAW[b] : b;
};

async function gidMapFor(fontPath, cps) {
  const mupdf = await import('mupdf');
  const f = new mupdf.Font('F', readFileSync(fontPath));
  return new Map(cps.map(cp => [cp, f.encodeCharacter(cp)]));
}

const results = [];
for (const fp of o.fonts) {
  const ft = new FTClone(fp, W, H);
  if (ft.cff) ft.setGidMap(await gidMapFor(fp, [o.cp]));
  for (let em64 = o.ems[0]; em64 <= o.ems[1]; em64++) {
    for (let fy = 0; fy < 64; fy += o.ystep) {
      for (let fx = 0; fx < 64; fx += o.xstep) {
        // pen at (8, TH+4) inside the buffer, plus the sub-pixel phase
        const cov = ft.coverage(o.cp, em64, em64, 8 * 64 + fx, (TH + 4) * 64 + fy);
        if (!cov) continue;
        // candidate ink bbox
        let cx0 = W, cx1 = -1, cy0 = H, cy1 = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
          if (cov[y * W + x]) {
            if (x < cx0) cx0 = x; if (x > cx1) cx1 = x;
            if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
          }
        if (cx1 < 0) continue;
        const gw = cx1 - cx0 + 1, gh = cy1 - cy0 + 1;
        if (gw > TW || gh > TH) continue;
        // slide over all placements inside the target window
        let best = null;
        for (let oy = 0; oy + gh <= TH; oy++) for (let ox = 0; ox + gw <= TW; ox++) {
          let bad = 0, maxd = 0, sad = 0;
          for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
            const c = blend(cov[(cy0 + y) * W + cx0 + x]);
            const t = target[(oy + y) * TW + ox + x];
            const d = Math.abs(c - t);
            sad += d;
            if (d > maxd) maxd = d;
            if (d > o.tol) bad++;
          }
          if (!best || bad < best.bad || (bad === best.bad && sad < best.sad))
            best = { bad, maxd, sad, ox, oy };
        }
        if (best) results.push({ font: fp.split('/').pop(), em64, fx, fy, ...best, gw, gh });
      }
    }
  }
}
results.sort((a, b) => a.bad - b.bad || a.sad - b.sad);
console.log(`\ntop ${o.top} of ${results.length} (bad = px with |diff|>${o.tol}):`);
for (const r of results.slice(0, o.top))
  console.log(`  ${r.font} em64=${r.em64} pen=(${r.fx}/64,${r.fy}/64) ` +
    `bad=${r.bad}/${r.gw * r.gh} maxd=${r.maxd} sad=${r.sad} at (${r.ox},${r.oy})`);

// dump the best candidate aligned against the target (candidate | target)
if (results.length) {
  const r = results[0];
  const fp = o.fonts.find(f => f.split('/').pop() === r.font);
  const ft = new FTClone(fp, W, H);
  if (ft.cff) ft.setGidMap(await gidMapFor(fp, [o.cp]));
  const cov = ft.coverage(o.cp, r.em64, r.em64, 8 * 64 + r.fx, (TH + 4) * 64 + r.fy);
  let cx0 = W, cx1 = -1, cy0 = H, cy1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (cov[y * W + x]) {
      if (x < cx0) cx0 = x; if (x > cx1) cx1 = x;
      if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
    }
  const gw = cx1 - cx0 + 1, gh = cy1 - cy0 + 1;
  console.log(`\nbest candidate (left) vs target (right), ink bbox ${gw}x${gh}:`);
  for (let y = 0; y < gh; y++) {
    const c = [], t = [];
    for (let x = 0; x < gw; x++) {
      c.push(String(blend(cov[(cy0 + y) * W + cx0 + x])).padStart(3));
      t.push(String(target[(r.oy + y) * TW + r.ox + x]).padStart(3));
    }
    console.log('  ' + c.join(' ') + '   |   ' + t.join(' '));
  }
}

// measure-anchor.mjs — Step 1 of ground-truthing the layout model: the LEFT ANCHOR.
//
// For every row of the document, take the row's first transcription char, compute
// its exact unhinted left-bearing (curve-extrema min-x from the TTF outline, the
// same math synth-templates.mjs uses), find the row's first inked column in the
// raster, and solve
//
//     impliedStartX = firstInkCol_leftEdge − ext.min
//
// The drawn ink's left edge is the outline onset floored to a pixel (AA covers the
// fraction), so impliedStartX lands in [startX − 1, startX] plus the pen's ¼-px
// quantization — a single true anchor shows up as a tight ~1px-wide cluster, and
// any row block laid out from a DIFFERENT margin (or a different generator) falls
// visibly outside it.
//
//   node measure-anchor.mjs --pdf ../v3.pdf --source ../v3.txt
//
// Reports the implied-anchor distribution per page and flags outlier rows.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { findPdf } from './paths.mjs';
import { parseTTF } from './ttf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const ROW_BASE = 40, ROW_PITCH = 18, ROW_H = 15, ROW_COUNT = 54;

const opts = { pdf: findPdf(REPO), source: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') opts.pdf = resolve(process.cwd(), next());
  else if (a === '--source') opts.source = resolve(process.cwd(), next());
}
if (!opts.source) opts.source = opts.pdf.replace(/\.pdf$/i, '.txt');

// --- source pages (same parsing as synth-templates.mjs, incl. trailing-\n fix) ---
const srcRaw = readFileSync(opts.source, 'utf8').replace(/\r/g, '');
const srcLines = (srcRaw.endsWith('\n') ? srcRaw.slice(0, -1) : srcRaw).split('\n');
let sep = 1;
for (let i = ROW_COUNT; i < srcLines.length - 1; i += ROW_COUNT + 1)
  if (srcLines[i] !== '') { sep = 0; break; }
const srcPages = [];
for (let i = 0; i + 1 <= srcLines.length; i += ROW_COUNT + sep) {
  const pg = srcLines.slice(i, i + ROW_COUNT);
  if (!pg.length) break;
  while (pg.length < ROW_COUNT) pg.push('');
  srcPages.push(pg);
  if (i + ROW_COUNT >= srcLines.length) break;
}

// --- raster cache dir for this PDF ---
const sha = createHash('sha256').update(readFileSync(opts.pdf)).digest('hex').slice(0, 16);
const cacheDir = join(REPO, 'bench', 'raster-cache', sha);
if (!existsSync(cacheDir)) { console.error(`no raster cache at ${cacheDir} — run dump-ocr.mjs --all once`); process.exit(1); }

function loadCachedPage(pno) {
  const p = join(cacheDir, `page-${String(pno).padStart(4, '0')}.gray.gz`);
  if (!existsSync(p)) return null;
  const raw = gunzipSync(readFileSync(p));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  const mode = hdr[1], w = hdr[2], h = hdr[3], n = w * h;
  if (mode === 0) return null;
  const sums = new Uint16Array(n);
  if (mode === 1) for (let i = 0; i < n; i++) sums[i] = raw[16 + i] * 3;
  else sums.set(new Uint16Array(raw.buffer, raw.byteOffset + 16, n));
  return { w, h, sums };
}

// --- exact unhinted ink extents (min-x) per char, from the TTF outlines ---
const font = parseTTF(readFileSync('C:/Windows/Fonts/times.ttf'));
const extMin = new Map();
function leftBearing(c) {
  if (extMin.has(c)) return extMin.get(c);
  let mn = Infinity, x = 0, sx = 0;
  const add = v => { if (v < mn) mn = v; };
  for (const cm of font.pathCommands(c, 16)) {
    if (cm[0] === 'M') { x = cm[1]; sx = x; add(x); }
    else if (cm[0] === 'L') { x = cm[1]; add(x); }
    else if (cm[0] === 'Q') {
      const x0 = x, cx = cm[1], x1 = cm[3];
      add(x1);
      const den = x0 - 2 * cx + x1;
      if (den !== 0) {
        const t = (x0 - cx) / den;
        if (t > 0 && t < 1) add((1 - t) ** 2 * x0 + 2 * t * (1 - t) * cx + t * t * x1);
      }
      x = x1;
    } else x = sx;
  }
  const v = mn === Infinity ? null : mn;
  extMin.set(c, v);
  return v;
}

// --- measure ---
const INK = 741; // gray < 247, on R+G+B sums
const all = [];
for (let pno = 1; pno <= srcPages.length; pno++) {
  const img = loadCachedPage(pno);
  if (!img) continue;
  const { w: W, h: H, sums } = img;
  for (let r = 0; r < ROW_COUNT; r++) {
    const text = srcPages[pno - 1][r];
    if (!text) continue;
    const first = text.trimStart()[0];
    if (!first || text.startsWith(' ')) continue; // indented rows can't pin the margin
    const lb = leftBearing(first);
    if (lb === null) continue;
    const top = ROW_BASE + ROW_PITCH * r;
    if (top + ROW_H > H) continue;
    let ink = -1;
    for (let x = 0; x < Math.min(W, 400) && ink < 0; x++)
      for (let rr = 0; rr < ROW_H; rr++)
        if (sums[(top + rr) * W + x] < INK) { ink = x; break; }
    if (ink < 0) continue;
    all.push({ pno, r, first, implied: ink - lb });
  }
}

// --- report ---
const hist = new Map();
for (const s of all) {
  const b = Math.round(s.implied * 4) / 4; // ¼-px bins
  hist.set(b, (hist.get(b) || 0) + 1);
}
console.log(`rows measured: ${all.length}`);
console.log('implied startX histogram (¼-px bins):');
for (const [b, n] of [...hist.entries()].sort((a, c) => a[0] - c[0]))
  console.log(`  ${b.toFixed(2).padStart(8)}  ${String(n).padStart(5)}  ${'#'.repeat(Math.min(60, Math.round(n / all.length * 240)))}`);

// outliers: more than 1.5px from the modal bin
const modal = [...hist.entries()].sort((a, c) => c[1] - a[1])[0][0];
const out = all.filter(s => Math.abs(s.implied - modal) > 1.5);
console.log(`\nmodal anchor ≈ ${modal}; outlier rows (>1.5px away): ${out.length}`);
for (const s of out.slice(0, 40))
  console.log(`  P${s.pno} L${s.r} first='${s.first}' implied=${s.implied.toFixed(2)}`);

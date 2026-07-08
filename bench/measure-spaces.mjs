// measure-spaces.mjs — Step 2 of ground-truthing the layout model: the SPACE ADVANCE.
//
// The source transcription now contains real spaces, so every space junction is a
// measurement site: lay the row out with the standard model (Chrome measureText,
// 16px TNR, spaces at their nominal 4px), and at each junction that follows ≥1
// source space, compare the next glyph's predicted outline onset against the ink's
// actual onset. The deviation d, divided by the junction's space count, is how far
// the DRAWN space advance sits from the nominal one:
//
//     trueSpaceAdvance ≈ nominal + d/k
//
// The pen re-anchors on every measured onset (penShift), so each junction is an
// independent sample — a systematic offset earlier in the row can't smear later
// junctions. Non-space junctions are measured the same way as a control group
// (they should sit at d ≈ 0 ± the ¼-px quantization if letter advances are right).
//
//   node measure-spaces.mjs --pdf ../v3.pdf --source ../v3.txt
//   node measure-spaces.mjs --pages 2-7        # the styled block only
//
// Output: per-page-range histograms of d/k for space junctions, plus the control.

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf } from './paths.mjs';
import { parseTTF } from './ttf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const ROW_BASE = 40, ROW_PITCH = 18, ROW_H = 15, ROW_COUNT = 54;

const opts = { pdf: findPdf(REPO), source: null, pages: null,
  chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') opts.pdf = resolve(process.cwd(), next());
  else if (a === '--source') opts.source = resolve(process.cwd(), next());
  else if (a === '--chrome') opts.chrome = next();
  else if (a === '--pages') {
    const v = next();
    const [lo, hi] = v.includes('-') ? v.split('-').map(Number) : [Number(v), Number(v)];
    opts.pages = { lo, hi };
  }
}
if (!opts.source) opts.source = opts.pdf.replace(/\.pdf$/i, '.txt');

// --- source pages ---
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

// --- raster cache ---
const sha = createHash('sha256').update(readFileSync(opts.pdf)).digest('hex').slice(0, 16);
const cacheDir = join(REPO, 'bench', 'raster-cache', sha);
if (!existsSync(cacheDir)) { console.error(`no raster cache at ${cacheDir}`); process.exit(1); }
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

// --- glyph extents from the TTF (exact unhinted curve extrema) ---
const font = parseTTF(readFileSync('C:/Windows/Fonts/times.ttf'));
const glyphExt = {};
{
  const seen = new Set();
  for (const pg of srcPages) for (const l of pg) for (const c of l) seen.add(c);
  seen.delete(' ');
  for (const c of seen) {
    let mn = Infinity, mx = -Infinity, x = 0, sx = 0;
    const add = v => { if (v < mn) mn = v; if (v > mx) mx = v; };
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
    if (mn <= mx) glyphExt[c] = { min: mn, max: mx };
  }
}

const lo = opts.pages?.lo ?? 1;
const hi = Math.min(opts.pages?.hi ?? srcPages.length, srcPages.length);
const startX = 45; // measured by measure-anchor.mjs: exact, uniform

const browser = await puppeteer.launch({ executablePath: opts.chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const samples = []; // {pno, r, i, prev, ch, k, d}
  for (let pno = lo; pno <= hi; pno++) {
    const lines = srcPages[pno - 1];
    const img = loadCachedPage(pno);
    if (!img || !lines) continue;
    const { w: W, h: H, sums } = img;

    // ink map per row (vertical-rule masking as in synth-templates.mjs)
    const inkRows = [];
    {
      const ruleCol = new Uint8Array(W);
      for (let x = 0; x < W; x++) {
        let run = 0;
        for (let y = 0; y < H; y++) {
          if (sums[y * W + x] < 741) { if (++run > ROW_PITCH * 3) { ruleCol[x] = 1; break; } }
          else run = 0;
        }
      }
      for (let r = 0; r < lines.length; r++) {
        const top = ROW_BASE + ROW_PITCH * r;
        let s = '';
        if (top + ROW_H <= H) {
          for (let x = 0; x < W; x++) {
            let ink = 0;
            if (!ruleCol[x]) {
              for (let rr = 0; rr < ROW_H; rr++)
                if (sums[(top + rr) * W + x] < 741) { ink = 1; break; }
            }
            s += ink;
          }
        }
        inkRows.push(s);
      }
    }

    const res = await page.evaluate(({ lines, inkRows, glyphExt, startX }) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '16px "Times New Roman"';
      const width = s => ctx.measureText(s).width;
      const chW = new Map();
      const chWidth = c => { let v = chW.get(c); if (v === undefined) { v = width(c); chW.set(c, v); } return v; };
      const out = [];
      for (let r = 0; r < lines.length; r++) {
        const text = lines[r];
        const ink = inkRows[r] ?? '';
        let penShift = 0;     // measured drift, re-anchored at every REAL gap edge
        let scanFrom = 0;
        let spacesBefore = 0; // source spaces at the CURRENT junction
        let prev = null;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === ' ') { spacesBefore++; continue; }
          const ext = glyphExt[ch];
          if (!ext) break;
          const prefix = text.slice(0, i + 1);
          const left0 = startX + width(prefix) - chWidth(ch) + penShift;
          const onset0 = left0 + ext.min;
          let scan = scanFrom;
          while (scan < ink.length && ink[scan] !== '1') scan++;
          if (scan >= ink.length) break;
          // A junction is a measurement site only when the glyph's onset is
          // BOTH observable (not overhung by the previous glyph's ink:
          // onset0 ≥ scanFrom − 0.5) AND preceded by a real white gap
          // (scan > scanFrom). A glyph whose ink touches its neighbour has no
          // gap edge to measure — scan clamps to scanFrom and the "deviation"
          // is junk; feeding that junk into penShift is what smears every
          // later junction in the row, so such glyphs neither sample nor
          // re-anchor.
          if (onset0 >= scanFrom - 0.5 && scan > scanFrom) {
            const d = scan + 0.5 - 0.8 - onset0; // same centring as the synth fit
            if (Math.abs(d) < 8) {               // a wilder miss is a transcription problem, not a metric
              out.push({ r, i, prev, ch, k: spacesBefore, d: +d.toFixed(3) });
              penShift += d;                     // re-anchor: junctions stay independent
            } else break;
          }
          scanFrom = Math.max(scanFrom, Math.ceil(left0 + ext.max + 0.5));
          prev = ch;
          spacesBefore = 0;
        }
      }
      return out;
    }, { lines, inkRows, glyphExt, startX });
    for (const s of res) samples.push({ pno, ...s });
    process.stderr.write(`\r  ${pno - lo + 1}/${hi - lo + 1} pages`);
  }
  process.stderr.write('\n');

  // --- report ---
  const spc = samples.filter(s => s.k >= 1);
  const ctl = samples.filter(s => s.k === 0);
  const stats = (arr, f) => {
    const v = arr.map(f).sort((a, b) => a - b);
    const q = p => v[Math.min(v.length - 1, Math.floor(v.length * p))];
    return v.length ? `n=${v.length} median=${q(0.5).toFixed(2)} p10=${q(0.1).toFixed(2)} p90=${q(0.9).toFixed(2)}` : 'n=0';
  };
  console.log(`control (no space):   ${stats(ctl, s => s.d)}`);
  console.log(`space junctions d/k:  ${stats(spc, s => s.d / s.k)}`);
  console.log('\nper-page d/k medians (space junctions):');
  const byPage = new Map();
  for (const s of spc) (byPage.get(s.pno) ?? byPage.set(s.pno, []).get(s.pno)).push(s.d / s.k);
  for (const [p, v] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    v.sort((a, b) => a - b);
    console.log(`  P${String(p).padStart(3)}  n=${String(v.length).padStart(4)}  median=${v[Math.floor(v.length / 2)].toFixed(2)}`);
  }
  console.log('\nd/k histogram (space junctions, 0.25px bins):');
  const hist = new Map();
  for (const s of spc) { const b = Math.round(s.d / s.k * 4) / 4; hist.set(b, (hist.get(b) || 0) + 1); }
  for (const [b, n] of [...hist.entries()].sort((a, c) => a[0] - c[0]))
    console.log(`  ${b.toFixed(2).padStart(7)}  ${String(n).padStart(5)}  ${'#'.repeat(Math.min(70, Math.round(n / spc.length * 280)))}`);

  // Control junctions with a large POSITIVE d: the page draws a gap where the
  // transcription has no space — a drawn space missing from (or misplaced in)
  // the source text.
  const missing = ctl.filter(s => s.d > 2.4);
  console.log(`\ncontrol junctions with d > 2.4 (drawn space not in source): ${missing.length}`);
  for (const s of missing.slice(0, 30))
    console.log(`  P${s.pno} L${s.r}#${s.i}  '${s.prev}' _ '${s.ch}'  d=${s.d.toFixed(2)}`);

  // The narrow tail: is it systematic by the pair around the space?
  const tail = spc.filter(s => s.d / s.k <= -0.9);
  console.log(`\ntail junctions (d/k ≤ −0.9): ${tail.length}`);
  const byPair = new Map();
  for (const s of tail) {
    const key = `'${s.prev}' _ '${s.ch}'`;
    (byPair.get(key) ?? byPair.set(key, []).get(key)).push(s);
  }
  for (const [key, v] of [...byPair.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const med = v.map(s => s.d / s.k).sort((a, b) => a - b)[Math.floor(v.length / 2)];
    console.log(`  ${key.padEnd(12)} n=${String(v.length).padStart(3)}  median=${med.toFixed(2)}  eg ${v.slice(0, 3).map(s => `P${s.pno}L${s.r}#${s.i}`).join(' ')}`);
  }
  // …and how do those same pairs behave when they DON'T land in the tail?
  console.log('\nsame pairs, all samples (tail share):');
  const pairsAll = new Map();
  for (const s of spc) {
    const key = `'${s.prev}' _ '${s.ch}'`;
    if (!byPair.has(key)) continue;
    (pairsAll.get(key) ?? pairsAll.set(key, []).get(key)).push(s.d / s.k);
  }
  for (const [key, v] of [...pairsAll.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    v.sort((a, b) => a - b);
    const n = v.length, nt = v.filter(x => x <= -0.9).length;
    console.log(`  ${key.padEnd(12)} n=${String(n).padStart(3)}  median=${v[Math.floor(n / 2)].toFixed(2)}  tail=${nt}/${n}`);
  }
} finally {
  await browser.close();
}

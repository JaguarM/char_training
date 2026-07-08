// synth-templates.mjs — regenerate the template set synthetically, from the
// document itself, instead of hand-cutting PNGs in the training UI.
//
// Background (research 2026-07-03): the page images were drawn as unhinted
// grayscale Times New Roman 16px, black on white, with each glyph's pen x
// quantized to the nearest ¼ px and an integer baseline at band top + 11.
// Rendering is deterministic: every occurrence of the same (char, ¼-px phase)
// puts byte-identical ink inside its own advance; only NEIGHBOUR ink (an f's
// flag, a j's tail crossing the cell border) varies between occurrences.
//
// So the harvest is exact and self-cleaning: group every glyph occurrence of
// source.txt by (char, ¼-px phase alignment), and any pixel column that varies
// within a group IS neighbour bleed — trim to the longest stable column run and
// one bleed-free template per (char, phase) remains (~5 per char), instead of
// one variant per kern context. Alongside the PNGs a template_metrics.json is
// written with EXACT anchors (spread = the ¼-px bucket width, ~0.25), so the
// reader's guided placement recovers each glyph's quantized pen x precisely.
//
//   node synth-templates.mjs                    # harvest all cached pages → ../templates_synth
//   node synth-templates.mjs --pages 1-20       # subset (faster iteration)
//   node synth-templates.mjs --trim             # merge kern variants + cut bleed columns,
//                                               # but only while the core stays at least
//                                               # --min-width columns wide (default 5).
//   node synth-templates.mjs --trim --min-width 0
//                                               # unbounded trim: the clean ~7/char bucket
//                                               # table, but NOT for OCR — a narrow glyph
//                                               # (I l 1 j) trimmed to its stem loses its
//                                               # white margins, the negative evidence that
//                                               # distinguishes an isolated I from the
//                                               # I-shaped slice of an H, and reads collapse.
//
// The --min-width floor is what makes --trim OCR-safe: wide kern-heavy letters
// (A V Y T L R — the variant monsters) get their bleed columns cut because their
// core stays unmistakable, while narrow glyphs keep full windows and margins.
// A merge that would shrink a core below the floor is rolled back — those
// rasters stay as ordinary advance-wide variants, so no (char, phase) ever
// loses its template (the dropped-group holes that broke unbounded trimming).
//
// Layout math matches measure-metrics.mjs: pen x is the kern-correct left edge
//   left_i = startX + measureText(text[0..i+1]) − measureText(char_i)
// (all advances/kerns are multiples of 1/128 px — dyadic, so float64 layout is
// exact and the ¼-px phase of every occurrence is unambiguous).
//
// Pages come from the raster cache (bench/raster-cache/…), which is bit-identical
// to live extraction by construction — no pdf.js needed here. Pages missing from
// the cache are skipped (run dump-ocr.mjs --all once to populate it).
//
// PNGs are written as 8-bit RGB where r+g+b equals the cached R+G+B sum, so the
// engine's gray() = (r+g+b)/3 reproduces the page value bit-exactly even for
// pages whose sums aren't divisible by 3 (raster-cache mode 2).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { gunzipSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf } from './paths.mjs';
import { openRasterCache } from './raster-cache.mjs';
import { parseTTF } from './ttf.mjs';

const require = createRequire(import.meta.url);
const { charToStem, TEMPLATE_LEFT_CROP } = require('../core.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const ROW_BASE = 40, ROW_PITCH = 18, ROW_H = 15;

function parseArgs(argv) {
  const o = { pdf: findPdf(REPO), out: join(REPO, 'templates_synth'),
    source: null, // default: the PDF's .txt sibling (v3.pdf → v3.txt), resolved below
    startX: 45, pages: null, trim: false,
    minWidth: 5,
    fontSpec: '16px Times New Roman', chrome: process.env.CHROME || findChrome() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
    else if (a === '--out') o.out = resolve(process.cwd(), next());
    else if (a === '--source') o.source = resolve(process.cwd(), next());
    else if (a === '--startX') o.startX = parseFloat(next());
    else if (a === '--trim') o.trim = true;
    else if (a === '--no-trim') o.trim = false;
    else if (a === '--min-width') o.minWidth = parseInt(next(), 10);
    else if (a === '--debug-row') { const [p, r] = next().split(':').map(Number); o.debugRow = { p, r }; }
    else if (a === '--pages') {
      const v = next();
      if (v !== 'all') {
        const [lo, hi] = v.includes('-') ? v.split('-').map(Number) : [Number(v), Number(v)];
        o.pages = { lo, hi };
      }
    } else if (a === '--chrome') o.chrome = next();
  }
  if (!o.source && o.pdf) o.source = o.pdf.replace(/\.pdf$/i, '.txt');
  return o;
}

// ---------------------------------------------------------------------------
// Raster-cache page decode (node side; format: raster-cache-browser.js).
// Returns { w, h, sums: Uint16Array } — sums are R+G+B (mode1 stores sum/3).
function loadCachedPage(path) {
  const raw = gunzipSync(readFileSync(path));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  if (hdr[0] !== 0x31595247) throw new Error(`bad magic in ${path}`);
  const mode = hdr[1], w = hdr[2], h = hdr[3], n = w * h;
  if (mode === 0) return null; // page had no embedded image
  const sums = new Uint16Array(n);
  if (mode === 1) for (let i = 0; i < n; i++) sums[i] = raw[16 + i] * 3;
  else if (mode === 2) sums.set(new Uint16Array(raw.buffer, raw.byteOffset + 16, n));
  else throw new Error(`unknown mode ${mode} in ${path}`);
  return { w, h, sums };
}

// ---------------------------------------------------------------------------
// Minimal PNG writer: 8-bit RGB, no interlace, filter 0.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(w, h, rgb /* Buffer 3*w*h */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  const stride = 3 * w;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Sums (u16 per pixel) → RGB bytes with r+g+b === sum, so gray() round-trips.
function sumsToRGB(sums) {
  const rgb = Buffer.alloc(sums.length * 3);
  for (let i = 0; i < sums.length; i++) {
    const s = sums[i], v = Math.floor(s / 3), m = s - v * 3;
    rgb[i * 3] = v + (m > 0 ? 1 : 0);
    rgb[i * 3 + 1] = v + (m > 1 ? 1 : 0);
    rgb[i * 3 + 2] = v;
  }
  return rgb;
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.chrome || !existsSync(opts.chrome)) { console.error('No Chrome'); process.exit(1); }
  if (!existsSync(opts.source)) { console.error(`No source file: ${opts.source}`); process.exit(1); }

  // Pages are fixed-shape: ROW_COUNT rows + one separator line each. (Splitting
  // on blank lines breaks on documents whose pages CONTAIN empty rows — an email
  // body with paragraphs, a blank cover page.) Empty rows are kept: row index
  // must stay aligned with the page's band grid.
  const ROW_COUNT = 54;
  // A file ending in '\n' (the normal case) splits into one trailing "" that
  // represents EOF, not a real blank line — left in, it can look like exactly
  // one more line of content and fool the page-boundary math below into
  // synthesizing a whole extra all-blank trailing page.
  const srcRaw = readFileSync(opts.source, 'utf8').replace(/\r/g, '');
  const srcLines = (srcRaw.endsWith('\n') ? srcRaw.slice(0, -1) : srcRaw).split('\n');
  // Separator auto-detect: pages are ROW_COUNT rows each, optionally followed by
  // one blank separator line. (A file of exactly N·54 content lines has none.)
  let sep = 1;
  for (let i = ROW_COUNT; i < srcLines.length - 1; i += ROW_COUNT + 1)
    if (srcLines[i] !== '') { sep = 0; break; }
  const srcPages = [];
  for (let i = 0; i + 1 <= srcLines.length && srcLines.slice(i, i + ROW_COUNT).some(l => l !== undefined); i += ROW_COUNT + sep) {
    const pg = srcLines.slice(i, i + ROW_COUNT);
    if (!pg.length || pg.every(l => l === undefined)) break;
    while (pg.length < ROW_COUNT) pg.push('');
    srcPages.push(pg);
    if (i + ROW_COUNT >= srcLines.length) break;
  }
  const cache = await openRasterCache(opts.pdf, REPO);
  const cacheDir = join(REPO, 'bench', 'raster-cache', cache.key);

  const lo = opts.pages?.lo ?? 1;
  const hi = Math.min(opts.pages?.hi ?? srcPages.length, srcPages.length);

  // Exact UNHINTED ink extents per char from the font outlines (px at 16px).
  // Chrome's actualBoundingBox* is hinted/rounded, and a control-point bbox
  // over/undershoots curve extrema by up to ~0.5px — both fatal to the space
  // fit below (4px space advance, ~2px decision margin). So: true curve
  // extrema, closed-form, from the flattened path commands.
  const glyphExt = {};
  {
    const font = parseTTF(readFileSync('C:/Windows/Fonts/times.ttf'));
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

  const browser = await puppeteer.launch({ executablePath: opts.chrome,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();

    // Reference shape per char: the TTF outline filled as a Path2D (Skia's
    // analytic AA, unhinted — matches the page rasteriser to a few greys,
    // unlike hinted fillText whose grid-fitting is ±25+ on narrow glyphs), at
    // each ¼-px phase. Used to reject glyphs whose page crop can't be the
    // labelled char at all — a mis-transcribed row can pass the advance-
    // residual gate when widths align (source '>>>' vs page '>>>> ': '=' lands
    // on a chevron), and one such row poisons the dictionary.
    const glyphCmds = {};
    {
      const font = parseTTF(readFileSync('C:/Windows/Fonts/times.ttf'));
      const s = 16 / font.unitsPerEm;
      for (const ch in glyphExt) {
        glyphCmds[ch] = font.pathCommands(ch, 16);
        glyphExt[ch].adv = font.advance(font.glyphId(ch.codePointAt(0))) * s;
      }
    }
    const refs = await page.evaluate(({ glyphExt, glyphCmds }) => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const out = {};
      for (const ch in glyphExt) {
        const path = new Path2D();
        for (const cm of glyphCmds[ch]) {
          if (cm[0] === 'M') path.moveTo(cm[1], cm[2]);
          else if (cm[0] === 'L') path.lineTo(cm[1], cm[2]);
          else if (cm[0] === 'Q') path.quadraticCurveTo(cm[1], cm[2], cm[3], cm[4]);
          else path.closePath();
        }
        const x0 = Math.floor(12 + glyphExt[ch].min);
        const w = Math.max(1, Math.ceil(12 + glyphExt[ch].max) - x0);
        const variants = [];
        for (const phase of [0, 0.25, 0.5, 0.75]) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 40, 24);
          ctx.fillStyle = '#000';
          ctx.translate(12 + phase, 15); // baseline y=15 → band rows 4..18
          ctx.fill(path);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const d = ctx.getImageData(x0, 4, w, 15).data;
          const px = [];
          for (let i = 0; i < w * 15; i++) px.push(d[i * 4]);
          variants.push(px);
        }
        out[ch] = { w, variants };
      }
      return out;
    }, { glyphExt, glyphCmds });

    // Variants keyed `${ch}:${rasterBytes}` — every distinct full-window raster
    // of a char, with occurrence count and pen-fraction stats. No phase model is
    // assumed here; phases separate naturally because different phases produce
    // different rasters. Bleed variants (same phase, a neighbour's ink in an
    // edge column) are merged in the trim pass below.
    const groups = new Map();
    const charAdv = new Map(); // char → isolated measureText advance
    let nGlyphs = 0, nPages = 0;
    const skipped = [], fitFailures = [];
    const spacedPages = new Map(); // pno → 54 fitted (spaced) row strings

    for (let pno = lo; pno <= hi; pno++) {
      const lines = srcPages[pno - 1];
      if (!lines?.length) continue;
      if (!cache.havePage(pno)) { skipped.push(pno); continue; }
      const img = loadCachedPage(join(cacheDir, cache.pageName(pno)));
      if (!img) { skipped.push(pno); continue; }
      nPages++;

      // Ink map per row band: '1' where any of the 15 band rows has ink at that
      // column. The transcription is SPACE-LESS (the document draws spaces, the
      // OCR never emits them), so the layout fit below re-discovers each gap.
      //
      // Vertical rules (an email quote bar, a table border — often FAINT, well
      // inside the <247 ink threshold) would put "ink" at their column in every
      // row and snap every scan to them, mis-registering whole rows. A rule is
      // ink CONTINUOUSLY down the page — through the inter-band gaps where text
      // never reaches — so columns whose longest consecutive ink run spans 3+
      // row pitches are masked out of the ink map. A stack of repeated glyphs
      // ('>' quoting on every row) never bridges the gaps.
      const inkRows = [];
      {
        const { w: W2, h: H2, sums } = img;
        const ruleCol = new Uint8Array(W2);
        for (let x = 0; x < W2; x++) {
          let run = 0;
          for (let y = 0; y < H2; y++) {
            if (sums[y * W2 + x] < 741) { if (++run > ROW_PITCH * 3) { ruleCol[x] = 1; break; } }
            else run = 0;
          }
        }
        for (let r = 0; r < lines.length; r++) {
          const top = ROW_BASE + ROW_PITCH * r;
          let s = '';
          if (top + ROW_H <= H2) {
            for (let x = 0; x < W2; x++) {
              let ink = 0;
              if (!ruleCol[x]) {
                for (let rr = 0; rr < ROW_H; rr++) {
                  if (sums[(top + rr) * W2 + x] < 741) { ink = 1; break; } // gray < 247
                }
              }
              s += ink;
            }
          }
          inkRows.push(s);
        }
      }

      // Kern-correct left edge per glyph, fitting the spaces the transcription
      // omits: at each junction, if the page has no ink at the next glyph's
      // predicted onset (pen + its left side bearing), the distance to the next
      // ink column ÷ the exact 4px space advance gives the space count. The
      // fitted spaced text feeds the same measureText layout math as always.
      const dbgRow = opts.debugRow && opts.debugRow.p === pno ? opts.debugRow.r : -1;
      const res = await page.evaluate(({ lines, inkRows, glyphExt, startX, fontSpec, dbgRow }) => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = fontSpec;
        const chW = new Map();
        const width = s => ctx.measureText(s).width;
        const chWidth = c => { let v = chW.get(c); if (v === undefined) { v = width(c); chW.set(c, v); } return v; };
        const SP = width(' ');
        const rows = [], fitFails = [], dbg = [];

        // Fit one row's space counts. Gap width alone can't cleanly separate "no
        // space, just a wide natural kern gap" from "one real but tight space" —
        // the two populations overlap (~2.7–2.9px here) because a handful of
        // pairs (a colon or comma immediately before a capital letter) render
        // their space narrower than the nominal SP. Rather than hand-tune the
        // decision constants, every glyph whose residual sits in that grey zone
        // (or that outright fails the old hard gate) is recorded as a `cand`;
        // the caller re-fits the row with those specific counts nudged by ±1
        // and lets the pixel shape-check (below) arbitrate which version is
        // real — the same oracle already used to catch mistranscribed glyphs.
        // `forceMap`, when given, overrides the natural k at those indices
        // (skipping their gate) so a retry can commit to the nudged count.
        function fitRow(r, text, ink, forceMap) {
          const out = [];
          let spaced = '';
          let ok = true;
          let scanFrom = 0;
          const cand = [];
          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === ' ') {
              // The source now spells real spaces out directly — trust it rather
              // than inferring a count from the ink gap: just widen `spaced` by
              // one space. scanFrom is left as-is (still just past the previous
              // real glyph's ink); the next real glyph's ink-scan walks forward
              // through this blank run on its own, and that glyph's own left0
              // (via leftFor(spaced), spaced now including this space) already
              // reflects the wider gap — so an honestly-placed space costs
              // nothing here and a wrong one still surfaces as a residual/no-ink
              // failure on the glyph that follows it.
              spaced += ' ';
              continue;
            }
            const ext = glyphExt[ch];
            if (!ext) { if (!forceMap) fitFails.push([r, i, ch, 'no-ext']); ok = false; break; }
            const leftFor = pre => startX + width(pre + ch) - chWidth(ch);
            // Space count from the ACTUAL white gap. scan = first ink at/after
            // the previous glyph's exact outline end; the k=0 prediction puts
            // this glyph's outline onset at left0+ext.min. A predicted onset
            // still inside the previous glyph's ink (kern overlap, 'fo'/'Aj')
            // is definitionally k = 0; otherwise the white run length solves
            // k = Δ/4px-space with ~1.5px residual margin — anything looser
            // fails the row (harvesting junk is worse than skipping a row).
            const left0 = leftFor(spaced);
            let scan = scanFrom;
            while (scan < ink.length && ink[scan] !== '1') scan++;
            if (scan >= ink.length) { if (!forceMap) fitFails.push([r, i, ch, 'no-ink']); ok = false; break; }
            const onset0 = left0 + ext.min;
            const useRun = onset0 < scanFrom - 0.5;
            let naturalK, resid;
            if (!useRun) {
              const d = scan + 0.5 - onset0; // ink col centre vs predicted onset
              naturalK = Math.max(0, Math.round((d - 0.8) / SP));
              resid = d - 0.8 - naturalK * SP;
            } else {
              // Previous glyph's ink overhangs this glyph's k=0 onset (an f's
              // flag, a V's arm): the onset can't be observed, but the white
              // run after the previous ink still measures the space count —
              // contiguous ink is k=0, each space adds ~4 white columns.
              const run = scan - scanFrom;
              naturalK = Math.max(0, Math.round(run / SP));
              resid = naturalK ? run - naturalK * SP : 0;
            }
            const forced = forceMap && forceMap.get(i);
            let k = forced ? Math.max(0, naturalK + forced) : naturalK;
            // Candidate threshold: 1.4 leaves confidently-correct decisions alone
            // (e.g. a real single space right after a narrow glyph routinely has
            // |resid| ~1.0 from AA/rounding noise alone) while still catching the
            // genuinely ambiguous ones — a colon or comma immediately before a
            // capital letter renders its following space ~1px narrower than
            // elsewhere, landing at resid ~1.9, just under the 2.0 hard-fail gate.
            if (!forced && Math.abs(resid) > 1.4) cand.push({ i, delta: resid > 0 ? 1 : -1 });
            const failThresh = useRun ? 2.2 : 2.0;
            if (!forced && Math.abs(resid) > failThresh) {
              if (!forceMap) {
                fitFails.push([r, i, ch, useRun ? 'run' + (scan - scanFrom) : +(scan + 0.5 - onset0).toFixed(2)]);
                cand.push({ i, delta: resid > 0 ? 1 : -1 }); // the failing point is itself a retry candidate
              }
              ok = false; break;
            }
            const left = k ? leftFor(spaced + ' '.repeat(k)) : left0;
            if (r === dbgRow)
              dbg.push(`#${i} '${ch}' left0=${left0.toFixed(2)} onset0=${onset0.toFixed(2)} ` +
                `scanFrom=${scanFrom} scan=${scan} k=${k} left=${left.toFixed(2)}`);
            spaced += ' '.repeat(k) + ch;
            out.push({ ch, left });
            // +0.5: the ¼-px pen quantization can push the drawn ink half a
            // column past the outline's xMax — never start the scan on the
            // previous glyph's own last AA column.
            scanFrom = Math.max(scanFrom, Math.ceil(left + ext.max + 0.5));
          }
          if (r === dbgRow) dbg.push(`ROW ok=${ok} cand=${JSON.stringify(cand)} forced=${forceMap ? JSON.stringify([...forceMap]) : 'none'}`);
          return { chars: ok ? out : [], spaced: ok ? spaced : text, ok, cand };
        }

        const rowsOut = [];
        for (let r = 0; r < lines.length; r++) {
          const text = lines[r], ink = inkRows[r] ?? '';
          const first = fitRow(r, text, ink, null);
          const alts = [];
          if (first.cand.length) {
            // Try each candidate's ±1 nudge IN ISOLATION first — flipping every
            // ambiguous point at once (the last alt below) risks compounding an
            // already-correct decision into a wrong one, so single flips are
            // offered to the shape-check first and only the one(s) it actually
            // needs should ever change the row's spacing.
            for (const c of first.cand) {
              const retry = fitRow(r, text, ink, new Map([[c.i, c.delta]]));
              if (retry.chars.length) alts.push({ chars: retry.chars, spaced: retry.spaced });
            }
            if (first.cand.length > 1) {
              const all = fitRow(r, text, ink, new Map(first.cand.map(c => [c.i, c.delta])));
              if (all.chars.length) alts.push({ chars: all.chars, spaced: all.spaced });
            }
          }
          rowsOut.push({ chars: first.chars, spaced: first.spaced, alts });
        }
        return { rows: rowsOut, fitFails, dbg, adv: [...chW.entries()] };
      }, { lines, inkRows, glyphExt, startX: opts.startX, fontSpec: `16px "Times New Roman"`, dbgRow });
      if (res.dbg.length) console.log('\n' + res.dbg.join('\n'));
      for (const [c, v] of res.adv) if (!charAdv.has(c)) charAdv.set(c, v);
      const hardFailByRow = new Map(); // r → "P# L#..." message, only surfaced if no option below rescues the row
      for (const [r, i, ch, d] of res.fitFails)
        hardFailByRow.set(r, `P${pno} L${r}#${i}'${ch}'(${d})`);
      spacedPages.set(pno, res.rows.map(r => r.spaced));

      const { w: W, h: H, sums } = img;
      // Shape-verify a glyph's page crop against a char's reference render:
      // mean |page − ref| per pixel, best of ±1 column alignment (phase +
      // hinting shift). Same char ≈ 10–40 (hinted-vs-unhinted noise); a
      // mislabelled glyph is EXPLAINED BETTER BY ANOTHER CHAR — the absolute
      // score alone can't separate a noisy match from a '<' labelled '>'.
      // Score char `ch` drawn at `left` against the page, over the WINDOW of
      // char `winCh` (white-padded where ch's reference doesn't reach). Scoring
      // an alternative over the CLAIMED char's window is what makes the
      // relative test sound: a '.' reference must pay for every j-stem pixel
      // it fails to explain, instead of being judged only on its own 3 columns.
      const shapeScore = (left, top, ch, winCh = ch) => {
        const ref = refs[ch], ext = glyphExt[ch], wExt = glyphExt[winCh];
        if (!ref) return 999;
        // Clip the window to the glyph's own advance cell: a negative left
        // bearing (j's hook) or a right overhang (f's flag) reaches into the
        // NEIGHBOUR's cell, whose legitimate ink would otherwise be charged
        // against this glyph's score.
        const winLo = Math.max(wExt.min, 0.2), winHi = Math.min(wExt.max, wExt.adv - 0.2);
        const winW = Math.max(1, Math.ceil(left + winHi) - Math.floor(left + winLo));
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
          const win0 = Math.floor(left + winLo) + dx;
          const refX0 = Math.floor(left + ext.min) + dx;
          if (win0 < 0 || win0 + winW > W) continue;
          for (const px of ref.variants) {
            let s = 0;
            for (let rr = 0; rr < ROW_H; rr++) {
              const b = (top + rr) * W;
              for (let cc = 0; cc < winW; cc++) {
                const x = win0 + cc, rc = x - refX0;
                const e = rc >= 0 && rc < ref.w ? px[rr * ref.w + rc] : 255;
                s += Math.abs(sums[b + x] / 3 - e);
              }
            }
            best = Math.min(best, s / (winW * ROW_H));
          }
        }
        return best;
      };
      const TH_SUSPECT = 35, TH_ABS = 110, TH_MARGIN = 12;
      const allChars = Object.keys(refs);
      const checkRow = (chars, top) => {
        for (const g of chars) {
          if (g.ch === ' ') continue;
          const sc = shapeScore(g.left, top, g.ch);
          if (sc <= TH_SUSPECT) continue;
          if (sc > TH_ABS) return `'${g.ch}'(shape ${sc.toFixed(0)})`;
          // borderline: is some OTHER char a clearly better explanation?
          let other = Infinity, otherCh = '';
          for (const c2 of allChars) {
            if (c2 === g.ch) continue;
            const s2 = shapeScore(g.left, top, c2, g.ch); // judged over g.ch's window
            if (s2 < other) { other = s2; otherCh = c2; }
          }
          if (other + TH_MARGIN < sc) return `'${g.ch}'(shape ${sc.toFixed(0)}, looks like '${otherCh}' ${other.toFixed(0)})`;
        }
        return null;
      };
      for (let r = 0; r < res.rows.length; r++) {
        const top = ROW_BASE + ROW_PITCH * r;
        if (top + ROW_H > H) break;
        const row = res.rows[r];
        // Try the row's normal fit first, then — only if that one has a bad
        // glyph — the space-retry alternate (see fitRow above): the pixel
        // shape-check is the oracle that decides whether the ±1 nudge was
        // the real fix, so a row is never silently changed unless its
        // original fit actually failed verification.
        const options = [];
        if (row.chars.length) options.push({ chars: row.chars, spaced: row.spaced });
        for (const a of row.alts) options.push({ chars: a.chars, spaced: a.spaced, retried: true });
        let chosen = null, badGlyph = null;
        for (const opt of options) {
          const bad = checkRow(opt.chars, top);
          if (!bad) { chosen = opt; break; }
          if (badGlyph == null) badGlyph = bad;
        }
        if (!chosen) {
          const msg = hardFailByRow.get(r) ?? (badGlyph != null ? `P${pno} L${r} ${badGlyph}` : null);
          if (msg) fitFailures.push(msg);
          spacedPages.get(pno)[r] = srcPages[pno - 1][r]; // don't trust the fit
          continue;
        }
        if (chosen.retried) spacedPages.get(pno)[r] = chosen.spaced; // the ±1 nudge verified — keep its recovered spacing
        for (const g of chosen.chars) {
          if (g.ch === ' ') continue; // spaces are gaps, never templates
          const base = Math.round(g.left);
          const w = Math.max(1, Math.round(charAdv.get(g.ch)) - 1 - TEMPLATE_LEFT_CROP);
          const x0 = base + TEMPLATE_LEFT_CROP;
          if (x0 < 0 || x0 + w > W) continue;
          nGlyphs++;
          const crop = new Uint16Array(w * ROW_H);
          for (let rr = 0; rr < ROW_H; rr++) {
            const b = (top + rr) * W + x0;
            for (let cc = 0; cc < w; cc++) crop[rr * w + cc] = sums[b + cc];
          }
          const key = g.ch + ':' +
            Buffer.from(crop.buffer, crop.byteOffset, crop.byteLength).toString('latin1');
          let grp = groups.get(key);
          const rel0 = g.left - base;                 // anchor sample ingredient
          if (!grp) {
            grp = { ch: g.ch, w, px: crop, count: 0, relRef: rel0,
              relSum: 0, relMin: Infinity, relMax: -Infinity, firstPage: pno };
            groups.set(key, grp);
          }
          grp.count++;
          // Unwrap onto the group's branch: a phase bucket that straddles the
          // pixel edge samples rel at both ~+0.5 and ~−0.5 — plain min/max would
          // read that as a full-pixel spread (the circular-range trap).
          const rel = rel0 - Math.round(rel0 - grp.relRef);
          grp.relSum += rel;
          if (rel < grp.relMin) grp.relMin = rel;
          if (rel > grp.relMax) grp.relMax = rel;
        }
      }
      process.stderr.write(`\r  harvest ${pno - lo + 1}/${hi - lo + 1} pages`);
    }
    process.stderr.write('\n');

    // ---- merge bleed variants, trim their columns -----------------------------
    // Per char: repeatedly take the most frequent remaining raster as pivot and
    // absorb every raster that differs from it only in a few EDGE-CONTIGUOUS
    // columns — that is neighbour bleed (an f's flag or j's tail reaches 1–3
    // columns into this cell, always from a side). A different ¼-px phase moves
    // the glyph's own ink — interior columns change — so phases never merge.
    // The pivot is then cropped to the columns no absorbed variant disagreed on.
    const byCharVar = new Map();
    for (const g of groups.values())
      (byCharVar.get(g.ch) ?? byCharVar.set(g.ch, []).get(g.ch)).push(g);

    // columns where a and b differ (same w); null when not edge-contiguous bleed
    const bleedCols = (a, b, w, maxCols) => {
      const cols = [];
      for (let cc = 0; cc < w; cc++) {
        for (let rr = 0; rr < ROW_H; rr++) {
          if (a[rr * w + cc] !== b[rr * w + cc]) { cols.push(cc); break; }
        }
        if (cols.length > maxCols) return null;
      }
      // edge-contiguous: a prefix run and/or a suffix run, nothing interior
      let lo = 0, hi = w - 1, i = 0, j = cols.length - 1;
      while (i <= j && cols[i] === lo) { i++; lo++; }
      while (j >= i && cols[j] === hi) { j--; hi--; }
      return i > j ? cols : null;
    };

    const finals = new Map(); // `${ch}|${w}|${bytes}` → deduped trimmed template
    let trimmedCols = 0, emptyRuns = 0, mergedVars = 0, flooredVars = 0;
    for (const [ch, vars] of byCharVar) {
      vars.sort((a, b) => b.count - a.count);
      const w = vars[0].w;
      const maxBleed = Math.min(3, Math.max(1, w - 1));
      // Chars at or below the width floor are never trimmed: their margins ARE
      // their discriminative signal, so every kern-context variant is kept.
      const charTrim = opts.trim && w > opts.minWidth;
      let rest = vars;
      while (rest.length) {
        const pivot = rest.shift();
        const unstable = new Set();
        const keep = [], absorbed = [];
        for (const v of rest) {
          const cols = charTrim ? bleedCols(pivot.px, v.px, w, maxBleed) : null;
          if (cols) absorbed.push({ v, cols });
          else keep.push(v);
        }
        // longest column run free of bleed, were all absorptions committed
        for (const a of absorbed) for (const cc of a.cols) unstable.add(cc);
        let bestRun = [0, 0], cur = -1;
        for (let cc = 0; cc <= w; cc++) {
          if (cc < w && !unstable.has(cc)) { if (cur < 0) cur = cc; }
          else if (cur >= 0) { if (cc - cur > bestRun[1] - bestRun[0]) bestRun = [cur, cc]; cur = -1; }
        }
        let [c0, c1] = bestRun;
        if (charTrim && absorbed.length && c1 - c0 >= opts.minWidth) {
          // commit: pool the absorbed variants' stats into the pivot
          for (const { v } of absorbed) {
            // Same phase, so the rel means agree mod 1 — align v's branch to the
            // pivot's before pooling (a |diff| near 1 is the wraparound case).
            const dBr = Math.round(v.relSum / v.count - pivot.relSum / pivot.count);
            pivot.count += v.count;
            pivot.relSum += v.relSum - dBr * v.count;
            pivot.relMin = Math.min(pivot.relMin, v.relMin - dBr);
            pivot.relMax = Math.max(pivot.relMax, v.relMax - dBr);
            mergedVars++;
          }
          rest = keep;
        } else {
          // roll back: core would fall below the floor (or nothing to absorb) —
          // emit the pivot untrimmed and leave the others as their own variants.
          if (charTrim && absorbed.length) flooredVars++;
          rest = absorbed.length ? keep.concat(absorbed.map(a => a.v)) : keep;
          [c0, c1] = [0, w];
        }
        if (c1 - c0 === 0) { emptyRuns++; continue; }
        trimmedCols += w - (c1 - c0);
        const tw = c1 - c0;
        const px = new Uint16Array(tw * ROW_H);
        for (let rr = 0; rr < ROW_H; rr++)
          for (let cc = 0; cc < tw; cc++) px[rr * tw + cc] = pivot.px[rr * w + c0 + cc];
        // anchor = matched cellLeft − glyph left. matchAt probes cellLeft and
        // reads pixels at cellLeft + TEMPLATE_LEFT_CROP, and the template's
        // pixels start at page column base + TEMPLATE_LEFT_CROP + c0 — so the
        // match lands at cellLeft = base + c0, and anchor = c0 − rel.
        const off = c0;
        const aMin = off - pivot.relMax, aMax = off - pivot.relMin;
        const aSum = pivot.count * off - pivot.relSum;
        const key = ch + '|' + tw + ':' +
          Buffer.from(px.buffer, px.byteOffset, px.byteLength).toString('latin1');
        const f = finals.get(key);
        if (f) { // identical trimmed raster again (e.g. two phases) — pool stats
          // Anchor = c0 − rel is ABSOLUTE (base-rounding shifts cancel via c0), so
          // two pivots trimming to the same core with means ~a pixel apart is not
          // wraparound — it is the genuine mod-1 ambiguity trimming creates (phase
          // p and p+1 collapse to one raster). Keep the folded mean for the
          // sub-pixel fields (aSum/aMin/aMax), but track the UNFOLDED spread in
          // hMin/hMax: it becomes anchorRange, so the reader sees the ambiguity
          // and refuses to position-gate on this template (reader.js _metric).
          const diff = aSum / pivot.count - f.aSum / f.count;
          const dBr = Math.abs(diff) > 0.75 ? Math.round(diff) : 0;
          f.hMin = Math.min(f.hMin, aMin);
          f.hMax = Math.max(f.hMax, aMax);
          f.count += pivot.count;
          f.aSum += aSum - dBr * pivot.count;
          f.aMin = Math.min(f.aMin, aMin - dBr);
          f.aMax = Math.max(f.aMax, aMax - dBr);
          f.merged++;
        } else {
          finals.set(key, { ch, w: tw, px, count: pivot.count, aSum, aMin, aMax,
            hMin: aMin, hMax: aMax, merged: 1, firstPage: pivot.firstPage });
        }
      }
    }

    // ---- write PNGs + exact metrics ------------------------------------------
    if (existsSync(opts.out)) rmSync(opts.out, { recursive: true });
    mkdirSync(opts.out, { recursive: true });
    const byChar = new Map();
    for (const f of finals.values()) {
      (byChar.get(f.ch) ?? byChar.set(f.ch, []).get(f.ch)).push(f);
    }
    let nFiles = 0, nAmbiguous = 0;
    const manifest = [], metricRows = [], counts = [];
    for (const [ch, list] of [...byChar.entries()].sort()) {
      const stem = charToStem(ch);
      list.sort((a, b) => b.count - a.count);
      let n = 0;
      for (const t of list) {
        const name = `${stem}_${++n}.png`;
        writeFileSync(join(opts.out, name), encodePNG(t.w, ROW_H, sumsToRGB(t.px)));
        nFiles++;
        if (t.hMax - t.hMin > 0.3) nAmbiguous++; // spans more than one ¼-px bucket
        const anchor = t.aSum / t.count;
        manifest.push({ filename: name, char: ch, w: t.w, count: t.count,
          firstPage: t.firstPage });
        metricRows.push({
          filename: name, char: ch, width: t.w,
          advanceWidth: charAdv.get(ch),
          anchor: +anchor.toFixed(4),
          // honest, unfolded spread: > 1 when identical cores collapsed from
          // phases a whole pixel apart — the reader must not trust the anchor
          anchorRange: +(t.hMax - t.hMin).toFixed(4),
          anchorShare: 1, count: t.count,
          subpixelCenter: +((((-anchor % 1) + 1) % 1).toFixed(4)),
          // folded (mod-1) spread: how tight the anchor is UP TO a whole-pixel
          // choice — a future reader can resolve that integer against its pen
          subpixelWidth: +(t.aMax - t.aMin).toFixed(4),
        });
      }
      counts.push(`${ch}:${n}`);
    }
    // Reader-compatible metrics: fontSpec must equal the app Config's fontSpec.
    writeFileSync(join(opts.out, 'template_metrics.json'), JSON.stringify({
      generated: new Date().toISOString(), pdf: basename(opts.pdf),
      pages: nPages, fontSpec: opts.fontSpec, fontSize: 16,
      templateLeftCrop: TEMPLATE_LEFT_CROP, anchor: opts.startX,
      unattributed: 0, exact: true, templates: metricRows,
    }, null, 1));
    writeFileSync(join(opts.out, 'synth-manifest.json'),
      JSON.stringify({ generated: new Date().toISOString(), pages: [lo, hi],
        skippedPages: skipped, glyphs: nGlyphs, files: nFiles,
        trim: opts.trim, fitFailures, manifest }, null, 1));

    // The fitted spaced transcription — the spacing the space-less source omits,
    // recovered from the pixels ("spaces emerge from placing the letters").
    {
      const parts = [];
      for (let pno = lo; pno <= hi; pno++)
        parts.push((spacedPages.get(pno) ?? srcPages[pno - 1] ?? []).join('\n'));
      writeFileSync(join(REPO, 'source_spaced.txt'), parts.join('\n\n') + '\n');
    }

    console.log(`pages ${lo}-${hi} (${nPages} harvested${skipped.length ? `, ${skipped.length} skipped — not in raster cache` : ''})`);
    console.log(`${nGlyphs} glyph occurrences, ${groups.size} distinct rasters → ${nFiles} templates` +
      (opts.trim ? ` (${mergedVars} bleed variants merged, ${trimmedCols} columns trimmed` +
        `${flooredVars ? `, ${flooredVars} merges rolled back at --min-width ${opts.minWidth}` : ''}` +
        `${emptyRuns ? `, ${emptyRuns} dropped — no stable columns` : ''})` : ''));
    if (nAmbiguous) console.log(`${nAmbiguous} templates are phase-ambiguous (anchorRange > 0.3: same pixels at 2+ ¼-px phases)`);
    if (fitFailures.length)
      console.log(`space-fit FAILED on ${fitFailures.length} row(s) (not harvested): ${fitFailures.slice(0, 12).join(' ')}${fitFailures.length > 12 ? ' …' : ''}`);
    console.log(`wrote ../source_spaced.txt (fitted spacing)`);
    console.log(`variants per char: ${counts.join(' ')}`);
    console.log(`wrote ${opts.out} (+ template_metrics.json with exact anchors)`);
  } finally {
    await browser.close();
  }
}
main();

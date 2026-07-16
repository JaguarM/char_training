// guess-letter.mjs — stress-test the information limit of the ¼-px bucket stream:
// erase ONE letter from a real corpus line and try to recover it from what
// survives. Physics per docs/RENDERER_IDENTIFIED.md + docs/SYNTHETIC_DICT.md
// (MuPDF TNR 12pt @ 96dpi gray, integer baselines 40+18·row+11, pen x snapped
// to ¼ px with boundaries at .125, layout = Chrome measureText from startX 45,
// drawn pens sit δ ∈ [0, ~0.03] px BELOW the ideal measureText positions).
//
// Three evidence levels, reported separately (docs/MISSING_LETTER_PROMPT.md):
//   1 geometry-only : erase the glyph's full advance window ∪ its ink columns;
//                     infer from the surviving glyphs' located ¼-px buckets via
//                     interval intersection.
//   2 + bleed       : erase only the columns where the glyph's ink stands alone;
//                     composite pixels and kern-bleed survive — byte-compare
//                     candidate composites (blend law dst=(dst*(256-e))>>8,
//                     e = cov + (cov>>7)).
//   (a third level — full-line re-render through real MuPDF — was retired with
//   the Python tooling on 2026-07-15; its results stand in MISSING_LETTER.md
//   ("L3 ≈ L1", bounded by the advance lattice). Tag `python-era` has it.)
//
//   node guess-letter.mjs --page 3 --row 12 --col 17            # one glyph, verbose
//   node guess-letter.mjs --sample 300 [--targeted] [--out r.json]
//   node guess-letter.mjs --calibrate 80                        # δ + x0 floor stats
//   (--pdf ../corpus/v3.pdf default; --pdf ../corpus/big.pdf for volume)
//
// Page rasters come exclusively from tools/raster-cache/ (never re-rasterized);
// glyph rasters: times16 from assets/glyphs/glyphs.bin (export-glyphs.mjs).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from './paths.mjs';
import { materializeSet } from './glyph-bundle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ---------------- proven layout constants ----------------
const ROW_COUNT = 54, ROW_BASE = 40, ROW_PITCH = 18, BASE_OFF = 11;
const MAX_ASC = 12, MAX_DESC = 4;          // TNR16 ink rows ⊂ [baseline-12, baseline+4]
const START_X = 45;
const EPS = 1 / 4096;
const SNAP = x => Math.round(x * 4) / 4;   // ¼-px pen snap (boundaries at .125)
// δ = ideal − drawn pen. Measured over v3+big by --calibrate (see notes):
// observed ideal−bucket ∈ [-0.125, 0.125+δmax]. Default baked from calibration.
const DELTA_MAX_DEFAULT = 0.032;

// Rows excluded from sampling (narrow-space styled rows under manual review —
// docs/SPACE_REVIEW.md — plus P4 L36 redaction-box row and P5 L13 where
// v3.txt itself is truncated). Keyed by raster-cache key so a different PDF
// never inherits the list. 'page-row', page 1-based, row 0-based.
const SKIP_ROWS = {
  '4a03e5ed497dd6a3': new Set([
    '2-21', '2-39', '2-44', '2-50', '3-17', '3-22', '3-25', '3-47', '4-35',
    '4-36', '4-37', '5-0', '5-8', '5-13', '5-19', '5-20', '5-27', '5-29',
    '5-35', '5-38', '5-41', '5-43', '5-46', '5-52', '6-3', '6-9', '6-14',
    '6-25', '6-29', '6-50',
  ]),
};

const NARROW = new Set([...'ilftjr.,\'-:;!']);
const KERN_PAIRS = new Set(['AV','AW','AT','AY','Av','Aw','Ay','FA','LT','LV','LW','LY',
  'PA','TA','Ta','Te','To','Tr','Tu','Tw','Ty','VA','Va','Ve','Vo','WA','Wa','We','Wo',
  'YA','Ya','Ye','Yo','av','aw','ay','f.','f,','r.','r,','v.','v,','w.','w,','y.','y,']);

// ---------------- args ----------------
const o = {
  pdf: join(REPO, 'corpus', 'v3.pdf'), source: null, page: 0, row: -1, col: -1,
  sample: 0, targeted: false, seed: 1, levels: [1, 2], deltaMax: DELTA_MAX_DEFAULT,
  calibrate: 0, out: null, chrome: process.env.CHROME || findChrome(),
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--source') o.source = resolve(process.cwd(), next());
  else if (a === '--page') o.page = parseInt(next(), 10);
  else if (a === '--row') o.row = parseInt(next(), 10);
  else if (a === '--col') o.col = parseInt(next(), 10);
  else if (a === '--sample') o.sample = parseInt(next(), 10);
  else if (a === '--targeted') o.targeted = true;
  else if (a === '--seed') o.seed = parseInt(next(), 10);
  else if (a === '--levels') o.levels = next().split(',').map(Number);
  else if (a === '--deltaMax') o.deltaMax = parseFloat(next());
  else if (a === '--calibrate') o.calibrate = parseInt(next(), 10) || 60;
  else if (a === '--out') o.out = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (o.levels.includes(3)) {
  console.error('level 3 (MuPDF re-render) was retired with the Python tooling — ' +
    'see docs/MISSING_LETTER.md for its recorded results, tag python-era for the code');
  process.exit(2);
}
if (!o.source) o.source = join(dirname(o.pdf), basename(o.pdf).replace(/\.pdf$/i, '.txt'));

// ---------------- raster cache (node-side GRY1 reader) ----------------
function sha16(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}
function openCache(pdfPath) {
  const key = sha16(pdfPath);
  const dir = join(REPO, 'tools', 'raster-cache', key);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const pages = new Map();                                    // pno -> {w,h,gray}
  const order = [];
  return {
    key, numPages: meta.numPages,
    page(pno) {
      let pg = pages.get(pno);
      if (pg) return pg;
      const raw = gunzipSync(readFileSync(join(dir, `page-${String(pno).padStart(4, '0')}.gray.gz`)));
      const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
      if (hdr[0] !== 0x31595247) throw new Error(`bad GRY1 magic page ${pno}`);
      if (hdr[1] !== 1) throw new Error(`page ${pno}: mode ${hdr[1]} (byte-compare needs mode 1)`);
      pg = { w: hdr[2], h: hdr[3], gray: new Uint8Array(raw.buffer, raw.byteOffset + 16, hdr[2] * hdr[3]) };
      pages.set(pno, pg); order.push(pno);
      if (order.length > 60) pages.delete(order.shift());     // LRU-ish cap
      return pg;
    },
  };
}

// ---------------- source text (page split identical to dump-layout.mjs) ----------------
function loadSourcePages(path) {
  const raw = readFileSync(path, 'utf8').replace(/\r/g, '');
  const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
  let sep = 1;
  for (let i = ROW_COUNT; i < lines.length - 1; i += ROW_COUNT + 1)
    if (lines[i] !== '') { sep = 0; break; }
  const pages = [];
  for (let i = 0; i + 1 <= lines.length; i += ROW_COUNT + sep) {
    const pg = lines.slice(i, i + ROW_COUNT);
    if (!pg.length) break;
    while (pg.length < ROW_COUNT) pg.push('');
    pages.push(pg);
    if (i + ROW_COUNT >= lines.length) break;
  }
  return pages;
}

// ---------------- glyph set ----------------
// times16 out of the glyphs.bin bundle (tools/glyph-bundle.mjs), reshaped
// into this tool's ch -> phx map (phy=0 only: corpus baselines are integer)
function loadGlyphs() {
  const set = materializeSet('times16');
  const GS = new Map();
  for (const g of set.byPhy.get(0) ?? []) {
    const coreCols = [], inkCols = [];
    for (let c = 0; c < g.w; c++) {
      let mn = 255, ink = false;
      for (let rr = 0; rr < g.h; rr++) {
        const v = g.bytes[rr * g.w + c];
        if (v < mn) mn = v;
        if (v < 255) ink = true;
      }
      if (mn < 128) coreCols.push(c);
      if (ink) inkCols.push(c);
    }
    if (!GS.has(g.ch)) GS.set(g.ch, { adv: g.adv, ph: new Map() });
    GS.get(g.ch).ph.set(g.phx, { w: g.w, h: g.h, dx: g.dx, dy: g.dy, bytes: g.bytes, coreCols, inkCols });
  }
  return GS;
}
const rasterFor = (GS, ch, bucket) => {
  let penInt = Math.floor(bucket), phx = SNAP(bucket - penInt);
  if (phx === 1) { penInt += 1; phx = 0; }
  return { penInt, phx, ras: GS.get(ch).ph.get(phx) };
};

// blend law inverse: single-glyph gray on white -> possible e = cov + (cov>>7)
const INV = (() => {
  const inv = Array.from({ length: 256 }, () => []);
  for (let cov = 0; cov <= 255; cov++) {
    const e = cov + (cov >> 7);
    inv[(255 * (256 - e)) >> 8].push(e);
  }
  return inv.map(a => [...new Set(a)]);
})();

// ---------------- bucket locating (recover_pens recipe, + exclusions/mask) ----------------
// Byte-compare the glyph's strong-ink core columns against the page at each
// candidate ¼-px bucket near the ideal pen; a unique byte-exact hit reads off
// the drawn bucket. `exclude` = erased column set; `mask` = 1 where some other
// located glyph inks (retry pass tolerance for kern overlap).
function matchAt(page, ras, penInt, baseline, exclude, mask) {
  const { w, h, bytes, coreCols } = ras;
  const r0 = baseline + ras.dy, c0 = penInt + ras.dx;
  if (r0 < 0 || r0 + h > page.h || c0 < 0 || c0 + w > page.w) return null;
  let n = 0;
  for (const cc of coreCols) {
    const x = c0 + cc;
    if (exclude && exclude.has(x)) continue;
    for (let r = 0; r < h; r++) {
      const idx = (r0 + r) * page.w + x;
      if (mask && mask[idx]) continue;
      if (page.gray[idx] !== bytes[r * w + cc]) return null;
      n++;
    }
  }
  return n;
}
function locateGlyph(page, GS, ch, ideal, baseline, { exclude, mask, deltaMax }) {
  const hits = [];
  const b0 = SNAP(ideal);
  for (let k = -2; k <= 2; k++) {
    const b = SNAP(b0 + k * 0.25);
    const { penInt, ras } = rasterFor(GS, ch, b);
    if (!ras || !ras.bytes.length) continue;
    const n = matchAt(page, ras, penInt, baseline, exclude, mask);
    if (n === null) continue;
    const need = Math.max(4, Math.ceil(ras.coreCols.length * ras.h * 0.25));
    if (n >= need) hits.push({ b, n });
  }
  if (hits.length === 1) return { bucket: hits[0].b, d: ideal - hits[0].b, status: 'ok' };
  return { bucket: null, d: null, status: hits.length ? 'ambiguous' : 'nohit' };
}
// Locate every glyph of a row.  Pass 1: plain.  Pass 2: retry failures with a
// mask of the located glyphs' ink (kern-bleed tolerance).  Pass 3: for still-
// unpinned glyphs (mutual overlaps like W↔A, where both fail pass 1), also
// mask the PLAUSIBLE ink of the other unpinned glyphs (any bucket within
// ±0.5 px of their ideal pens) — compare only pixels no other glyph can touch.
function locateRow(page, GS, glyphs /*[{i,ch,pen}]*/, baseline, opts) {
  const res = glyphs.map(g => locateGlyph(page, GS, g.ch, g.pen, baseline, opts));
  if (!res.some(r => !r.bucket)) return res;
  const mask = new Uint8Array(page.w * page.h);
  const paintInk = (m, ch, bucket) => {
    const { penInt, ras } = rasterFor(GS, ch, bucket);
    const r0 = baseline + ras.dy, c0 = penInt + ras.dx;
    for (let rr = 0; rr < ras.h; rr++)
      for (let cc = 0; cc < ras.w; cc++)
        if (ras.bytes[rr * ras.w + cc] < 255) {
          const y = r0 + rr, x = c0 + cc;
          if (y >= 0 && y < page.h && x >= 0 && x < page.w) m[y * page.w + x] = 1;
        }
  };
  for (let gi = 0; gi < glyphs.length; gi++)
    if (res[gi].bucket) paintInk(mask, glyphs[gi].ch, res[gi].bucket);
  for (let gi = 0; gi < glyphs.length; gi++) {
    if (res[gi].bucket) continue;
    const r = locateGlyph(page, GS, glyphs[gi].ch, glyphs[gi].pen, baseline, { ...opts, mask });
    if (r.bucket) { res[gi] = { ...r, status: 'ok-masked' }; paintInk(mask, glyphs[gi].ch, r.bucket); }
  }
  const still = glyphs.map((g, gi) => gi).filter(gi => !res[gi].bucket);
  for (const gi of still) {
    const m3 = Uint8Array.from(mask);
    for (const gj of still) {
      if (gj === gi) continue;
      const b0 = SNAP(glyphs[gj].pen);
      for (let k = -2; k <= 2; k++) paintInk(m3, glyphs[gj].ch, SNAP(b0 + k * 0.25));
    }
    const r = locateGlyph(page, GS, glyphs[gi].ch, glyphs[gi].pen, baseline, { ...opts, mask: m3 });
    if (r.bucket) res[gi] = { ...r, status: 'ok-masked2' };
  }
  return res;
}

// ---------------- measureText server (Chrome canvas, same formula as dump-layout) ----------------
async function startMeasure(chromePath) {
  const browser = await puppeteer.launch({ executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '16px "Times New Roman"';
    const chW = new Map();
    const width = s => ctx.measureText(s).width;
    const chWidth = c => { let v = chW.get(c); if (v === undefined) { v = width(c); chW.set(c, v); } return v; };
    // pens (left edges) relative to startX 0 for every non-space char with
    // index >= from:  left_i = width(text[0..i+1)) - width(ch_i)
    window.__pens = (text, from) => {
      const out = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' || i < from) continue;
        out.push([i, width(text.slice(0, i + 1)) - chWidth(ch)]);
      }
      return out;
    };
  });
  const cache = new Map();
  return {
    browser,
    // jobs: [[text, from]] -> [[ [i,penRel], ... ]]
    async pens(jobs) {
      const missing = jobs.filter(([t, f]) => !cache.has(`${f}|${t}`));
      if (missing.length) {
        const got = await page.evaluate(js => js.map(([t, f]) => window.__pens(t, f)), missing);
        missing.forEach(([t, f], ix) => cache.set(`${f}|${t}`, got[ix]));
      }
      return jobs.map(([t, f]) => cache.get(`${f}|${t}`));
    },
  };
}

// ---------------- helpers ----------------
// buckets a drawn pen may occupy given ideal q and δ ∈ [0, deltaMax]
function bucketOptions(q, deltaMax) {
  const lo = q - deltaMax - EPS, hi = q + EPS;
  const out = [];
  let b = SNAP(Math.ceil((lo - 0.125) * 4) / 4);
  for (; b - 0.125 <= hi + 1e-12; b = SNAP(b + 0.25))
    if (b + 0.125 >= lo - 1e-12) out.push(b);
  return out;
}
const feasible = (ideal, bucket, deltaMax) =>
  ideal - bucket >= -0.125 - EPS && ideal - bucket <= 0.125 + deltaMax + EPS;

function inkColsAt(GS, ch, bucket) {
  const { penInt, ras } = rasterFor(GS, ch, bucket);
  return ras.inkCols.map(c => penInt + ras.dx + c);
}
function eraseCols(page, cols, baseline) {
  const g = new Uint8Array(page.gray);                      // copy
  const y0 = Math.max(0, baseline - MAX_ASC), y1 = Math.min(page.h, baseline + MAX_DESC + 1);
  for (const x of cols) if (x >= 0 && x < page.w)
    for (let y = y0; y < y1; y++) g[y * page.w + x] = 255;
  return { w: page.w, h: page.h, gray: g };
}
// possible composed pixel values at (x,y) for glyph parts in draw order
function composeVals(parts, x, y) {
  let vals = [255];
  for (const p of parts) {
    const c = x - p.c0, r = y - p.r0;
    if (c < 0 || c >= p.w || r < 0 || r >= p.h) continue;
    const g = p.bytes[r * p.w + c];
    if (g === 255) continue;
    const next = new Set();
    for (const v of vals) for (const e of INV[g]) next.add((v * (256 - e)) >> 8);
    vals = [...next];
    if (vals.length > 32) return null;                       // give up: treat as pass
  }
  return vals;
}
const partFor = (GS, ch, bucket, baseline) => {
  const { penInt, ras } = rasterFor(GS, ch, bucket);
  return { bytes: ras.bytes, w: ras.w, h: ras.h, r0: baseline + ras.dy, c0: penInt + ras.dx };
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- one trial ----------------
async function runTrial(ctx, pno, row, col, verbose) {
  const { cache, srcPages, GS, measure, alphabet, deltaMax, levels } = ctx;
  const text = srcPages[pno - 1]?.[row] ?? '';
  const baseline = ROW_BASE + ROW_PITCH * row + BASE_OFF;
  const truth = text[col];
  const T = { page: pno, row, col, truth, text, ok: false, cause: null,
    ctx: text.slice(Math.max(0, col - 3), col) + '·' + text.slice(col + 1, col + 4) };
  if (!truth || truth === ' ') { T.cause = 'col-not-a-glyph'; return T; }

  const [pensRel] = await measure.pens([[text, 0]]);
  const glyphs = pensRel.map(([i, p]) => ({ i, ch: text[i], pen: START_X + p }));
  const kk = glyphs.findIndex(g => g.i === col);
  if (kk <= 0 || kk >= glyphs.length - 1) { T.cause = 'not-mid-line'; return T; }
  const page = cache.page(pno);

  // ---- locate on the ORIGINAL page: true bucket (for the erasure masks) ----
  const loc0 = locateRow(page, GS, glyphs, baseline, { deltaMax });
  T.d = loc0.filter(r => r.bucket !== null).map(r => r.d);
  if (!loc0[kk].bucket) { T.cause = `true-bucket-${loc0[kk].status}`; return T; }
  const bTrue = loc0[kk].bucket;
  const { penInt: tPen, ras: tRas } = rasterFor(GS, truth, bTrue);
  const trueInk = inkColsAt(GS, truth, bTrue);
  const advW = GS.get(truth).adv;

  // ---- level-1 erasure: full advance window ∪ every true-ink column ----
  const holeLo = Math.min(Math.floor(bTrue), trueInk.length ? trueInk[0] : 1e9);
  const holeHi = Math.max(Math.ceil(bTrue + advW), trueInk.length ? trueInk.at(-1) + 1 : -1);
  const hole = new Set(); for (let x = holeLo; x < holeHi; x++) hole.add(x);
  T.hole = [holeLo, holeHi];
  const erased1 = eraseCols(page, hole, baseline);

  // candidate layouts (substitute at col, pens from k on; prefix pens are shared)
  const candTexts = alphabet.map(c => text.slice(0, col) + c + text.slice(col + 1));
  const candPens = await measure.pens(candTexts.map(t => [t, col]));
  const candSuffix = new Map();                       // ch -> Map(glyphIdx -> idealPen)
  alphabet.forEach((c, ix) => {
    const m = new Map();
    for (const [i, p] of candPens[ix]) m.set(i, START_X + p);
    candSuffix.set(c, m);
  });

  const suffixIdx = glyphs.map((g, gi) => gi).filter(gi => gi > kk);
  const runL1 = (obsPage, excl) => {
    const loc = locateRow(obsPage, GS, glyphs.filter((_, gi) => gi !== kk), baseline,
      { exclude: excl, deltaMax });
    const obs = new Map();                            // glyphIdx -> bucket
    loc.forEach((r, j) => { const gi = j < kk ? j : j + 1; if (r.bucket !== null) obs.set(gi, r.bucket); });
    const set = [];
    for (const c of alphabet) {
      const m = candSuffix.get(c);
      let okC = true;
      for (const gi of suffixIdx) {
        const b = obs.get(gi);
        if (b === undefined) continue;
        if (!feasible(m.get(glyphs[gi].i), b, deltaMax)) { okC = false; break; }
      }
      if (okC) set.push(c);
    }
    // feasible interval for q = pen of glyph kk+1 (phase-lock width metric)
    let y0 = -Infinity, y1 = Infinity, nObs = 0;
    const ref = candSuffix.get(alphabet[0]);
    const qRef = ref.get(glyphs[kk + 1]?.i);
    for (const gi of suffixIdx) {
      const b = obs.get(gi);
      if (b === undefined) continue;
      nObs++;
      const u = ref.get(glyphs[gi].i) - qRef;
      y0 = Math.max(y0, b - 0.125 - u);
      y1 = Math.min(y1, b + 0.125 + deltaMax - u);
    }
    return { set, obs, nObs, width: nObs ? y1 - y0 : Infinity };
  };

  if (levels.includes(1)) {
    const r1 = runL1(erased1, hole);
    T.A1 = r1.set; T.suffixObs = r1.nObs; T.width = r1.width;
    T.l1Gate = r1.set.includes(truth);
    if (!T.l1Gate) {
      T.cause = 'gate-L1-true-infeasible';
      // which suffix glyph contradicts the true layout? (styled row vs bad pin)
      const m = candSuffix.get(truth);
      T.gateDetail = suffixIdx.filter(gi => r1.obs.has(gi)).map(gi => {
        const r = m.get(glyphs[gi].i) - r1.obs.get(gi);
        return `${glyphs[gi].ch}@${r1.obs.get(gi)}:${r.toFixed(3)}${feasible(m.get(glyphs[gi].i), r1.obs.get(gi), deltaMax) ? '' : '✗'}`;
      });
      T.gateWorst = Math.max(...suffixIdx.filter(gi => r1.obs.has(gi))
        .map(gi => { const r = m.get(glyphs[gi].i) - r1.obs.get(gi);
          return Math.max(r - (0.125 + deltaMax), -0.125 - r); }));
    }
  }

  // ---- level 2: erase only columns where the true glyph's ink stands alone ----
  if (levels.includes(2) && !T.cause) {
    const otherInk = new Set();
    glyphs.forEach((g, gi) => {
      if (gi === kk) return;
      const b = loc0[gi].bucket;
      if (b !== null) for (const x of inkColsAt(GS, g.ch, b)) otherInk.add(x);
    });
    const cols2 = new Set(trueInk.filter(x => !otherInk.has(x)));
    T.hole2n = cols2.size;
    T.bleedCols = trueInk.length - cols2.size;   // true-ink cols shared with neighbour ink
    const erased2 = eraseCols(page, cols2, baseline);
    const r2 = runL1(erased2, cols2);
    // composite check over the slot neighbourhood, draw order = text order.
    // Parts are selected by COLUMN overlap with the compared region — an index
    // window misses e.g. a 'j' descender reaching in from 5 glyphs away.
    const regLo = holeLo - 24, regHi = holeHi + 24;
    const nearby = [];
    let unpinnedNear = 0;
    glyphs.forEach((g, gi) => {
      if (gi === kk) return;
      const b = loc0[gi].bucket;
      if (b === null) {
        if (Math.abs(g.pen - (holeLo + holeHi) / 2) < 40) unpinnedNear++;
        return;
      }
      if (inkColsAt(GS, g.ch, b).some(x => x >= regLo && x < regHi))
        nearby.push({ gi, part: partFor(GS, g.ch, b, baseline) });
    });
    const staticCols = new Set(trueInk);
    for (const { gi } of nearby) {
      const b = loc0[gi].bucket;
      for (const x of inkColsAt(GS, glyphs[gi].ch, b))
        if (x >= regLo && x < regHi) staticCols.add(x);
    }
    const yTop = Math.max(0, baseline - MAX_ASC), yBot = Math.min(page.h, baseline + MAX_DESC + 1);
    const testCand = (c) => {
      const q = candSuffix.get(c).get(col);
      for (const bc of bucketOptions(q, deltaMax)) {
        const parts = [];                              // draw order = text order
        let inserted = false;
        for (const { gi, part } of nearby) {
          if (!inserted && gi > kk) { parts.push(partFor(GS, c, bc, baseline)); inserted = true; }
          parts.push(part);
        }
        if (!inserted) parts.push(partFor(GS, c, bc, baseline));
        const cols = new Set(staticCols);
        for (const x of inkColsAt(GS, c, bc)) cols.add(x);
        let ok = true;
        for (const x of cols) {
          if (cols2.has(x) || x < 0 || x >= page.w) continue;
          for (let y = yTop; y < yBot && ok; y++) {
            const vals = composeVals(parts, x, y);
            if (vals && !vals.includes(erased2.gray[y * page.w + x])) {
              ok = false;
              if (process.env.GL_DEBUG && (c === truth || process.env.GL_DEBUG === '2'))
                console.log(`    L2 '${c}' mismatch @(${x},${y}) obs=${erased2.gray[y * page.w + x]} ` +
                  `pred={${vals.join(',')}} bc=${bc}`);
            }
          }
          if (!ok) break;
        }
        if (ok) return true;
      }
      return false;
    };
    if (unpinnedNear === 0) {
      T.A2 = r2.set.filter(testCand);
      T.l2Gate = T.A2.includes(truth);
      if (!T.l2Gate) T.l2Valid = false;   // level-2 gate failed; other levels stand
    } else { T.A2 = r2.set; T.l2Note = `bleed-skipped-${unpinnedNear}-unpinned-near`; T.l2Gate = r2.set.includes(truth); }
  }

  // (level 3 — MuPDF render-and-verify over A1 survivors — retired with the
  // Python tooling; recorded result: bounded by the advance lattice, ≈ L1.)

  T.ok = !T.cause;
  if (verbose) printTrial(T, glyphs, loc0, kk);
  return T;
}

function printTrial(T, glyphs, loc0, kk) {
  console.log(`\nP${T.page} L${T.row} col ${T.col}: erased '${T.truth}' in "${T.ctx}"`);
  console.log(`  text: ${T.text}`);
  const pins = loc0.map((r, gi) => r.bucket === null ? `${glyphs[gi].ch}:∅` : null).filter(Boolean);
  console.log(`  buckets: ${loc0.filter(r => r.bucket !== null).length}/${glyphs.length} pinned` +
    (pins.length ? ` (unpinned ${pins.join(' ')})` : ''));
  console.log(`  hole cols [${T.hole}] · suffix observations ${T.suffixObs} · feasible-interval width ${T.width?.toFixed(4)} px`);
  if (T.A1) console.log(`  L1 geometry : |A1|=${T.A1.length}  {${T.A1.join('')}}  true∈A1=${T.l1Gate}`);
  if (T.A2) console.log(`  L2 +bleed   : |A2|=${T.A2.length}  {${T.A2.join('')}}  ${T.l2Note ?? ''}`);
  if (T.cause) console.log(`  ✗ ${T.cause}`);
  if (T.gateDetail) console.log(`  gate residuals (ideal−bucket per suffix glyph): ${T.gateDetail.join(' ')}`);
}

// ---------------- calibrate: δ distribution + x0 phase-lock floor ----------------
// Two populations exist: REGULAR rows (drawn pens δ ∈ [0, ~0.03] below the
// measureText ideal) and STYLED rows (narrow drawn spaces / unmodeled layout —
// pens drift up to ±px mid-row; SYNTHETIC_DICT.md). Calibration reports them
// split per-row, exactly the way the benchmark's true-candidate gate splits
// trials. A row is 'regular' iff every pinned glyph has d ∈ [−0.13, 0.16].
async function calibrate(ctx, nRows) {
  const { cache, srcPages, GS, measure, deltaMax, skip } = ctx;
  const rng = mulberry32(o.seed);
  const ds = [], x0w = [], x0w0 = [], unpin = { nohit: 0, ambiguous: 0 };
  const styled = [];
  let x0lo = -Infinity, x0hi = Infinity, nGl = 0, nStyledGl = 0;
  for (let t = 0; t < nRows; t++) {
    const pno = 1 + Math.floor(rng() * Math.min(cache.numPages, srcPages.length));
    const row = Math.floor(rng() * ROW_COUNT);
    if (skip.has(`${pno}-${row}`)) { t--; continue; }
    const text = srcPages[pno - 1]?.[row] ?? '';
    if ([...text].filter(c => c !== ' ').length < 8) { t--; continue; }
    const [pensRel] = await measure.pens([[text, 0]]);
    const glyphs = pensRel.map(([i, p]) => ({ i, ch: text[i], pen: START_X + p, rel: p }));
    const baseline = ROW_BASE + ROW_PITCH * row + BASE_OFF;
    const page = cache.page(pno);
    const loc = locateRow(page, GS, glyphs, baseline, { deltaMax });
    const rowD = loc.filter(r => r.bucket !== null).map(r => r.d);
    nGl += glyphs.length;
    for (const r of loc) if (r.bucket === null) unpin[r.status] = (unpin[r.status] ?? 0) + 1;
    if (!rowD.length) continue;
    if (Math.min(...rowD) < -0.13 || Math.max(...rowD) > 0.16) {
      styled.push({ pno, row, dMin: Math.min(...rowD), dMax: Math.max(...rowD) });
      nStyledGl += glyphs.length;
      continue;                                   // regular-population stats below
    }
    ds.push(...rowD);
    let lo = -Infinity, hi = Infinity, lo0 = -Infinity, hi0 = Infinity, n = 0;
    loc.forEach((r, gi) => {
      if (r.bucket === null) return;
      n++;
      lo = Math.max(lo, r.bucket - 0.125 - glyphs[gi].rel);
      hi = Math.min(hi, r.bucket + 0.125 + deltaMax - glyphs[gi].rel);
      lo0 = Math.max(lo0, r.bucket - 0.125 - glyphs[gi].rel);
      hi0 = Math.min(hi0, r.bucket + 0.125 - glyphs[gi].rel);
    });
    if (n >= 5) {
      x0w.push(hi - lo); x0w0.push(hi0 - lo0);
      x0lo = Math.max(x0lo, lo); x0hi = Math.min(x0hi, hi);
    }
  }
  ds.sort((a, b) => a - b);
  const q = p => ds[Math.min(ds.length - 1, Math.floor(p * ds.length))];
  console.log(`\ncalibrate: ${nRows} rows sampled · ${styled.length} styled rows set aside ` +
    `(${nStyledGl} glyphs) · regular rows: ${ds.length}/${nGl - nStyledGl} glyphs pinned ` +
    `(${(100 * ds.length / (nGl - nStyledGl)).toFixed(2)}%) · unpinned nohit=${unpin.nohit} ambiguous=${unpin.ambiguous}`);
  if (styled.length) console.log(`  styled rows: ${styled.map(s =>
    `P${s.pno}L${s.row}[${s.dMin.toFixed(3)},${s.dMax.toFixed(3)}]`).join(' ')}`);
  console.log(`  regular d = ideal − bucket:  min ${q(0).toFixed(5)}  p1 ${q(0.01).toFixed(5)}  ` +
    `median ${q(0.5).toFixed(5)}  p99 ${q(0.99).toFixed(5)}  max ${ds.at(-1).toFixed(5)}`);
  console.log(`  ⇒ δ band implied: [${(-(q(0) + 0.125)).toFixed(5)} … ${(ds.at(-1) - 0.125).toFixed(5)}] px ` +
    `(--deltaMax ${deltaMax})`);
  console.log(`  outside [−0.125, 0.125+δmax]: ${ds.filter(d => d < -0.125 - EPS || d > 0.125 + deltaMax + EPS).length}`);
  x0w.sort((a, b) => a - b);
  const qw = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  console.log(`  per-row x0 feasible width (δ model): median ${qw(x0w, 0.5).toFixed(4)}  ` +
    `p10 ${qw(x0w, 0.1).toFixed(4)}  min ${x0w[0].toFixed(4)} px`);
  x0w0.sort((a, b) => a - b);
  console.log(`  per-row x0 width without δ (δ=0):    median ${qw(x0w0, 0.5).toFixed(4)}  ` +
    `p10 ${qw(x0w0, 0.1).toFixed(4)}  min ${x0w0[0].toFixed(4)} px  (<0 ⇒ δ>0 required)`);
  console.log(`  doc-level x0 ∈ [${x0lo.toFixed(4)}, ${x0hi.toFixed(4)}] ` +
    `width ${(x0hi - x0lo).toFixed(4)} px · contains 45.0: ${x0lo <= 45 && 45 <= x0hi}`);
}

// ---------------- batch ----------------
function aggregate(trials, level) {
  const key = `A${level}`;
  const use = trials.filter(t => t[key] && t.ok &&
    (level !== 2 || t.l2Valid !== false) && (level !== 3 || t.l3Valid !== false));
  const sizes = use.map(t => t[key].length).sort((a, b) => a - b);
  if (!use.length) return null;
  const unique = use.filter(t => t[key].length === 1 && t[key][0] === t.truth).length;
  const hist = {};
  for (const s of sizes) hist[s] = (hist[s] ?? 0) + 1;
  const classes = {};
  for (const t of use) {
    if (t[key].length > 1 && t[key].length <= 12) {
      const c = t[key].join('');
      classes[c] = (classes[c] ?? 0) + 1;
    }
  }
  return {
    n: use.length, unique, uniquePct: 100 * unique / use.length,
    meanSize: sizes.reduce((s, x) => s + x, 0) / use.length,
    medianSize: sizes[Math.floor(sizes.length / 2)],
    hist, topClasses: Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 12),
    truthIn: use.filter(t => t[key].includes(t.truth)).length,
  };
}

async function main() {
  if (!o.chrome || !existsSync(o.chrome)) { console.error('no Chrome found'); process.exit(1); }
  if (!existsSync(o.pdf)) { console.error(`no PDF: ${o.pdf}`); process.exit(1); }
  if (!existsSync(o.source)) { console.error(`no source txt: ${o.source}`); process.exit(1); }
  const GS = loadGlyphs();
  const cache = openCache(o.pdf);
  const srcPages = loadSourcePages(o.source);
  const skip = SKIP_ROWS[cache.key] ?? new Set();
  console.log(`${basename(o.pdf)}: ${cache.numPages} raster pages (key ${cache.key}), ` +
    `${srcPages.length} source pages, δmax ${o.deltaMax}, levels [${o.levels}]`);
  const measure = await startMeasure(o.chrome);
  const alphabet = [...GS.keys()];
  const ctx = { cache, srcPages, GS, measure, alphabet, deltaMax: o.deltaMax,
    levels: o.levels, skip };
  try {
    if (o.calibrate) { await calibrate(ctx, o.calibrate); return; }

    if (o.page && o.row >= 0 && o.col >= 0) {
      const T = await runTrial(ctx, o.page, o.row, o.col, true);
      if (!T.A1 && T.cause)   // dropped before inference — say why
        console.log(`P${o.page} L${o.row} col ${o.col} ('${T.truth ?? '?'}'): ✗ ${T.cause}`);
      return;
    }

    // ---- batch sampling ----
    const rng = mulberry32(o.seed);
    const nPages = Math.min(cache.numPages, srcPages.length);
    const trials = [];
    const seen = new Set();
    const eligibleKs = (text, targeted) => {
      const ks = [];
      const glyphIdx = [];
      for (let i = 0; i < text.length; i++) if (text[i] !== ' ') glyphIdx.push(i);
      for (let g = 1; g < glyphIdx.length - 1; g++) {
        const i = glyphIdx[g];
        if (!targeted) { ks.push(i); continue; }
        const pair1 = text[i - 1] + text[i], pair2 = text[i] + text[i + 1];
        if (NARROW.has(text[i]) || KERN_PAIRS.has(pair1) || KERN_PAIRS.has(pair2)) ks.push(i);
      }
      return ks;
    };
    let made = 0, attempts = 0;
    while (made < o.sample && attempts < o.sample * 60) {
      attempts++;
      const pno = 1 + Math.floor(rng() * nPages);
      const row = Math.floor(rng() * ROW_COUNT);
      if (skip.has(`${pno}-${row}`)) continue;
      const text = srcPages[pno - 1]?.[row] ?? '';
      if ([...text].filter(c => c !== ' ').length < 8) continue;
      const targeted = o.targeted && made % 2 === 0;
      const ks = eligibleKs(text, targeted);
      if (!ks.length) continue;
      const col = ks[Math.floor(rng() * ks.length)];
      const sig = `${pno}-${row}-${col}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const T = await runTrial(ctx, pno, row, col, false);
      T.targeted = targeted;
      trials.push(T);
      made++;
      if (made % 20 === 0) process.stderr.write(`\r  ${made}/${o.sample} trials`);
    }
    process.stderr.write(`\r  ${made}/${o.sample} trials\n`);

    // ---- report ----
    const bad = trials.filter(t => !t.ok);
    const causes = {};
    for (const t of bad) causes[t.cause] = (causes[t.cause] ?? 0) + 1;
    console.log(`\n${trials.length} trials, ${trials.length - bad.length} clean, ` +
      `${bad.length} excluded by cause: ${JSON.stringify(causes)}`);
    const l2bad = trials.filter(t => t.ok && t.l2Valid === false).length;
    if (l2bad) console.log(
      `per-level gate failures (level excluded, trial kept): L2 ${l2bad}`);
    const widths = trials.filter(t => t.ok && isFinite(t.width)).map(t => t.width).sort((a, b) => a - b);
    if (widths.length) {
      const qw = p => widths[Math.min(widths.length - 1, Math.floor(p * widths.length))];
      console.log(`feasible-interval width (px): min ${qw(0).toFixed(4)} p10 ${qw(0.1).toFixed(4)} ` +
        `median ${qw(0.5).toFixed(4)} p90 ${qw(0.9).toFixed(4)} max ${qw(1).toFixed(4)}`);
    }
    for (const lvl of o.levels) {
      const a = aggregate(trials, lvl);
      if (!a) continue;
      console.log(`\nLEVEL ${lvl}: n=${a.n}  unique ${a.unique}/${a.n} (${a.uniquePct.toFixed(1)}%)  ` +
        `truth∈set ${a.truthIn}/${a.n}  |set| mean ${a.meanSize.toFixed(2)} median ${a.medianSize}`);
      console.log(`  size histogram: ${Object.entries(a.hist).map(([k, v]) => `${k}:${v}`).join(' ')}`);
      if (a.topClasses.length)
        console.log(`  top ambiguity sets: ${a.topClasses.map(([c, n]) => `{${c}}×${n}`).join('  ')}`);
      if (lvl >= 2) {   // bleed availability decides how much levels 2/3 can add
        for (const [tag, pred] of [['bleed>0', t => t.bleedCols > 0], ['no-bleed', t => t.bleedCols === 0]]) {
          const s = aggregate(trials.filter(pred), lvl);
          if (s) console.log(`  ${tag}: n=${s.n} unique ${(s.uniquePct).toFixed(1)}% mean |set| ${s.meanSize.toFixed(2)}`);
        }
      }
    }
    const fails = bad.slice(0, 20).map(t => `P${t.page} L${t.row} c${t.col} '${t.truth}' ${t.cause}`);
    if (fails.length) console.log(`\nexcluded examples:\n  ${fails.join('\n  ')}`);
    if (o.out) {
      writeFileSync(o.out, JSON.stringify({ pdf: basename(o.pdf), deltaMax: o.deltaMax,
        seed: o.seed, targeted: o.targeted, trials }, null, 1));
      console.log(`\nwrote ${o.out}`);
    }
  } finally {
    await measure.browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

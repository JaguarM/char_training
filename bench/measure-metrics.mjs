// measure-metrics.mjs — measure, per template, the RANGE of subpixel positions at which it
// gets used across the whole document — plus its ANCHOR: the fractional displacement
// (matchColumn − x0) between where its crop matches and the glyph's layout position —
// and write it to ../templates/template_metrics.json.
// reader.js consumes that file (when its fontSpec matches the app's) to PLACE each next
// glyph from the previous one's measured advance + anchor, so regenerate it after
// adding, cutting, or deleting templates.
//
//   node measure-metrics.mjs            # whole document (every page)
//   node measure-metrics.mjs --page 4   # one page only
//   node measure-metrics.mjs --out ../templates/template_metrics.json
//
// Why a whole-document pass: the automated reader (reader.js) matches purely on the integer
// pixel grid — cellLeft is always an integer column, so it carries NO subpixel. Subpixel
// only exists in the font-layout math, charX = startX + measureText(text).width, i.e. the
// box.x0 that boxesForRow produces. A glyph's subpixel is box.x0 - floor(box.x0); a template
// only renders in ~6 subpixel buckets, so its [min,max] over the whole document tells you
// exactly where-in-a-pixel it gets used (and which "harmless duplicates" cover the same
// bucket). The per-row anchor is an integer (autoAnchorRows), so the measured subpixel is
// the within-line layout fraction; frac is invariant to integer drift in box.x0, so only
// fractional kerning drift in a long line adds a little noise to the extremes.
//
// Same scaffold as trace-templates.mjs (../launch.py + headless Chrome), loading the
// templates a second time keeping each filename so a match can be attributed to its file.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, relative } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function parseArgs(argv) {
  const o = { pdf: findPdf(REPO), page: null, all: true, startX: 45, autoAnchor: false,
    out: resolve(REPO, 'templates', 'template_metrics.json'),
    chrome: process.env.CHROME || findChrome() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
    else if (a === '--page') { o.page = parseInt(next(), 10); o.all = false; }
    else if (a === '--all') o.all = true;
    else if (a === '--startX') o.startX = parseFloat(next());
    else if (a === '--autoanchor') o.autoAnchor = true;
    else if (a === '--out') o.out = resolve(process.cwd(), next());
    else if (a === '--chrome') o.chrome = next();
  }
  return o;
}

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function startServer(port) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  return spawn(py, ['launch.py', '--no-browser', '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
}
async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/api/templates`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

// Runs once in the page: load templates WITH filenames, parse the PDF, stash on window.
// Returns the page count plus the font context the metrics are measured under.
async function setupInPage({ pdfUrl }) {
  const cfg = new Config();
  const viewer = new CanvasViewer(
    document.getElementById('canvas'), document.getElementById('canvas-wrap'),
    document.getElementById('info'), cfg);
  viewer.render = () => {}; viewer.rebuildBoxes = () => {};

  const manifest = await (await fetch('/api/templates')).json();
  const loadGray = (url, char, filename) => new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data, n = c.width * c.height;
      const px = new Float32Array(n);
      for (let i = 0; i < n; i++) px[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
      res({ filename, char, w: c.width, h: c.height, pixels: px });
    };
    img.onerror = () => res(null);
    img.src = url;
  });
  const tpls = (await Promise.all(manifest.map(({ filename, char }) =>
    loadGray(`/templates/${filename}`, char, filename)))).filter(Boolean);

  if (!await viewer._loadTemplatesFromHTTP()) throw new Error('no templates loaded');
  // The engine auto-loads any existing template_metrics.json and the reader would then
  // PLACE glyphs from it — the very numbers this tool regenerates. Strip them so the
  // measurement is a clean, unguided read, not a readback of the previous run.
  viewer.engine.applyMetrics(null);
  const ab = await (await fetch(pdfUrl)).arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  window.__m = { viewer, pdf, tpls };
  return { numPages: pdf.numPages, fontSpec: cfg.fontSpec, fontSize: cfg.fontSize };
}

// Runs per page. OCR each row, lay it out with boxesForRow (the only source of subpixel),
// attribute each glyph to its template file(s) by pixel-exact compare, and accumulate the
// per-template subpixel/edge min-max + count. Returns a plain object keyed by filename so
// the caller can merge pages.
async function measurePageInPage({ pno, startX, autoAnchor }) {
  const { viewer, pdf, tpls } = window.__m;
  const page = await pdf.getPage(pno);
  const imgs = await extractEmbeddedImages(page);
  if (!imgs.length) return { perTemplate: {}, unattributed: 0 };
  let canvas = imgs[0];
  for (const c of imgs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
  viewer.img = canvas;
  viewer.rowBands = viewer.config.makeRowBands();
  viewer.resetLine();
  // Every source line starts at the same x, so anchor all rows to that fixed origin: the
  // subpixel (frac of box.x0 = charX from the anchor) is then measured from one consistent
  // reference across the whole document. Per-line auto-anchor (first-ink column) instead
  // shifts the origin by each line's first-glyph left bearing, smearing the ranges.
  if (autoAnchor) viewer.autoAnchorRows();
  else for (let r = 0; r < viewer.rowBands.length; r++) viewer.rowStartX[r] = startX;

  // Probe offsets, nearest first: 0, ±1, ±2 … ±PROBE. Some templates were cut off the
  // advance column (a column or two of blank/neighbour before the ink), so their exact
  // match lands off the predicted column — the window catches them. The integer offset
  // never changes the recorded subpixel (frac is shift-invariant), so widening only
  // reduces misses.
  const PROBE = 12;
  const OFFSETS = [0];
  for (let k = 1; k <= PROBE; k++) OFFSETS.push(k, -k);
  const tplsByChar = new Map();
  for (const t of tpls) {
    let g = tplsByChar.get(t.char);
    if (!g) tplsByChar.set(t.char, g = []);
    g.push(t);
  }
  // EVERY (template, offset) pair of the char that matches anywhere in the window —
  // NOT first-offset-with-any-match. Same-char templates are usually shadow variants
  // cut a column apart (l_3 matches at d=-1 wherever l_4 matches at d=0): first-offset-
  // wins would let the d=0 cut shadow the others on every clean instance, leaving the
  // shadowed template's samples to come only from mis-predicted rows. A template that
  // matches at SEVERAL adjacent columns of one instance (its ink sliding under a narrow
  // cut) is reported at each — that real ambiguity must land in its anchor range. One
  // crop as wide as the char's widest template serves all of them per offset (compared
  // with a row stride), so the exhaustive window costs about what the early-exit scan
  // did.
  // maxAway: only credit matches within half the char's advance of its layout x0 —
  // any farther and the pixels found are the NEIGHBOUR instance of the same char
  // ("aaa…"), which would smear the anchor by ±advance.
  const matchesFor = (char, col, y0, maxAway) => {
    const list = tplsByChar.get(char);
    if (!list) return [];
    const found = [];
    let maxW = 0, hs = new Set();
    for (const t of list) { if (t.w > maxW) maxW = t.w; hs.add(t.h); }
    for (const d of OFFSETS) {
      if (Math.abs(d) > maxAway + 0.5) continue;
      for (const h of hs) {
        const wide = viewer.engine.cropPixels(canvas, col + d + TEMPLATE_LEFT_CROP, y0, maxW, h);
        for (const t of list) {
          if (t.h !== h) continue;
          let ok = true;
          for (let r = 0; r < t.h && ok; r++) {
            const wOff = r * maxW, tOff = r * t.w;
            for (let c = 0; c < t.w; c++)
              if (wide[wOff + c] !== t.pixels[tOff + c]) { ok = false; break; }
          }
          if (ok) found.push({ t, d });
        }
      }
    }
    return found;
  };

  const advance = {}; // char -> canvas advance width (measured once)
  const perTemplate = {};
  let unattributed = 0;

  // Collect every subpixel the template is used at (raw samples); the caller reduces them
  // to a wraparound-safe circular range. min/max in [0,1) is wrong: a bucket sitting on the
  // pixel boundary lands samples at both ~0.02 and ~0.98 and looks like the full range.
  // anchor = matchColumn − x0: the template's match column as a FRACTIONAL displacement
  // from the glyph's layout x0. One real number per sample — rounding-free (a bucket
  // straddling frac 0.5 flips round(x0) between instances, so an integer "offset from
  // round(x0)" flip-flops even though the template sits still). Clusters tightly for a
  // well-behaved template; its spread is the template's true positional ambiguity.
  const bump = (t, subpixel, anchor) => {
    let m = perTemplate[t.filename];
    if (!m) {
      advance[t.char] ??= viewer._measureCtx().measureText(t.char).width;
      m = perTemplate[t.filename] = { char: t.char, width: t.w, advanceWidth: advance[t.char], samples: [], anchors: [] };
    }
    m.samples.push(subpixel);
    m.anchors.push(anchor);
  };

  for (let r = 0; r < viewer.rowBands.length; r++) {
    viewer.ocrRow(r);
    for (const box of viewer.boxesForRow(r)) {
      if (box.char === ' ' || box.char === PLACEHOLDER) continue;
      // Kern-correct left edge: box.x1 = startX + measureText(text[0..i+1]) already carries
      // the kern between this glyph and its left neighbour (Ve, Vp, Aj…); subtracting the
      // glyph's own isolated advance backs out to where its left edge actually sits. Plain
      // box.x0 (= measureText of the prefix only) omits that kern and drifts a px right.
      advance[box.char] ??= viewer._measureCtx().measureText(box.char).width;
      const x0 = box.x1 - advance[box.char];
      const subpixel = x0 - Math.floor(x0);
      const col = Math.round(x0);
      const maxAway = advance[box.char] / 2;
      const hits = matchesFor(box.char, col, box.y0, maxAway);
      let any = false;
      for (const { t, d } of hits) {
        const anchor = col + d - x0;
        if (Math.abs(anchor) > maxAway) continue; // the neighbour instance, not this one
        bump(t, subpixel, anchor);
        any = true;
      }
      if (!any) unattributed++;
    }
  }
  return { perTemplate, unattributed };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.chrome || !existsSync(opts.chrome)) { console.error('No Chrome'); process.exit(1); }
  if (!opts.pdf || !existsSync(opts.pdf)) { console.error(`No PDF in ${REPO}`); process.exit(1); }

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = startServer(port);
  let browser;
  const cleanup = () => { try { browser?.close(); } catch {} try { server.kill(); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  // filename -> merged { char, width, advanceWidth, samples: [subpixel…] }
  const merged = new Map();
  let unattributed = 0;

  // Wraparound-safe range of subpixels on the unit circle: the samples of one template form
  // a contiguous arc (its bucket), so the range is the whole circle minus its largest empty
  // gap. Returns the arc [lo, hi] (hi may exceed 1 when the bucket straddles the pixel edge,
  // e.g. [0.93, 1.07]), its width, and centre — a tight width confirms a real bucket.
  const circularRange = (samples) => {
    const s = samples.slice().sort((a, b) => a - b);
    const n = s.length;
    if (n === 1) return { lo: s[0], hi: s[0], width: 0, center: s[0] };
    let maxGap = (s[0] + 1) - s[n - 1], gi = n - 1; // start with the wrap gap (last → first)
    for (let i = 1; i < n; i++) { const g = s[i] - s[i - 1]; if (g > maxGap) { maxGap = g; gi = i - 1; } }
    // Bucket = complement of the largest gap. If that gap is the wrap gap the bucket doesn't
    // wrap (lo=first, hi=last); an interior gap means the bucket wraps the pixel edge.
    const lo = gi === n - 1 ? s[0] : s[gi + 1];
    const hi = gi === n - 1 ? s[n - 1] : s[gi] + 1;
    let center = (lo + hi) / 2; if (center >= 1) center -= 1;
    return { lo, hi, width: 1 - maxGap, center };
  };
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: opts.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}/training.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof CanvasViewer !== 'undefined' && typeof extractEmbeddedImages !== 'undefined' &&
        typeof window.pdfjsLib !== 'undefined', { timeout: 15000 });
    page.setDefaultTimeout(300000);

    const { numPages, fontSpec, fontSize } =
      await page.evaluate(setupInPage, { pdfUrl: `${base}/${relative(REPO, opts.pdf).replace(/\\/g, '/')}` });
    const pages = opts.all ? Array.from({ length: numPages }, (_, i) => i + 1) : [opts.page];

    for (const pno of pages) {
      const { perTemplate, unattributed: u } =
        await page.evaluate(measurePageInPage, { pno, startX: opts.startX, autoAnchor: opts.autoAnchor });
      unattributed += u;
      for (const [filename, m] of Object.entries(perTemplate)) {
        const g = merged.get(filename);
        if (!g) { merged.set(filename, m); continue; }
        for (const v of m.samples) g.samples.push(v);
        for (const v of m.anchors) g.anchors.push(v);
      }
      process.stderr.write(`\r  ${pno}/${pages[pages.length - 1]} pages`);
    }
    if (errors.length) console.error('\nbrowser errors:', errors.join('\n'));

    const round3 = x => Math.round(x * 1000) / 1000;
    const templates = [...merged.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([filename, m]) => {
        const r = circularRange(m.samples);
        // The template's anchor: centre and spread of (matchColumn − x0) over its
        // matches — reduced over the CORE cluster (within ±0.5 of the median), so a
        // handful of one-column slides or junk rows out of thousands can't blow the
        // range up and cost the template its position powers. anchorShare is the core's
        // weight; anchorRange the core's spread — near the bucket width for a clean
        // cut. The reader inverts the centre (x0 = column − anchor) and only trusts
        // templates whose range is tight.
        m.anchors.sort((a, b) => a - b);
        const med = m.anchors[m.anchors.length >> 1];
        let aLo = Infinity, aHi = -Infinity, core = 0;
        for (const a of m.anchors) {
          if (Math.abs(a - med) > 0.5) continue;
          core++; if (a < aLo) aLo = a; if (a > aHi) aHi = a;
        }
        return {
          filename, char: m.char, width: m.width, advanceWidth: round3(m.advanceWidth),
          anchor: round3((aLo + aHi) / 2), anchorRange: round3(aHi - aLo),
          anchorShare: round3(core / m.anchors.length),
          count: m.samples.length,
          subpixelCenter: round3(r.center), subpixelWidth: round3(r.width),
          subpixelLo: round3(r.lo), subpixelHi: round3(r.hi),
        };
      });
    const out = {
      generated: new Date().toISOString(), pdf: basename(opts.pdf),
      pages: opts.all ? numPages : 1, fontSpec, fontSize, templateLeftCrop: 1,
      anchor: opts.autoAnchor ? 'auto (first ink per line)' : opts.startX,
      unattributed, templates,
    };
    writeFileSync(opts.out, JSON.stringify(out, null, 2));
    const insts = templates.reduce((s, t) => s + t.count, 0);
    process.stderr.write(`\n${templates.length} templates measured, ${insts} instances, ${unattributed} unattributed\n`);
    process.stderr.write(`wrote ${opts.out}\n`);
  } catch (err) {
    console.error(`failed: ${err.message}`);
    process.exitCode = 1;
  } finally { cleanup(); }
}
main();

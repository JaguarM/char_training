// ocr-bench.mjs — headless speed benchmark for the OCR "OCR Page" path.
//
// Runs the REAL ocr.js (TemplateEngine.matchAt / cropPixels) and reader.js
// (ocrRow / _nextInk whitespace scan) in headless Chrome against a real page of
// a real PDF, then attributes the wall time to the exact leaf operations
// (getImageData, pixelsEqual, gray, the std-dev gap test, canvas draw) and maps
// each back to a file:line — so you can see which code to fix and re-measure
// after changing it.
//
// It does NOT need the app's manual setup: it loads the served templates, loads
// the PDF page raster through the same pdf.js path the app uses, and auto-anchors
// every row to its first inked column. Layout (row bands + font) defaults to the
// app's Config; pass --rowBase/--rowHeight/--rowPitch/--rowCount/--fontSize to
// match the settings you actually use in the UI for the most representative work.
//
//   node ocr-bench.mjs                         # default PDF + page 1
//   node ocr-bench.mjs --pdf ../foo.pdf --page 2 --runs 7
//   node ocr-bench.mjs --rowCount 60 --rowPitch 17 --fontSize 15.5
//   node ocr-bench.mjs --json                  # machine-readable, for regression diffs
//
// Requires: a local Chrome/Edge (auto-detected; override with --chrome <path>),
// python on PATH (to serve the app via ../launch.py), and internet (pdf.js loads
// from a CDN, same as the app).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, relative } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf, suppressAppInit } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    pdf: findPdf(REPO),
    page: 1,
    runs: 5,
    autoAnchor: true,
    json: false,
    chrome: process.env.CHROME || findChrome(),
    config: {}, // rowBase, rowHeight, rowPitch, rowCount, fontSize, fontFamily, startX
  };
  const num = new Set(['rowBase', 'rowHeight', 'rowPitch', 'rowCount', 'fontSize', 'startX']);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
    else if (a === '--page') o.page = parseInt(next(), 10);
    else if (a === '--runs') o.runs = parseInt(next(), 10);
    else if (a === '--chrome') o.chrome = next();
    else if (a === '--no-autoanchor') o.autoAnchor = false;
    else if (a === '--json') o.json = true;
    else if (a === '--fontFamily') o.config.fontFamily = next();
    else if (a.startsWith('--') && num.has(a.slice(2))) o.config[a.slice(2)] = parseFloat(next());
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(2); }
  }
  return o;
}

function printHelp() {
  console.log(`Usage: node ocr-bench.mjs [options]
  --pdf <path>        PDF to OCR            (default: newest *.pdf in repo root)
  --page <n>          1-based page number   (default: 1)
  --runs <n>          timed iterations      (default: 5)
  --rowBase/--rowHeight/--rowPitch/--rowCount/--fontSize/--startX <n>
                      override the layout Config (match your UI settings)
  --fontFamily <s>    font family           (default: Times New Roman)
  --no-autoanchor     keep Config.startX instead of auto-detecting line starts
  --chrome <path>     browser executable    (default: auto-detect / $CHROME)
  --json              print JSON instead of a report`);
}

// ---------------------------------------------------------------------------
// Local server (reuse the app's launch.py so /api/templates and the PDF are served)
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function startServer(port) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const proc = spawn(py, ['launch.py', '--no-browser', '--port', String(port)],
    { cwd: REPO, stdio: 'ignore' });
  return proc;
}

async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/templates`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

// ---------------------------------------------------------------------------
// The in-page benchmark. Runs in the page's main world, so it can use the
// app's globals: Config, CanvasViewer, extractEmbeddedImages, pdfjsLib, and the
// core.js pixel helpers (gray, pixelsEqual, isBlankPixels) attached to window.
// ---------------------------------------------------------------------------
async function pageBenchmark(opts) {
  // --- layout config -------------------------------------------------------
  const cfg = new Config();
  for (const k of ['rowBase', 'rowHeight', 'rowPitch', 'rowCount', 'fontSize', 'fontFamily', 'startX'])
    if (opts.config[k] != null) cfg[k] = opts.config[k];

  const viewer = new CanvasViewer(
    document.getElementById('canvas'),
    document.getElementById('canvas-wrap'),
    document.getElementById('info'),
    cfg,
  );

  // --- templates -----------------------------------------------------------
  const nTpl = await viewer._loadTemplatesFromHTTP();
  if (!nTpl) throw new Error('no templates loaded from /api/templates');
  const sizes = viewer.engine._sizes.size;

  // --- PDF page raster (same path as the app) ------------------------------
  const ab = await (await fetch(opts.pdfUrl)).arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  if (opts.page < 1 || opts.page > pdf.numPages)
    throw new Error(`page ${opts.page} out of range (1..${pdf.numPages})`);
  const page = await pdf.getPage(opts.page);
  const imgs = await extractEmbeddedImages(page);
  if (!imgs.length) throw new Error(`no embedded image on page ${opts.page}`);
  let canvas = imgs[0];
  for (const c of imgs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;

  viewer.loadCanvas(canvas, 'bench'); // auto-anchors every row to its first inked column
  viewer.applySettings();

  // --- anchoring: loadCanvas already auto-anchored against the default bands; re-anchor
  // against the final (post-applySettings) bands, or restore Config.startX if disabled.
  if (opts.autoAnchor) viewer.autoAnchorRows();
  else for (let r = 0; r < viewer.rowBands.length; r++) viewer.rowStartX[r] = cfg.startX;

  // --- instrumentation -----------------------------------------------------
  // Wrap the hot operations to count calls + accumulate time. We wrap leaf ops
  // (getImageData, gray, pixelsEqual, the std-dev gap test) so their times are
  // mutually exclusive and sum to ~the wall time; plus the composite methods
  // (cropPixels, matchAt, isBlank) and the reader scan helpers for call volume.
  const C = {};
  const mk = () => ({ calls: 0, ms: 0, work: 0 });
  function timeMethod(obj, name, key, work) {
    C[key] = mk();
    const orig = obj[name];
    obj[name] = function (...a) {
      const c = C[key]; c.calls++;
      if (work) c.work += work(a);
      const t = performance.now();
      const r = orig.apply(this, a);
      c.ms += performance.now() - t;
      return r;
    };
    return () => { obj[name] = orig; };
  }
  function timeGlobal(name, key, work) {
    C[key] = mk();
    const orig = window[name];
    window[name] = function (...a) {
      const c = C[key]; c.calls++;
      if (work) c.work += work(a);
      const t = performance.now();
      const r = orig.apply(this, a);
      c.ms += performance.now() - t;
      return r;
    };
    return () => { window[name] = orig; };
  }

  const eng = viewer.engine;
  const restore = [
    // leaf: canvas readback (the prime suspect), work = pixels read (w*h)
    timeMethod(eng._ctx, 'getImageData', 'getImageData', a => a[2] * a[3]),
    // leaf: RGBA→gray over the crop, work = pixels
    timeGlobal('gray', 'gray', a => a[1]),
    // leaf: template pixel compare, work = elements (upper bound; loop may early-exit)
    timeGlobal('pixelsEqual', 'pixelsEqual', a => a[0].length),
    // leaf: std-dev gap test (mean + L2), work = pixels
    timeGlobal('isBlankPixels', 'isBlankPixels', a => a[0].length),
    // composite: one grayscale crop (resize/clear/draw + getImageData + gray)
    timeMethod(eng, 'cropPixels', 'cropPixels'),
    // composite: match one position (size-group loop + pixelsEqual)
    timeMethod(viewer, 'matchAt', 'matchAt'), // moved from the engine to the viewer (training.js)
    // composite: blank-cell test (cropPixels + isBlankPixels)
    timeMethod(eng, 'isBlank', 'isBlank'),
    // reader scan helpers (call volume; ms is inclusive of isBlank/matchAt)
    timeMethod(viewer, '_nextInk', 'nextInk'),
    timeMethod(viewer, '_matchNear', 'matchNear'),
  ];
  const reset = () => { for (const k in C) { C[k].calls = 0; C[k].ms = 0; C[k].work = 0; } };
  const snapshot = () => JSON.parse(JSON.stringify(C));

  // mirror ocrAllRows but skip rebuildBoxes/render so we time only ocr.js+reader.js
  const runPage = () => { for (let r = 0; r < viewer.rowBands.length; r++) viewer.ocrRow(r); };

  // --- warm up, then timed runs -------------------------------------------
  runPage();
  const iters = [];
  for (let i = 0; i < opts.runs; i++) {
    reset();
    const t0 = performance.now();
    runPage();
    const wallMs = performance.now() - t0;
    iters.push({ wallMs, counters: snapshot() });
  }
  for (const r of restore) r();

  // --- describe the result (from the final run) ----------------------------
  let chars = 0, rowsWithText = 0, placeholders = 0;
  const sampleRows = [];
  for (let r = 0; r < viewer.rowBands.length; r++) {
    const t = viewer.rowText[r] || '';
    if (t) rowsWithText++;
    chars += t.length;
    if (t.includes('□')) placeholders++;
    if (sampleRows.length < 6 && t) sampleRows.push(t.slice(0, 60));
  }

  return {
    meta: {
      templates: nTpl, sizeGroups: sizes,
      pageW: canvas.width, pageH: canvas.height,
      rows: viewer.rowBands.length, rowsWithText, chars, placeholders,
      autoAnchor: opts.autoAnchor,
      config: { rowBase: cfg.rowBase, rowHeight: cfg.rowHeight, rowPitch: cfg.rowPitch,
        rowCount: cfg.rowCount, fontFamily: cfg.fontFamily, fontSize: cfg.fontSize },
      sampleRows,
    },
    iters,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = x => `${x.toFixed(1).padStart(8)} ms`;
const pct = (x, t) => `${(t ? (100 * x / t) : 0).toFixed(1).padStart(5)}%`;
const n = x => x.toLocaleString('en-US');

function report(res) {
  const m = res.meta;
  const walls = res.iters.map(i => i.wallMs);
  const medWall = median(walls);
  // pick the iteration closest to the median wall for a coherent breakdown
  const pick = res.iters.reduce((b, i) =>
    Math.abs(i.wallMs - medWall) < Math.abs(b.wallMs - medWall) ? i : b, res.iters[0]);
  const C = pick.counters;
  const w = pick.wallMs;

  // mutually-exclusive leaves: cropPixels' own overhead is its time minus the
  // getImageData + gray it contains.
  const cropOverhead = Math.max(0, C.cropPixels.ms - C.getImageData.ms - C.gray.ms);
  const leaves = [
    ['getImageData  (canvas readback)', C.getImageData.ms, C.getImageData.calls, `${(C.getImageData.work / 1e6).toFixed(1)} Mpx read`, 'ocr.js:83'],
    ['pixelsEqual   (template compare)', C.pixelsEqual.ms, C.pixelsEqual.calls, `${(C.pixelsEqual.work / 1e6).toFixed(1)} M elem`, 'ocr.js:92, core.js:62'],
    ['gray          (RGBA → gray)', C.gray.ms, C.gray.calls, `${(C.gray.work / 1e6).toFixed(1)} Mpx`, 'core.js:39'],
    ['isBlankPixels (std-dev gap test)', C.isBlankPixels.ms, C.isBlankPixels.calls, `${(C.isBlankPixels.work / 1e6).toFixed(1)} Mpx`, 'core.js:57, reader.js:39'],
    ['cropPixels    (canvas draw/clear)', cropOverhead, C.cropPixels.calls, 'resize+clear+drawImage', 'ocr.js:77'],
  ];
  const attributed = leaves.reduce((s, l) => s + l[1], 0);
  const other = Math.max(0, w - attributed);

  const L = [];
  L.push('');
  L.push(`OCR Page speed — ${m.rows} rows, ${n(m.chars)} chars read (${m.rowsWithText} non-empty, ${m.placeholders} stopped on □)`);
  L.push(`Page ${m.pageW}×${m.pageH}px · ${m.templates} templates in ${m.sizeGroups} size groups · auto-anchor ${m.autoAnchor ? 'on' : 'off'}`);
  L.push(`Layout: rowCount=${m.config.rowCount} rowBase=${m.config.rowBase} rowHeight=${m.config.rowHeight} rowPitch=${m.config.rowPitch} font="${m.config.fontFamily}" ${m.config.fontSize}px`);
  L.push('');
  L.push(`Wall time per OCR Page (ocr.js + reader.js only, no render):`);
  L.push(`  runs: ${walls.map(x => x.toFixed(0)).join(', ')} ms   →   median ${medWall.toFixed(1)} ms   (min ${Math.min(...walls).toFixed(1)}, max ${Math.max(...walls).toFixed(1)})`);
  L.push('');
  L.push(`Where the time goes (median run, ${w.toFixed(1)} ms — leaves are exclusive and sum to wall):`);
  L.push(`  ${'operation'.padEnd(34)} ${'time'.padStart(11)}  ${'share'.padStart(6)}  ${'calls'.padStart(11)}  detail`);
  for (const [name, t, calls, detail, loc] of leaves)
    L.push(`  ${name.padEnd(34)} ${ms(t)}  ${pct(t, w)}  ${n(calls).padStart(11)}  ${detail}  [${loc}]`);
  L.push(`  ${'(reader loop / measureText / glue)'.padEnd(34)} ${ms(other)}  ${pct(other, w)}`);
  L.push('');
  L.push(`Call volume (median run) — what drives the work:`);
  L.push(`  cropPixels (= getImageData) : ${n(C.cropPixels.calls).padStart(9)}   one canvas readback each      [ocr.js:77]`);
  L.push(`  matchAt    (per position)   : ${n(C.matchAt.calls).padStart(9)}   ×${m.sizeGroups} getImageData + template loop  [ocr.js:89]`);
  L.push(`  isBlank    (gap probes)     : ${n(C.isBlank.calls).padStart(9)}   driven by _nextInk column scan [ocr.js:99]`);
  L.push(`  _nextInk   (whitespace scan): ${n(C.nextInk.calls).padStart(9)}   steps 1px at a time           [reader.js:39]`);
  L.push(`  _matchNear (±${''}search)        : ${n(C.matchNear.calls).padStart(9)}                                 [reader.js:50]`);
  L.push('');
  L.push(`Hot spots to fix (ranked):`);
  const ranked = [...leaves].filter(l => l[1] > 0).sort((a, b) => b[1] - a[1]);
  ranked.slice(0, 3).forEach(([name, t, , , loc], i) =>
    L.push(`  ${i + 1}. ${loc.padEnd(18)} ${pct(t, w)} of OCR — ${name.trim()}`));
  L.push('');
  L.push(`Sample reads (sanity-check the layout is realistic):`);
  for (const s of m.sampleRows) L.push(`  | ${s}`);

  // Warn when the layout clearly doesn't fit the page: if nearly every row stops
  // on □ after a char or two, OCR isn't doing representative work (it bails at the
  // first glyph), so the absolute ms understates real use. The cost *profile*
  // (which op dominates) still holds.
  const avgChars = m.rowsWithText ? m.chars / m.rowsWithText : 0;
  if (m.rowsWithText && m.placeholders >= 0.8 * m.rowsWithText && avgChars < 4) {
    L.push('');
    L.push(`⚠  ${m.placeholders}/${m.rowsWithText} rows stopped on □ after ~${avgChars.toFixed(1)} chars —`);
    L.push(`   the layout doesn't match this PDF, so this run under-counts work.`);
    L.push(`   The op breakdown above is still valid, but for representative ms pass the`);
    L.push(`   Horizontal-Lines + Font settings you use in the UI, e.g.:`);
    L.push(`     node ocr-bench.mjs --rowBase <y> --rowHeight <h> --rowPitch <p> --rowCount <n> --fontSize <s>`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.chrome || !existsSync(opts.chrome)) {
    console.error(`Chrome/Edge not found. Pass --chrome <path> or set $CHROME.\n(tried: ${opts.chrome || 'none'})`);
    process.exit(1);
  }
  if (!opts.pdf || !existsSync(opts.pdf)) {
    console.error(opts.pdf ? `PDF not found: ${opts.pdf}`
      : `No PDF found in ${REPO} (drop one in, or pass --pdf <path>)`);
    process.exit(1);
  }

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = startServer(port);
  let browser;
  const cleanup = () => { try { browser?.close(); } catch {} try { server.kill(); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    await waitForServer(base);

    browser = await puppeteer.launch({
      executablePath: opts.chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });

    await suppressAppInit(page);   // skip the app's redundant template autoload (see paths.mjs)
    await page.goto(`${base}/training.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof Config !== 'undefined' && typeof CanvasViewer !== 'undefined' &&
        typeof extractEmbeddedImages !== 'undefined' && typeof window.pdfjsLib !== 'undefined',
      { timeout: 15000 },
    ).catch(() => {
      throw new Error(`app globals not ready (pdf.js CDN reachable?). page errors: ${errors.join(' | ') || 'none'}`);
    });

    const res = await page.evaluate(pageBenchmark, {
      pdfUrl: `${base}/${relative(REPO, opts.pdf).replace(/\\/g, '/')}`,
      page: opts.page,
      runs: opts.runs,
      autoAnchor: opts.autoAnchor,
      config: opts.config,
    });

    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(report(res));
  } catch (err) {
    console.error(`\nBenchmark failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();

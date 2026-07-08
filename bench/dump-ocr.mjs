// dump-ocr.mjs — dump per-row OCR text for one page or the whole document, using
// the REAL ocr.js + reader.js (same setup as ocr-bench.mjs).
//
//   node dump-ocr.mjs --page 3            # rows of page 3
//   node dump-ocr.mjs --all               # every page, every row (for diffing)
//   node dump-ocr.mjs --all --out out.txt # extract all pages to a clean .txt file
//
// The browser is set up ONCE (templates + PDF parsed), then Node drives the page
// loop one page at a time. Each page's lines are streamed straight to --out as they
// are produced — so memory holds a single page, partial output survives a crash or
// Ctrl-C, and there is no giant end-of-run serialization (the old single-evaluate
// design buffered all pages in browser RAM and timed out / crashed on long PDFs).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, createWriteStream, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, relative } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf, suppressAppInit } from './paths.mjs';
import { openRasterCache } from './raster-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function parseArgs(argv) {
  const o = { pdf: findPdf(REPO), page: 1, all: false, templates: null,
    out: null, chrome: process.env.CHROME || findChrome() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
    else if (a === '--page') o.page = parseInt(next(), 10);
    else if (a === '--all') o.all = true;
    else if (a === '--out') o.out = resolve(process.cwd(), next());
    else if (a === '--templates') o.templates = next();
    else if (a === '--chrome') o.chrome = next();
  }
  return o;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
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

// Runs ONCE in the page: load templates, parse the PDF, stash the viewer + doc on
// window for the per-page calls. render/rebuildBoxes are no-op'd because the dump
// never displays anything or hit-tests boxes — that canvas work is pure overhead
// here (the interactive tool only pays it for the page you actually look at).
// When every requested page is already in the raster cache (needPdf false), the
// PDF fetch + pdf.js parse are skipped entirely.
async function setupInPage({ pdfUrl, needPdf, tplDir, tplFiles }) {
  const cfg = new Config();
  const viewer = new CanvasViewer(
    document.getElementById('canvas'),
    document.getElementById('canvas-wrap'),
    document.getElementById('info'),
    cfg,
  );
  viewer.render = () => {};
  viewer.rebuildBoxes = () => {};
  const tA = performance.now();
  let nTpl;
  if (tplFiles) {
    // Alternate template dir (--templates): launch.py serves any repo path
    // statically, so only the manifest needs building here — same loader
    // (_loadGray/_setTemplates) as engine.loadFromHTTP, different base URL.
    const tasks = tplFiles.map(f => {
      const ch = stemToChar(f.slice(0, -4));
      return ch && ch.length === 1
        ? viewer.engine._loadGray(`/${tplDir}/${encodeURIComponent(f)}`, ch, f) : null;
    }).filter(Boolean);
    nTpl = await viewer.engine._setTemplates(tasks);
    const met = await fetch(`/${tplDir}/template_metrics.json`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    viewer.engine.applyMetrics(met);
  } else {
    nTpl = await viewer._loadTemplatesFromHTTP();
  }
  if (!nTpl) throw new Error('no templates loaded');
  const tB = performance.now();
  let pdf = null;
  if (needPdf) {
    const ab = await (await fetch(pdfUrl)).arrayBuffer();
    pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  }
  const tC = performance.now();
  window.__dump = { viewer, pdf };
  return { numPages: pdf ? pdf.numPages : 0, nTpl,
    tplMs: Math.round(tB - tA), pdfMs: Math.round(tC - tB) };
}

// Runs once PER PAGE. Cached page (cacheUrl set): fetch the grayscale record and
// seed the engine's page buffer directly — no pdf.js, no canvas. Live page: raster
// the largest embedded image as before, and hand the engine's own page buffer back
// (base64 gzip) for node to persist. Either way: set the final row bands, anchor
// each row to its first inked column (once — the old path anchored twice), then
// OCR every row. Returns the row strings plus a per-phase timing split
// (getPage / extract / setup / ocr) so the node side can report where time goes.
async function ocrPageInPage({ pno, cacheUrl }) {
  const { viewer, pdf } = window.__dump;
  const t0 = performance.now();
  let t1, t2, canvas = null, cachePut;
  if (cacheUrl) {
    const cached = await rcFetchPage(cacheUrl);
    if (!cached) throw new Error(`raster cache miss for expected ${cacheUrl}`);
    t1 = t2 = performance.now();
    if (cached.empty) return { rows: null, t: { get: 0, extract: t2 - t0, setup: 0, ocr: 0 } };
    viewer.img = rcSeedViewer(viewer, cached);
  } else {
    const page = await pdf.getPage(pno);
    t1 = performance.now();
    const imgs = await extractEmbeddedImages(page);
    t2 = performance.now();
    if (!imgs.length) {
      return { rows: null, t: { get: t1 - t0, extract: t2 - t1, setup: 0, ocr: 0 },
        cachePut: await rcEncodePage(null) };
    }
    canvas = imgs[0];
    for (const c of imgs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
    viewer.img = canvas;
  }

  viewer.filename = 'dump';
  viewer.rowBands = viewer.config.makeRowBands();
  viewer.resetLine();        // clear per-row state + ensureRows against the bands
  viewer.autoAnchorRows();   // first-ink anchor per row, against the final bands
  const t3 = performance.now();

  const rows = [];
  for (let r = 0; r < viewer.rowBands.length; r++) {
    viewer.ocrRow(r);
    rows.push(viewer.rowText[r] || '');
  }
  const t4 = performance.now();
  if (canvas) {
    // Persist the exact buffer OCR just used (identity-cached in the engine, so
    // _pageFor here is a lookup, not a rebuild) — the cache cannot diverge from
    // what was matched against.
    cachePut = await rcEncodePage(viewer.engine._pageFor(canvas));
  }
  return {
    rows,
    t: { get: t1 - t0, extract: t2 - t1, setup: t3 - t2, ocr: t4 - t3 },
    dims: { w: viewer.img.width, h: viewer.img.height },
    cachePut,
  };
}

// A clean output line: strip the □ placeholder, and the spaces the reader now
// recovers from word gaps — the ground-truth source.txt files are deliberately
// space-less, so the bench compares letters only. KEEP_SPACES=1 keeps them, for
// diffing against source_spaced.txt (the fit's spacing reconstruction) instead.
// (An old version also stripped a leading "> " UI marker — the reader never emits
// one, and the strip silently ate the first '>' of every quoted email line.)
const KEEP_SPACES = !!process.env.KEEP_SPACES;
const cleanRow = (row) => {
  row = row.replace(/□/g, '');
  return (KEEP_SPACES ? row : row.replace(/ /g, '')).trimEnd();
};

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.chrome || !existsSync(opts.chrome)) { console.error('No Chrome'); process.exit(1); }
  if (!opts.pdf || !existsSync(opts.pdf)) {
    console.error(`No PDF found in ${REPO} (drop one in, or pass --pdf <path>)`); process.exit(1);
  }
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = startServer(port);
  // Hash the PDF (cache key) while the server boots.
  const cachePromise = openRasterCache(opts.pdf, REPO);

  let browser, stream;
  const cleanup = () => {
    try { stream?.end(); } catch {}   // flush whatever was written so far
    try { browser?.close(); } catch {}
    try { server.kill(); } catch {}
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const errors = [];
  const t0 = Date.now();
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: opts.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await suppressAppInit(page);   // skip the app's redundant template autoload (see paths.mjs)
    await page.goto(`${base}/training.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof Config !== 'undefined' && typeof CanvasViewer !== 'undefined' &&
        typeof extractEmbeddedImages !== 'undefined' && typeof window.pdfjsLib !== 'undefined',
      { timeout: 15000 });
    page.setDefaultTimeout(300000);
    await page.addScriptTag({ path: resolve(__dirname, 'raster-cache-browser.js') });
    const cache = await cachePromise;
    const tReady = Date.now();

    // pdf.js is only needed for pages missing from the raster cache. For --all the
    // page list itself needs the PDF unless a previous completed run recorded
    // numPages in the cache's meta.json.
    const wanted = opts.all
      ? (cache.numPages ? Array.from({ length: cache.numPages }, (_, i) => i + 1) : null)
      : [opts.page];
    const needPdf = !wanted || !wanted.every(p => cache.havePage(p));
    let tplDir = null, tplFiles = null;
    if (opts.templates) {
      tplDir = basename(opts.templates);
      tplFiles = readdirSync(resolve(REPO, tplDir))
        .filter(f => f.endsWith('.png') && !f.includes('unmatched'));
      if (!tplFiles.length) throw new Error(`no PNGs in ${resolve(REPO, tplDir)}`);
    }
    const { numPages, nTpl, tplMs, pdfMs } = await page.evaluate(setupInPage, {
      pdfUrl: `${base}/${relative(REPO, opts.pdf).replace(/\\/g, '/')}`, needPdf, tplDir, tplFiles,
    });
    if (numPages) cache.writeMeta(numPages, basename(opts.pdf));
    const tSetup = Date.now();

    const pages = opts.all
      ? Array.from({ length: numPages || cache.numPages }, (_, i) => i + 1)
      : [opts.page];
    let hits = 0;
    const pageArg = (pno) => {
      const has = cache.havePage(pno);
      if (has) hits++;
      return { pno, cacheUrl: has ? `${base}/${cache.urlBase}/${cache.pageName(pno)}` : null };
    };

    // Per-phase totals across all pages (browser-side performance.now() splits).
    const prof = { get: 0, extract: 0, setup: 0, ocr: 0 };
    let dims = null;
    const takePage = (res) => {
      if (!res) return null;
      for (const k in prof) prof[k] += res.t[k];
      if (!dims && res.dims) dims = res.dims;
      return res.rows;
    };

    if (opts.out) {
      stream = createWriteStream(opts.out, { encoding: 'utf8' });
      // Backpressure-aware write: pause the loop until the OS buffer drains so a
      // 300-page document can't outrun the disk and balloon Node's memory.
      const write = (s) => stream.write(s)
        ? Promise.resolve()
        : new Promise(r => stream.once('drain', r));
      for (let i = 0; i < pages.length; i++) {
        const res = await page.evaluate(ocrPageInPage, pageArg(pages[i]));
        if (res?.cachePut) cache.writePage(pages[i], res.cachePut);
        const rows = takePage(res);
        await write((rows ?? []).map(cleanRow).join('\n') + '\n\n');
        process.stderr.write(`\r  ${i + 1}/${pages.length} pages`);
      }
      await new Promise(r => stream.end(r));
      stream = null;
      process.stderr.write(`\nwrote ${opts.out}\n`);
    } else {
      for (const pno of pages) {
        const res = await page.evaluate(ocrPageInPage, pageArg(pno));
        if (res?.cachePut) cache.writePage(pno, res.cachePut);
        const rows = takePage(res);
        (rows ?? []).forEach((t, r) => { if (t !== '') console.log(`P${pno} L${r}: ${t}`); });
      }
    }

    const tEnd = Date.now();
    const ocrMs = tEnd - tSetup;
    const n = pages.length;
    process.stderr.write(
      `timing: startup(server+browser) ${tReady - t0}ms · ` +
      `setup ${tSetup - tReady}ms (${nTpl} templates ${tplMs}ms + parse PDF ${pdfMs}ms) · ` +
      `ocr ${n} page(s) ${ocrMs}ms (${(ocrMs / n).toFixed(0)}ms/page)\n`);
    process.stderr.write(
      `per-page split: getPage ${(prof.get / n).toFixed(0)}ms · ` +
      `extract/fetch ${(prof.extract / n).toFixed(0)}ms · ` +
      `viewer setup ${(prof.setup / n).toFixed(0)}ms · ` +
      `ocr rows ${(prof.ocr / n).toFixed(0)}ms` +
      (dims ? ` · raster ${dims.w}×${dims.h}px` : '') +
      ` · raster cache ${hits}/${n} hit\n`);
  } catch (err) {
    console.error(`failed: ${err.message}`);
    if (errors.length) console.error('browser errors:', errors.join('\n'));
    process.exitCode = 1;
  } finally { cleanup(); }
}
main();

// trace-templates.mjs — map every OCR'd glyph back to the template FILE that matched it,
// and (with --source ground truth) flag false matches and rank the culprit templates.
//
//   node trace-templates.mjs --page 12                       # every glyph: col char file(s)
//   node trace-templates.mjs --page 12 --source ../source_page12.txt   # only the false ones
//   node trace-templates.mjs --all --source ../source.txt    # doc-wide culprit ranking
//
// "False match" = a glyph the OCR emitted that the source doesn't have at that spot (an
// insertion in an LCS diff of the OCR vs the source line). Each is traced to the template
// file(s) whose pixels are identical to the page there — so a mis-positioned or near-blank
// template (l_26, l_8) that reads a stray letter is named and can be deleted.
//
// Same scaffold as dump-ocr.mjs (../launch.py + headless Chrome), but it loads the
// templates a second time keeping each filename, so a match can be traced to its file.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, relative } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function parseArgs(argv) {
  const o = { pdf: findPdf(REPO), page: 1, all: false, source: null, templates: null,
    chrome: process.env.CHROME || findChrome() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
    else if (a === '--page') o.page = parseInt(next(), 10);
    else if (a === '--all') o.all = true;
    else if (a === '--source') o.source = resolve(process.cwd(), next());
    else if (a === '--templates') o.templates = next();
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

// Runs once in the page: load templates WITH filenames, parse the PDF, stash on window
// (with the source lines, so per-page tracing resolves filenames only for false matches).
async function setupInPage({ pdfUrl, sourceText, tplDir, tplFiles }) {
  const cfg = new Config();
  const viewer = new CanvasViewer(
    document.getElementById('canvas'), document.getElementById('canvas-wrap'),
    document.getElementById('info'), cfg);
  viewer.render = () => {}; viewer.rebuildBoxes = () => {};

  if (tplFiles) {
    // Alternate template dir (--templates): same loader as dump-ocr.mjs — launch.py
    // serves any repo path statically, and engine.templates already carries
    // {filename, char, w, h, pixels}, so it doubles as the trace's `tpls` list.
    const tasks = tplFiles.map(f => {
      const ch = stemToChar(f.slice(0, -4));
      return ch && ch.length === 1
        ? viewer.engine._loadGray(`/${tplDir}/${encodeURIComponent(f)}`, ch, f) : null;
    }).filter(Boolean);
    if (!await viewer.engine._setTemplates(tasks)) throw new Error('no templates loaded');
    const met = await fetch(`/${tplDir}/template_metrics.json`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    viewer.engine.applyMetrics(met);
    const ab = await (await fetch(pdfUrl)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
    const src = sourceText == null ? null : sourceText.replace(/\r/g, '').split('\n');
    window.__t = { viewer, pdf, tpls: viewer.engine.templates, src };
    return pdf.numPages;
  }

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
  const ab = await (await fetch(pdfUrl)).arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const src = sourceText == null ? null : sourceText.replace(/\r/g, '').split('\n');
  window.__t = { viewer, pdf, tpls, src };
  return pdf.numPages;
}

// Runs per page. OCR each row, recording the matched column of every emitted glyph (each
// _matchNear hit becomes one). With a source (base = its line offset into window.__t.src)
// only the FALSE matches — glyphs the source doesn't have, found by an LCS diff — are
// resolved to their template file(s), so a whole-document run stays cheap. Without a
// source (base = null) every glyph is resolved (the per-spot inspection mode). Returns the
// row count so the caller can advance the source pointer.
async function tracePageInPage(pno, base) {
  const { viewer, pdf, tpls, src } = window.__t;
  const page = await pdf.getPage(pno);
  const imgs = await extractEmbeddedImages(page);
  if (!imgs.length) return { rows: 0, dump: null, falses: [] };
  let canvas = imgs[0];
  for (const c of imgs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
  viewer.img = canvas;
  viewer.rowBands = viewer.config.makeRowBands();
  viewer.resetLine();
  viewer.autoAnchorRows();

  const eq = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  // Which template file(s) read this glyph. The reader's snap can shift the recorded
  // cell-left a pixel or two from where the template actually matched, so probe a small
  // window and keep the nearest offset that lands an exact match.
  const filesAt = (char, cellLeft, y0) => {
    for (const d of [0, 1, 2, 3, -1, -2, 4, 5, -3]) {
      const out = [];
      for (const t of tpls) {
        if (t.char !== char) continue;
        const crop = viewer.engine.cropPixels(canvas, cellLeft + d + TEMPLATE_LEFT_CROP, y0, t.w, t.h);
        if (eq(crop, t.pixels)) out.push(t.filename);
      }
      if (out.length) return out;
    }
    return [];
  };
  const lcsInsertions = (O, S) => {
    const n = O.length, m = S.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = O[i] === S[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ins = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (O[i] === S[j]) { i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ins.push(i); i++; }
      else j++;
    }
    while (i < n) { ins.push(i); i++; }
    return ins;
  };

  const dump = base == null ? [] : null;
  const falses = [];
  for (let r = 0; r < viewer.rowBands.length; r++) {
    const band = viewer.rowBands[r];
    const hits = [];
    const orig = viewer._matchNear.bind(viewer);
    viewer._matchNear = (...args) => {   // pass everything through — including the
      const h = orig(...args);           // metrics `expect` arg the reader now sends
      if (h) hits.push({ col: h.cellLeft, char: h.best.char });
      return h;
    };
    viewer.ocrRow(r);
    viewer._matchNear = orig;

    if (dump) {
      dump.push({ row: r, text: viewer.rowText[r] || '',
        glyphs: hits.map(h => ({ col: h.col, char: h.char, files: filesAt(h.char, h.col, band.y0) })) });
      continue;
    }
    const srcLine = src[base + r];
    if (srcLine === undefined) continue;
    const ocr = (viewer.rowText[r] || '').replace(/^> ?/, '').replace(/□/g, '').replace(/ /g, '');
    const want = srcLine.replace(/ /g, '');
    if (ocr === want) continue;
    for (const i of lcsInsertions(ocr, want)) {
      const h = hits[i]; if (!h) continue;
      falses.push({ row: r, col: h.col, char: h.char, files: filesAt(h.char, h.col, band.y0) });
    }
  }
  return { rows: viewer.rowBands.length, dump, falses };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.chrome || !existsSync(opts.chrome)) { console.error('No Chrome'); process.exit(1); }
  if (!opts.pdf || !existsSync(opts.pdf)) { console.error(`No PDF in ${REPO}`); process.exit(1); }
  const sourceText = opts.source ? readFileSync(opts.source, 'utf8') : null;

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = startServer(port);
  let browser;
  const cleanup = () => { try { browser?.close(); } catch {} try { server.kill(); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const culprits = new Map(); // filename -> false-match count
  let falseTotal = 0;
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

    let tplDir = null, tplFiles = null;
    if (opts.templates) {
      tplDir = basename(opts.templates);
      tplFiles = readdirSync(resolve(REPO, tplDir))
        .filter(f => f.endsWith('.png') && !f.includes('unmatched'));
      if (!tplFiles.length) throw new Error(`no PNGs in ${resolve(REPO, tplDir)}`);
    }
    const numPages = await page.evaluate(setupInPage,
      // repo-RELATIVE url, not basename: two docs may share the name source.pdf
      { pdfUrl: `${base}/${relative(REPO, opts.pdf).replace(/\\/g, '/')}`, sourceText, tplDir, tplFiles });
    const pages = opts.all ? Array.from({ length: numPages }, (_, i) => i + 1) : [opts.page];

    // Source-line offset for the page. A single-page source file is indexed from 0; the
    // full source.txt is walked page by page exactly as dump-ocr --out wrote it (one line
    // per row, then a blank line between pages).
    let srcPtr = 0;
    for (const pno of pages) {
      const base0 = sourceText == null ? null : (opts.all ? srcPtr : 0);
      const { rows, dump, falses } = await page.evaluate(tracePageInPage, pno, base0);

      if (dump) {
        for (const { row, text, glyphs } of dump) {
          if (!glyphs.length) continue;
          console.log(`P${pno} L${row}: ${text}`);
          for (const g of glyphs)
            console.log(`   col ${String(g.col).padStart(4)}  '${g.char}'  ${g.files.join(', ') || '(no file?!)'}`);
        }
      }
      for (const f of falses) {
        falseTotal++;
        console.log(`P${pno} L${f.row} col ${String(f.col).padStart(4)}  FALSE '${f.char}'  <- ${f.files.join(', ') || '(no file?!)'}`);
        for (const name of f.files) culprits.set(name, (culprits.get(name) || 0) + 1);
      }
      if (opts.all) srcPtr += rows + 1; // +1 for the blank line between pages
    }

    if (sourceText != null) {
      console.log(`\n${falseTotal} false matches.  Culprit templates (by false-match count):`);
      const ranked = [...culprits.entries()].sort((a, b) => b[1] - a[1]);
      for (const [f, n] of ranked) console.log(`  ${String(n).padStart(4)}  ${f}`);
      if (!ranked.length) console.log('  (none)');
    }
    if (errors.length) console.error('browser errors:', errors.join('\n'));
  } catch (err) {
    console.error(`failed: ${err.message}`);
    process.exitCode = 1;
  } finally { cleanup(); }
}
main();

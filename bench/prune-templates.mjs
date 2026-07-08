// prune-templates.mjs — find (and optionally delete) template PNGs whose glyph
// never occurs anywhere in a PDF, so stale templates can be removed.
//
// "A template matches the PDF" means exactly what matchAt means in ocr.js: the
// template's w×h block of grayscale pixels is pixel-identical to some crop of a
// page raster. This tool searches that exhaustively — every (x, y) of every page
// — not just along OCR read paths, so a template counts as "used" if its glyph
// appears ANYWHERE in the document (any row, any column), even where the line
// reader would have stopped early. Templates that never match are stale.
//
// How it stays fast (a full per-pixel × per-template scan would be billions of
// compares): for each page it hashes every height-15 pixel column once (an O(1)
// vertical recurrence as y advances), then for each template width rolls a
// horizontal hash across that column-hash row. A template's precomputed
// window-hash collides with a page window only at a true match (plus rare hash
// collisions), and every hit is then VERIFIED with the real pixelsEqual against
// the template's pixels — so the result is exact, never a hash guess.
//
//   node prune-templates.mjs                 # dry run: list stale templates
//   node prune-templates.mjs --delete        # actually delete them from ../templates
//   node prune-templates.mjs --pdf ../x.pdf --json
//
// Requires the same environment as ocr-bench.mjs: local Chrome/Edge (auto-detected
// or --chrome / $CHROME), python on PATH (serves ../launch.py), and internet
// (pdf.js loads from the same CDN the app uses).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join, relative } from 'node:path';
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
    delete: false,
    json: false,
    chrome: process.env.CHROME || findChrome(),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
    else if (a === '--delete') o.delete = true;
    else if (a === '--json') o.json = true;
    else if (a === '--chrome') o.chrome = next();
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(2); }
  }
  return o;
}

function printHelp() {
  console.log(`Usage: node prune-templates.mjs [options]
  --pdf <path>    PDF to search   (default: newest *.pdf in repo root)
  --delete        delete the stale templates (default: dry run — list only)
  --json          machine-readable output
  --chrome <path> browser executable (default: auto-detect / $CHROME)`);
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
  return spawn(py, ['launch.py', '--no-browser', '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
}
async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/api/templates`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

// ---------------------------------------------------------------------------
// In-page setup: load every template (keeping its filename), build the per-width
// rolling-hash index, and open the PDF. Runs in the page main world so it can use
// the app globals (TemplateEngine, pdfjsLib, gray, pixelsEqual). State is parked
// on window.__prune so the per-page pass below can reuse it across evaluate calls.
// ---------------------------------------------------------------------------
async function evalInit(opts) {
  const TH = 15;             // every template is 15px tall (single height ⇒ one column hash)
  const VB = 16777619 | 0;   // base for the vertical (column) polynomial hash
  const HB = 1000003 | 0;    // base for the horizontal (window) polynomial hash
  const imul = Math.imul;
  const ipow = (b, e) => { let r = 1 | 0; for (let i = 0; i < e; i++) r = imul(r, b); return r; };
  const VBpowTH = ipow(VB, TH); // VB^15, for the O(1) vertical slide

  const engine = new TemplateEngine();

  // --- load templates with their filenames (the manifest gives filename+char) --
  const manifest = await (await fetch('/api/templates')).json();
  const templates = (await Promise.all(manifest.map(async ({ filename, char }) => {
    const t = await engine._loadGray(`/templates/${filename}`, char);
    if (t) t.name = filename;
    return t;
  }))).filter(Boolean);

  // Guard the single-height assumption: anything not 15px tall is handled with a
  // per-template height so the scan stays correct (just builds its own column hash).
  const heights = new Set(templates.map(t => t.h));

  // --- per-width index: window-hash → templates of that width ------------------
  // A template's column hash (over its own pixels) equals a page column's hash at
  // a true match, so its window hash lands in the same bucket the page produces.
  const colHashOf = (px, w, h, c) => { // hash of template column c, top-to-bottom
    const ti = new Int32Array(px.buffer);
    let hsh = 0 | 0;
    for (let k = 0; k < h; k++) hsh = (imul(hsh, VB) + ti[k * w + c]) | 0;
    return hsh;
  };
  const byWidth = new Map(); // w → { hbPow: HB^(w-1), map: Map(winHash → [t]) }
  for (const t of templates) {
    let win = 0 | 0;
    for (let c = 0; c < t.w; c++) win = (imul(win, HB) + colHashOf(t.pixels, t.w, t.h, c)) | 0;
    let e = byWidth.get(t.w);
    if (!e) { e = { hbPow: ipow(HB, t.w - 1), map: new Map() }; byWidth.set(t.w, e); }
    let arr = e.map.get(win);
    if (!arr) { arr = []; e.map.set(win, arr); }
    arr.push(t);
  }

  // --- scan one page raster: mark every template whose block occurs on it -------
  function matchPage(canvas) {
    const page = engine._pageFor(canvas);          // { w, h, gray } whole-page grayscale
    const W = page.w, H = page.h;
    if (W < 1 || H < TH) return;
    const vi = new Int32Array(page.gray.buffer);    // exact float32 bit pattern per pixel
    const found = window.__prune.found;

    // colH[x] = hash of the height-TH column at (x, y); maintained as y advances.
    const colH = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      let hsh = 0 | 0;
      for (let k = 0; k < TH; k++) hsh = (imul(hsh, VB) + vi[k * W + x]) | 0;
      colH[x] = hsh;
    }

    const yMax = H - TH; // last row a TH-tall window fits in
    for (let y = 0; ; y++) {
      for (const [w, e] of byWidth) {
        if (w > W) continue;
        const hbPow = e.hbPow, map = e.map, last = W - w;
        let win = 0 | 0;
        for (let c = 0; c < w; c++) win = (imul(win, HB) + colH[c]) | 0; // window at x=0
        for (let x = 0; ; x++) {
          const arr = map.get(win);
          if (arr) {
            for (const t of arr) {
              if (found.has(t.name)) continue;             // already proven used
              const crop = engine.cropPixels(canvas, x, y, t.w, t.h);
              if (pixelsEqual(crop, t.pixels)) found.add(t.name); // exact, not a hash guess
            }
          }
          if (x >= last) break;
          win = (imul((win - imul(colH[x], hbPow)) | 0, HB) + colH[x + w]) | 0; // roll x→x+1
        }
      }
      if (y >= yMax) break;
      const top = y * W, bot = (y + TH) * W;            // slide every column down one row
      for (let x = 0; x < W; x++) colH[x] = (imul(colH[x], VB) - imul(vi[top + x], VBpowTH) + vi[bot + x]) | 0;
    }
  }

  // --- open the PDF and park state for the per-page pass -----------------------
  const ab = await (await fetch(opts.pdfUrl)).arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  window.__prune = { engine, pdf, matchPage, found: new Set(), templates };

  return {
    numPages: pdf.numPages,
    total: templates.length,
    heights: [...heights],
    manifest: templates.map(t => ({ name: t.name, char: t.char, w: t.w, h: t.h })),
  };
}

// Scan a single page (kept its own evaluate call so Node can print progress and
// memory stays bounded — each page raster is dropped before the next).
async function evalPage(pno) {
  const P = window.__prune;
  const page = await P.pdf.getPage(pno);
  const imgs = await extractEmbeddedImages(page);
  if (!imgs.length) return { empty: true, found: P.found.size };
  let canvas = imgs[0];
  for (const c of imgs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
  P.matchPage(canvas);
  return { w: canvas.width, h: canvas.height, found: P.found.size };
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
      executablePath: opts.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });

    await suppressAppInit(page);   // skip the app's redundant template autoload (see paths.mjs)
    await page.goto(`${base}/training.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof TemplateEngine !== 'undefined' && typeof extractEmbeddedImages !== 'undefined' &&
        typeof window.pdfjsLib !== 'undefined' && typeof pixelsEqual !== 'undefined',
      { timeout: 15000 },
    ).catch(() => { throw new Error(`app globals not ready (pdf.js CDN reachable?). page errors: ${errors.join(' | ') || 'none'}`); });

    const init = await page.evaluate(evalInit, { pdfUrl: `${base}/${relative(REPO, opts.pdf).replace(/\\/g, '/')}` });
    if (!opts.json) {
      console.error(`Loaded ${init.total} templates · scanning ${init.numPages} pages of ${basename(opts.pdf)} …`);
      if (init.heights.some(h => h !== 15)) console.error(`note: template heights present: ${init.heights.join(', ')}`);
    }

    for (let p = 1; p <= init.numPages; p++) {
      const r = await page.evaluate(evalPage, p);
      if (!opts.json) {
        const where = r.empty ? 'no embedded image' : `${r.w}×${r.h}`;
        console.error(`  page ${String(p).padStart(2)}/${init.numPages}  ${where.padEnd(11)}  matched so far: ${r.found}/${init.total}`);
      }
    }

    const matched = new Set(await page.evaluate(() => [...window.__prune.found]));
    const stale = init.manifest.filter(m => !matched.has(m.name));

    if (opts.json) {
      console.log(JSON.stringify({
        pdf: basename(opts.pdf), total: init.total, matched: matched.size,
        stale: stale.map(m => m.name), deleted: opts.delete,
      }, null, 2));
    } else {
      console.log('');
      console.log(`Result: ${matched.size}/${init.total} templates matched the PDF · ${stale.length} stale (never matched).`);
      if (stale.length) {
        // group stale by char so it's easy to eyeball what's being dropped
        const byChar = new Map();
        for (const m of stale) byChar.set(m.char, (byChar.get(m.char) || 0) + 1);
        const chars = [...byChar.entries()].sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${JSON.stringify(c)}×${n}`).join('  ');
        console.log(`Stale by char: ${chars}`);
        console.log('');
        for (const m of stale) console.log(`  ${m.name}`);
      }
    }

    if (opts.delete && stale.length) {
      let n = 0;
      for (const m of stale) {
        try { unlinkSync(join(REPO, 'templates', m.name)); n++; }
        catch (e) { console.error(`  failed to delete ${m.name}: ${e.message}`); }
      }
      if (!opts.json) console.log(`\nDeleted ${n} stale template${n === 1 ? '' : 's'} from templates/.`);
    } else if (stale.length && !opts.json) {
      console.log(`\nDry run — pass --delete to remove these ${stale.length} files.`);
    }
  } catch (err) {
    console.error(`\nPrune failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();

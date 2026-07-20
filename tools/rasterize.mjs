// rasterize.mjs — populate the per-page raster cache for a PDF, byte-identical
// to live in-app extraction: headless Chrome runs the SAME pdf.js embedded-
// image extraction the app uses (extractEmbeddedImages in training.js), the
// canvas RGBA reduces through the same gray() law ((R+G+B)/3, core.js), and
// raster-cache-browser.js encodes the GRY1 record. No OCR, no templates —
// this replaced dump-ocr.mjs when the legacy grid/template path was removed
// (2026-07-13); the caching semantics are unchanged, so existing caches stay
// valid (same key, same bytes).
//
//   node rasterize.mjs --pdf ../corpus/doc.pdf          # all pages
//   node rasterize.mjs --pdf ../corpus/doc.pdf --page 3 # one page
//
// Pages already in the cache are skipped; a completed run records numPages in
// the cache's meta.json so later readers don't need the PDF at all.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, basename, relative } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf, suppressAppInit } from './paths.mjs';
import { openRasterCache } from './raster-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const o = { pdf: findPdf(resolve(REPO, 'corpus')) || findPdf(REPO), page: null,
  chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--page') o.page = parseInt(next(), 10);
  else if (a === '--chrome') o.chrome = next();
}

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
export async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/src/training.html`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

// Runs ONCE in the page: parse the PDF, stash it on window.
export async function setupInPage({ pdfUrl }) {
  const ab = await (await fetch(pdfUrl)).arrayBuffer();
  window.__rz = { pdf: await pdfjsLib.getDocument({ data: ab }).promise };
  return { numPages: window.__rz.pdf.numPages };
}

// Runs once PER PAGE: extract the largest embedded image, reduce to the gray
// page buffer (identical arithmetic to the engine's page buffer), encode.
export async function rasterPageInPage({ pno }) {
  const page = await window.__rz.pdf.getPage(pno);
  const imgs = await extractEmbeddedImages(page);
  if (!imgs.length) return { empty: true, cachePut: await rcEncodePage(null) };
  let canvas = imgs[0];
  for (const c of imgs) if (c.width * c.height > canvas.width * canvas.height) canvas = c;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const n = canvas.width * canvas.height;
  // per-pixel channel spread (max−min): real colorness for the mode-3 cache
  // (sum-only mode 2 is blind to colors whose sum is a multiple of 3)
  let spread = new Uint8Array(n), any = false;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g_ = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = r > g_ ? (r > b ? r : b) : (g_ > b ? g_ : b);
    const mn = r < g_ ? (r < b ? r : b) : (g_ < b ? g_ : b);
    if ((spread[i] = mx - mn)) any = true;
  }
  if (!any) spread = null;
  const page_ = { w: canvas.width, h: canvas.height, gray: gray(data, n), spread };
  return { dims: { w: canvas.width, h: canvas.height }, cachePut: await rcEncodePage(page_) };
}

async function main() {
  if (!o.chrome || !existsSync(o.chrome)) { console.error('No Chrome'); process.exit(1); }
  if (!o.pdf || !existsSync(o.pdf)) { console.error('No PDF (pass --pdf <path>)'); process.exit(1); }
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath,
    ['tools/serve.mjs', '--no-browser', '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
  const cachePromise = openRasterCache(o.pdf, REPO);
  let browser;
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await suppressAppInit(page);
    await page.goto(`${base}/src/training.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof extractEmbeddedImages !== 'undefined' && typeof gray !== 'undefined' &&
        typeof window.pdfjsLib !== 'undefined', { timeout: 15000 });
    page.setDefaultTimeout(300000);
    await page.addScriptTag({ path: resolve(__dirname, 'raster-cache-browser.js') });
    const cache = await cachePromise;

    const { numPages } = await page.evaluate(setupInPage,
      { pdfUrl: `${base}/${relative(REPO, o.pdf).replace(/\\/g, '/')}` });
    cache.writeMeta(numPages, basename(o.pdf));
    const pages = o.page ? [o.page] : Array.from({ length: numPages }, (_, i) => i + 1);

    let done = 0, skipped = 0;
    for (const pno of pages) {
      if (cache.havePage(pno)) { skipped++; continue; }
      const res = await page.evaluate(rasterPageInPage, { pno });
      cache.writePage(pno, res.cachePut);
      done++;
      process.stderr.write(`\r  ${done + skipped}/${pages.length} pages`);
    }
    process.stderr.write(`\n${cache.key}: ${done} rasterized, ${skipped} already cached\n`);
    if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  } finally {
    try { await browser?.close(); } catch {}
    try { server.kill(); } catch {}
  }
}
// batch-read.mjs imports the session pieces above; only run as a CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e => { console.error(e); process.exit(1); });

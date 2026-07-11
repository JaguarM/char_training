// test-blind-app.mjs — headless test of the APP's Auto OCR path (blindocr.js +
// CanvasViewer.blindOcrPage), exactly as a user would trigger it: real
// training.html, real viewer, page seeded from the raster cache.
//
//   node test-blind-app.mjs                 # v3 pages 1+2 vs corpus/v3.txt
//   node test-blind-app.mjs --raster <p.gray.gz> --truth <p.txt>
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome, suppressAppInit } from './paths.mjs';
import { openRasterCache } from './raster-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const o = { raster: null, truth: join(REPO, 'corpus', 'v3.txt'),
  chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--raster') o.raster = resolve(process.cwd(), next());
  else if (a === '--truth') o.truth = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/api/templates`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

async function run() {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3',
    ['launch.py', '--no-browser', '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
  let browser;
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await suppressAppInit(page);
    await page.goto(`${base}/training.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof CanvasViewer !== 'undefined' && typeof BlindOCR !== 'undefined');
    page.setDefaultTimeout(120000);
    await page.addScriptTag({ path: resolve(__dirname, 'raster-cache-browser.js') });
    await page.evaluate(() => {
      const cfg = new Config();
      const v = new CanvasViewer(document.getElementById('canvas'),
        document.getElementById('canvas-wrap'), document.getElementById('info'), cfg);
      v.render = () => {};      // the seeded page stand-in is not drawable
      window.__v = v;
    });

    // which pages to test
    let jobs;
    if (o.raster) {
      // serve the raster through the repo: copy under bench/raster-cache/adhoc/
      const dir = join(REPO, 'bench', 'raster-cache', 'adhoc');
      mkdirSync(dir, { recursive: true });
      const name = basename(o.raster);
      copyFileSync(o.raster, join(dir, name));
      jobs = [{ label: name, url: `${base}/bench/raster-cache/adhoc/${name}` }];
    } else {
      const cache = await openRasterCache(join(REPO, 'corpus', 'v3.pdf'), REPO);
      jobs = [1, 2].map(pno => ({ label: `v3 P${pno}`,
        url: `${base}/${cache.urlBase}/${cache.pageName(pno)}` }));
    }
    const truth = readFileSync(o.truth, 'utf8').replace(/\r/g, '').split('\n')
      .map(t => t.trimEnd());

    // whole-document API smoke test: two pages through blindOcrDocument
    if (jobs.length > 1) {
      const doc = await page.evaluate(async (urls) => {
        const v = window.__v;
        const cached = await Promise.all(urls.map(u => rcFetchPage(u)));
        const out = await v.blindOcrDocument(cached.length,
          i => ({ w: cached[i].w, h: cached[i].h, gray: cached[i].gray }));
        return { totals: out.totals, pages: out.pages.length,
          textHead: out.text.slice(0, 60) };
      }, jobs.map(j => j.url));
      console.log(`document API: ${doc.pages} pages, totals ${JSON.stringify(doc.totals)}, ` +
        `text starts ${JSON.stringify(doc.textHead)}`);
    }

    for (const job of jobs) {
      const res = await page.evaluate(async (url) => {
        const v = window.__v;
        const cached = await rcFetchPage(url);
        v.img = rcSeedViewer(v, cached);
        v.filename = 'test';
        v.resetLine();
        await v.blindOcrPage();
        return { info: v.infoEl.textContent,
          rows: v.rowText.filter(t => t && t.trim()).map(t => t.trimEnd()),
          bands: v.rowBands.length, boxes: v.allBoxes.length };
      }, job.url);
      const hit = res.rows.filter(r => truth.includes(r)).length;
      console.log(`${job.label}: ${res.rows.length} rows read, ${hit} exactly in truth · ` +
        `${res.bands} bands, ${res.boxes} boxes`);
      console.log(`  info: ${res.info}`);
      for (const r of res.rows.filter(r => !truth.includes(r)).slice(0, 6))
        console.log(`  not-in-truth: ${JSON.stringify(r.slice(0, 70))}`);
    }
    if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  } finally {
    try { await browser?.close(); } catch {}
    try { server.kill(); } catch {}
  }
}
run().catch(e => { console.error(e); process.exit(1); });

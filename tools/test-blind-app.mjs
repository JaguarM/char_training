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
    try { const r = await fetch(`${base}/src/training.html`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

async function run() {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath,
    ['tools/serve.mjs', '--no-browser', '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
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
      // serve the raster through the repo: copy under tools/raster-cache/adhoc/
      const dir = join(REPO, 'tools', 'raster-cache', 'adhoc');
      mkdirSync(dir, { recursive: true });
      const name = basename(o.raster);
      copyFileSync(o.raster, join(dir, name));
      jobs = [{ label: name, url: `${base}/tools/raster-cache/adhoc/${name}`, truth: o.truth }];
    } else {
      const cache = await openRasterCache(join(REPO, 'corpus', 'v3.pdf'), REPO);
      jobs = [1, 2].map(pno => ({ label: `v3 P${pno}`,
        url: `${base}/${cache.urlBase}/${cache.pageName(pno)}`, truth: o.truth }));
      // email.pdf: P1 = color page + palette-quantized producer + redaction
      // boxes; P2 = plain page behind the light-gray quote bar (vrule).
      // email.txt spacing rarely matches the measured read — compare letters.
      const email = await openRasterCache(join(REPO, 'corpus', 'email.pdf'), REPO);
      for (const pno of [1, 2])
        jobs.push({ label: `email P${pno}`,
          url: `${base}/${email.urlBase}/${email.pageName(pno)}`,
          truth: join(REPO, 'corpus', 'email.txt'), letters: true });
      // courier_1 P1: Times 16px header (bold labels → same-size union pass)
      // + Courier New 13px body; truth = the bench's certified transcription
      if (existsSync(join(REPO, 'corpus', 'courier_1.txt'))) {
        const cour = await openRasterCache(join(REPO, 'corpus', 'courier_1.pdf'), REPO);
        jobs.push({ label: 'courier_1 P1',
          url: `${base}/${cour.urlBase}/${cour.pageName(1)}`,
          truth: join(REPO, 'corpus', 'courier_1.txt'), letters: true });
      }
    }

    // whole-document API smoke test: two pages through blindOcrDocument
    if (jobs.length > 1) {
      const doc = await page.evaluate(async (urls) => {
        const v = window.__v;
        const cached = await Promise.all(urls.map(u => rcFetchPage(u)));
        const out = await v.blindOcrDocument(cached.length,
          i => ({ w: cached[i].w, h: cached[i].h, gray: cached[i].gray }));
        return { totals: out.totals, pages: out.pages.length,
          textHead: out.text.slice(0, 60) };
      }, jobs.slice(0, 2).map(j => j.url));
      console.log(`document API: ${doc.pages} pages, totals ${JSON.stringify(doc.totals)}, ` +
        `text starts ${JSON.stringify(doc.textHead)}`);
    }

    for (const job of jobs) {
      const truth = readFileSync(job.truth, 'utf8').replace(/\r/g, '').split('\n')
        .map(t => t.trimEnd());
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
      // letters-only jobs: the truth file's exporter spaces rows differently
      // (and drops characters — a known truth-defect family); letter identity
      // is the metric the bench certifies, so compare that
      const canon = job.letters ? (s) => s.replace(/[ □]/g, '') : (s) => s;
      const tset = new Set(truth.map(canon));
      const hit = res.rows.filter(r => tset.has(canon(r))).length;
      console.log(`${job.label}: ${res.rows.length} rows read, ${hit} ` +
        `${job.letters ? 'letter-exact vs truth' : 'exactly in truth'} · ` +
        `${res.bands} bands, ${res.boxes} boxes`);
      console.log(`  info: ${res.info}`);
      for (const r of res.rows.filter(r => !tset.has(canon(r))).slice(0, 6))
        console.log(`  not-in-truth: ${JSON.stringify(r.slice(0, 70))}`);
    }
    if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  } finally {
    try { await browser?.close(); } catch {}
    try { server.kill(); } catch {}
  }
}
run().catch(e => { console.error(e); process.exit(1); });

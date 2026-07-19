// test-recto-app.mjs — end-to-end smoke of the Recto ocr_tool plugin (the
// synced engine running inside the Django PDF editor). Spawns the Django dev
// server, opens the app headless, uploads a CERTIFIED document through the
// real file input (NEW/courier/EFTA00751637.pdf — 0 □, Outside In Nimbus
// family, exercises the nimbus791 set) — deliberately NOT Recto's bundled
// default, which is app-side and may be swapped for experiments — runs Auto
// OCR on page 1 through the plugin's own entry point, and asserts that
// byte-clean 'ocr' text boxes landed in the unified text box system.
//
//   node test-recto-app.mjs [--recto <path-to-Recto>] [--chrome <exe>]
//
// Run after every `npm run sync:recto` (and after adapter edits in Recto).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const o = { recto: resolve(REPO, '..', 'Recto'), chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--recto') o.recto = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
}
if (!existsSync(join(o.recto, 'manage.py'))) {
  console.error(`no manage.py at ${o.recto} — pass --recto`);
  process.exit(2);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitForServer(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(base); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Django server did not become ready');
}

async function run() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3',
    ['manage.py', 'runserver', `127.0.0.1:${port}`, '--noreload'],
    { cwd: o.recto, stdio: 'ignore' });
  let browser, failed = false;
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(base, { waitUntil: 'load' });
    // engine + adapter present, default document loaded. NB: state is a
    // top-level const (global lexical binding, NOT a window property).
    try {
      await page.waitForFunction(() => typeof BlindOCR !== 'undefined' &&
        typeof OCRTool !== 'undefined' && typeof utbState !== 'undefined' &&
        typeof state !== 'undefined' && state.pageImages?.length > 0);
    } catch (e) {
      const diag = await page.evaluate(() => ({
        BlindOCR: typeof BlindOCR, OCRTool: typeof OCRTool,
        utbState: typeof utbState, state: typeof state,
        pages: typeof state !== 'undefined' ? state.pageImages?.length : null,
      }));
      console.error('startup diagnostics:', diag);
      if (errors.length) console.error('page errors:', errors.slice(0, 8));
      throw e;
    }

    // Upload the certified test document through the real file input — the
    // OCR verdict must not depend on whatever document the app opens by
    // default (that is Recto-side and swappable).
    const TEST_PDF = join(REPO, 'NEW', 'courier', 'EFTA00751637.pdf');
    if (!existsSync(TEST_PDF)) throw new Error(`test document missing: ${TEST_PDF}`);
    const fileInput = await page.$('#pdf-file');
    if (!fileInput) throw new Error('#pdf-file input not found');
    await fileInput.uploadFile(TEST_PDF);
    await page.waitForFunction(() => state.numPages === 7 && state.pageImages?.length === 7);

    // Drive the REAL UI (a programmatic OCRTool.run() would mask dead button
    // wiring — that bug happened): toggle the subtoolbar, press "This page",
    // then wait for actual 'ocr' boxes — a dead button times out here.
    await page.click('#toggle-ocr-tool');
    await page.waitForFunction(() =>
      !document.getElementById('ocr-tool-bar')?.classList.contains('hidden'));
    await page.click('#ocr-run-page');
    await page.waitForFunction(() => typeof OCRTool !== 'undefined' &&
      !OCRTool.state.running && utbState.boxes.some(b => b.type === 'ocr'));

    const r = await page.evaluate(() => {
      const ocr = utbState.boxes.filter(b => b.type === 'ocr');
      return {
        status: document.getElementById('ocr-status')?.textContent ?? '',
        boxes: ocr.length,
        clean: ocr.filter(b => b.ocr?.clean).length,
        unread: ocr.filter(b => b.ocr?.unread).length,
        redactions: utbState.boxes.filter(b => b.type === 'redaction' && b.ocrSource).length,
        rendered: document.querySelectorAll('.utb-group[data-type="ocr"]').length,
        sample: ocr.find(b => b.ocr?.clean)?.text ?? '',
      };
    });

    // The OCR-text visibility toggle must actually hide/show the rendered
    // groups (drive the real button, like the run button above).
    const visibleOcrGroups = () => page.evaluate(() =>
      [...document.querySelectorAll('.utb-group[data-type="ocr"]')]
        .filter(g => getComputedStyle(g).display !== 'none').length);
    await page.click('#ocr-toggle-text');
    const hiddenCount = await visibleOcrGroups();
    await page.click('#ocr-toggle-text');
    const shownCount = await visibleOcrGroups();
    if (!(hiddenCount === 0 && shownCount > 0)) {
      console.error(`  FAIL: ocr-toggle-text — ${hiddenCount} visible while hidden, ` +
        `${shownCount} after re-show`);
      failed = true;
    }

    console.log(`Recto ocr_tool: ${r.boxes} ocr boxes (${r.clean} byte-clean, ` +
      `${r.unread} unread), ${r.redactions} redaction boxes, ${r.rendered} rendered`);
    console.log(`  status: ${r.status}`);
    console.log(`  sample: "${r.sample.slice(0, 70)}"`);
    if (errors.length) { console.error('  page errors:', errors.slice(0, 5)); failed = true; }
    if (!(r.boxes > 0 && r.clean > 0 && r.rendered > 0)) {
      console.error('  FAIL: expected >0 boxes, >0 byte-clean, >0 rendered');
      failed = true;
    }
    console.log(failed ? 'FAIL' : 'PASS');
  } finally {
    await browser?.close();
    server.kill();
  }
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });

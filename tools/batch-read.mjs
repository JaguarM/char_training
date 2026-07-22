// batch-read.mjs — exact-OCR a whole folder tree of PDFs with the proven
// family ladder. For each PDF: rasterize into the shared raster cache (one
// headless-Chrome session for the whole run — the per-doc rasterize.mjs
// browser launch would dominate a thousands-of-files batch), probe page 1
// with every proven family rung, then full-read with the winning rung and
// write the transcript. Everything is resumable: results append to
// <out>/manifest.jsonl per doc, and already-manifested docs are skipped.
//
//   node tools/batch-read.mjs --dir F:/docs               # transcripts → F:/docs_ocr
//   node tools/batch-read.mjs --dir F:/docs --out D:/ocr --prune --limit 20
//
// Options:
//   --dir <folder>   root to scan (recursive, *.pdf) — required
//   --out <folder>   output root (default <dir>_ocr); mirrors the input tree
//   --limit N        stop after N docs (smoke runs)
//   --redo           re-process docs already in the manifest
//   --prune          delete a doc's raster cache after reading (bounds disk:
//                    a 96 GB corpus can cache tens of GB of rasters)
//   --probe-page N   probe page (default 1)
//   --shard i/n      process every n-th doc starting at i (0-based) with a
//                    per-shard manifest — run n batch processes in parallel
//                    on a huge corpus (each starts its own Chrome session)
//   --chrome <exe>   Chrome path override
//
// Status per doc: 'exact' (0 □ — every glyph byte-certified at the rung's
// proven tolerance), 'partial' (reads with □ remainders — candidate for a
// family hunt in ocr/), 'no-read' (no rung reads P1 — unknown producer),
// 'empty' (no ink), 'raster-error' (pdf.js could not open/extract).
// 'pagesSkipped' on an entry lists pages dropped by the per-page fallback
// (marker line in the transcript at each skip).
//
// PDFs outside the repo are staged (copied) into tools/batch-staging/ while
// rasterizing — serve.mjs only serves repo-relative paths, and the cache key
// is the content hash, so the staged copy fills the ORIGINAL file's cache.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, appendFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, basename } from 'node:path';
import { POOLS, BATCH_LADDER } from './glyph-registry.mjs';
import puppeteer from 'puppeteer-core';
import { findChrome, suppressAppInit } from './paths.mjs';
import { openRasterCache } from './raster-cache.mjs';
import { freePort, waitForServer, setupInPage, rasterPageInPage } from './rasterize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const STAGING = join(__dirname, 'batch-staging');

// ---- the ladder: every byte-proven family, cheapest/most-common first.
// Rungs come from the ONE registry (tools/glyph-registry.mjs); only
// calibri (tol 2, per-page harvest wobble) and jitter (tol 1, JPEG ±1)
// read above tol 0 — those tolerances are part of the family proof.
const RUNGS = BATCH_LADDER.map(entry => {
  const name = typeof entry === 'string' ? entry : entry.name;
  const pool = POOLS[typeof entry === 'string' ? entry : entry.pool];
  const args = ['--glyphs', pool.glyphs];
  if (pool.tol) args.unshift('--tol', String(pool.tol));
  if (pool.palette) args.unshift('--palette');
  return { name, args, ...(pool.probeMs ? { probeMs: pool.probeMs } : {}) };
});


// ---------------- args ----------------
const o = { dir: null, out: null, limit: Infinity, redo: false, prune: false,
  probePage: 1, shard: null, chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--dir') o.dir = resolve(process.cwd(), next());
  else if (a === '--out') o.out = resolve(process.cwd(), next());
  else if (a === '--limit') o.limit = parseInt(next(), 10);
  else if (a === '--redo') o.redo = true;
  else if (a === '--prune') o.prune = true;
  else if (a === '--probe-page') o.probePage = parseInt(next(), 10);
  else if (a === '--shard') { const m = /^(\d+)\/(\d+)$/.exec(next()); if (!m) { console.error('--shard i/n'); process.exit(2); } o.shard = [+m[1], +m[2]]; }
  else if (a === '--chrome') o.chrome = next();
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!o.dir || !existsSync(o.dir)) { console.error('need --dir <folder>'); process.exit(2); }
o.out ??= o.dir.replace(/[\\/]+$/, '') + '_ocr';

// ---------------- helpers ----------------
function* walkPdfs(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkPdfs(p);
    else if (/\.pdf$/i.test(e.name)) yield p;
  }
}

// run blind-read as the gate does; -> { lines, glyphs, unread, frags } | null.
// timeoutMs kills a wedged read (a garbage-input pathology in any rung must
// cost one budget, never the batch — the palette-LUT hang on EFTA00009676
// took this exact shape before it was root-caused).
function runRead(pdfPath, rungArgs, extra, timeoutMs) {
  const r = spawnSync(process.execPath, ['blind-read.mjs', '--pdf', pdfPath, ...rungArgs, ...extra],
    { cwd: __dirname, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT') return 'timeout';
  if (r.status !== 0 || r.error) return null;
  const m = /(\d+) lines, (\d+) glyphs, (\d+) unreadable/.exec(r.stdout);
  if (!m) return null;
  const f = /(\d+) box fragments/.exec(r.stdout);
  return { lines: +m[1], glyphs: +m[2], unread: +m[3], frags: f ? +f[1] : 0 };
}

// full read; on doc-level timeout fall back to per-page reads — a single
// pathological page (e.g. an embedded scan grinding the engine under the
// family LUT: EFTA00040347 p4 ran >5 min alone) must cost one page budget
// and an honest skip marker, never the whole transcript.
function fullRead(pdfPath, rungArgs, numPages, outTxt) {
  const full = runRead(pdfPath, rungArgs, ['--all', '--out', outTxt], 300000 + 5000 * numPages);
  if (full !== 'timeout') return full;
  const tot = { lines: 0, glyphs: 0, unread: 0, frags: 0, pagesSkipped: [] };
  const parts = [];
  for (let pno = 1; pno <= numPages; pno++) {
    const tmp = `${outTxt}.p${pno}`;
    const p = runRead(pdfPath, rungArgs, ['--page', String(pno), '--out', tmp], 60000);
    if (!p || p === 'timeout') {
      tot.pagesSkipped.push(pno);
      parts.push(`[page ${pno} unread: ${p === 'timeout' ? 'engine budget exceeded' : 'read error'}]`);
    } else {
      tot.lines += p.lines; tot.glyphs += p.glyphs; tot.unread += p.unread; tot.frags += p.frags;
      parts.push(readFileSync(tmp, 'utf8').replace(/\n$/, ''));
    }
    rmSync(tmp, { force: true });
  }
  writeFileSync(outTxt, parts.join('\n') + '\n');
  return tot;
}

// ---------------- browser session (lazy: only if a doc needs rasterizing) ----
let session = null, tabDocs = 0;
// pdf.js can hang FOREVER on a pathological PDF (EFTA00009676 wedged the
// first smoke run) and puppeteer's evaluate has no timeout — race every
// in-page step and reset the tab on loss, so one bad doc costs its budget,
// never the batch.
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${what} after ${ms} ms`)), ms);
  t.unref?.();
})]);
async function initTab(s) {
  await s.page?.close().catch(() => {});
  s.page = await s.browser.newPage();
  await suppressAppInit(s.page);
  await s.page.goto(`${s.base}/src/training.html`, { waitUntil: 'load' });
  await s.page.waitForFunction(
    () => typeof extractEmbeddedImages !== 'undefined' && typeof gray !== 'undefined' &&
      typeof window.pdfjsLib !== 'undefined', { timeout: 15000 });
  s.page.setDefaultTimeout(300000);
  await s.page.addScriptTag({ path: resolve(__dirname, 'raster-cache-browser.js') });
  tabDocs = 0;
}
// after a timeout the renderer may be spinning in pdf.js — even a polite tab
// close can stall on the CDP protocol timeout. Kill Chrome outright; the next
// doc relaunches lazily (~3 s, cheap next to the budget the bad doc burned).
function killSession() {
  if (!session) return;
  try { session.browser.process()?.kill('SIGKILL'); } catch {}
  try { session.browser.close().catch(() => {}); } catch {}
  try { session.server.kill(); } catch {}
  session = null;
}
async function ensureSession() {
  if (session) return session;
  if (!o.chrome || !existsSync(o.chrome)) throw new Error('no Chrome found (pass --chrome)');
  const port = await freePort();
  const s = { base: `http://localhost:${port}` };
  s.server = spawn(process.execPath, ['tools/serve.mjs', '--no-browser', '--port', String(port)],
    { cwd: REPO, stdio: 'ignore' });
  await waitForServer(s.base);
  s.browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  await initTab(s);
  return session = s;
}

// rasterize every uncached page of pdfPath via the staged copy; -> numPages
async function rasterize(pdfPath, cache) {
  const s = await ensureSession();
  if (tabDocs++ >= 25) { await session.page.close().catch(() => {}); await initTab(s); } // pdf.js leaks across docs
  mkdirSync(STAGING, { recursive: true });
  const staged = join(STAGING, `${cache.key}.pdf`);
  copyFileSync(pdfPath, staged);
  try {
    const { numPages } = await withTimeout(s.page.evaluate(setupInPage,
      { pdfUrl: `${s.base}/${relative(REPO, staged).replace(/\\/g, '/')}` }), 120000, 'pdf parse');
    cache.writeMeta(numPages, basename(pdfPath));
    for (let pno = 1; pno <= numPages; pno++) {
      if (cache.havePage(pno)) continue;
      cache.writePage(pno,
        (await withTimeout(s.page.evaluate(rasterPageInPage, { pno }), 60000, `page ${pno}`)).cachePut);
    }
    return numPages;
  } catch (e) {
    killSession();                                       // renderer may be wedged — hard reset
    throw e;
  } finally { rmSync(staged, { force: true }); }
}

// ---------------- main ----------------
async function main() {
  let files = [...walkPdfs(o.dir)];
  if (o.shard) files = files.filter((_, i) => i % o.shard[1] === o.shard[0]);
  mkdirSync(o.out, { recursive: true });
  // resume set = union of ALL shard manifests (shards may have been re-split)
  const manifestPath = join(o.out, o.shard ? `manifest-${o.shard[0]}of${o.shard[1]}.jsonl` : 'manifest.jsonl');
  const done = new Map();
  if (!o.redo)
    for (const mf of readdirSync(o.out).filter(f => /^manifest.*\.jsonl$/.test(f)))
      for (const l of readFileSync(join(o.out, mf), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const e = JSON.parse(l); done.set(e.file, e); } catch {}
      }
  console.log(`${files.length} PDFs under ${o.dir}` +
    (o.shard ? ` (shard ${o.shard[0]}/${o.shard[1]})` : '') + ` (${done.size} already in manifests)`);

  const tally = {};
  let processed = 0;
  const t0 = Date.now();
  for (const pdfPath of files) {
    if (processed >= o.limit) break;
    const rel = relative(o.dir, pdfPath).replace(/\\/g, '/');
    if (done.has(rel)) continue;
    processed++;
    const entry = { file: rel, ts: new Date().toISOString() };
    const t = Date.now();
    try {
      const cache = await openRasterCache(pdfPath, REPO);
      entry.key = cache.key;
      let numPages = cache.numPages;
      if (!cache.haveAll(numPages)) numPages = await rasterize(pdfPath, cache);
      entry.pages = numPages;

      // probe every rung on one page, then full-read the winner
      const probeLadder = (pno, probes, tag = '') => {
        let best = null;
        for (const rung of RUNGS) {
          const p = runRead(pdfPath, rung.args, ['--page', String(pno)], rung.probeMs ?? 60000);
          if (!p || p === 'timeout') { probes[rung.name + tag] = p ? 'timeout' : 'error'; continue; }
          probes[rung.name + tag] = `${p.lines}/${p.glyphs}/${p.unread}`;
          if (!best || p.unread < best.p.unread ||
              (p.unread === best.p.unread && p.glyphs > best.p.glyphs)) best = { rung, p };
          // early accept (speed only — selection is min-□ regardless): a clean
          // or overwhelmingly-clean probe on an earlier (= more likely) rung
          // ends the ladder; families with constant graphic remainders (the
          // nimbusrom red footer) never probe fully clean.
          if (p.glyphs > 0 && (p.unread === 0 || p.glyphs >= 50 * p.unread)) break;
        }
        return best;
      };
      const probePage = Math.min(o.probePage, numPages);
      entry.probes = {};
      let best = probeLadder(probePage, entry.probes);
      // Interior re-probe (FINDINGS-nimbusrom sub-family #3): the court
      // family's P1 is an ornate cover NO rung reads — EFTA00316714 sat in
      // the manifest as 'no-read' until hand-probed at p3. When every rung
      // fails on page 1 of a multi-page doc, one interior page gets a second
      // chance before the no-read verdict.
      if ((!best || (best.p.glyphs === 0 && best.p.unread > 0)) &&
          probePage === 1 && numPages >= 3) {
        const retry = probeLadder(3, entry.probes, '@p3');
        if (retry && retry.p.glyphs > 0) best = retry;
      }
      if (!best || (best.p.glyphs === 0 && best.p.unread > 0)) {
        entry.status = 'no-read';
      } else if (best.p.glyphs === 0 && best.p.unread === 0 && numPages === 1) {
        entry.status = 'empty';
      } else {
        const outTxt = join(o.out, rel.replace(/\.pdf$/i, '.txt'));
        mkdirSync(dirname(outTxt), { recursive: true });
        const full = fullRead(pdfPath, best.rung.args, numPages, outTxt);
        if (!full) entry.status = 'read-error';
        else {
          Object.assign(entry, { rung: best.rung.name, ...full });
          entry.status = full.glyphs === 0 ? (full.unread ? 'no-read' : 'empty')
            : full.unread === 0 ? 'exact'
            : full.unread > 4 * full.glyphs ? 'no-read'   // a scan's stray tol-matches are not a read
            : 'partial';
          if (entry.pagesSkipped?.length && entry.status === 'exact') entry.status = 'partial';
          if (!entry.pagesSkipped?.length) delete entry.pagesSkipped;
        }
      }
      if (o.prune && entry.key) rmSync(join(__dirname, 'raster-cache', entry.key), { recursive: true, force: true });
    } catch (e) {
      entry.status = 'raster-error';
      entry.error = String(e).slice(0, 300);
    }
    entry.secs = +((Date.now() - t) / 1000).toFixed(1);
    appendFileSync(manifestPath, JSON.stringify(entry) + '\n');
    tally[entry.status] = (tally[entry.status] || 0) + 1;
    const detail = entry.rung ? `${entry.rung}: ${entry.lines}L/${entry.glyphs}g/${entry.unread}□` : (entry.error || '');
    console.log(`[${processed}] ${entry.status.padEnd(12)} ${rel} ${detail} (${entry.secs}s)`);
  }

  console.log(`\n${processed} docs in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min → ${o.out}`);
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(12)} ${v}`);
  if (session) { await session.browser.close().catch(() => {}); session.server.kill(); }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => {
  if (session) { session.browser?.close().catch(() => {}); session.server?.kill(); }
});

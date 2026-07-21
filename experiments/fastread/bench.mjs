// bench.mjs — phase-split speed benchmark for the blind reader's hot path.
//
// Measures, on one document's cached rasters (default corpus/big.pdf, all
// pages pre-decoded into RAM so pure read speed is isolated from IO/zlib):
//
//   sol8    : "speed of light" — one byte-at-a-time streaming pass over every
//             page byte (the honest single-thread JS floor for ANY reader
//             that must look at every pixel once)
//   sol32   : same pass word-at-a-time (Uint32, white-word skip) — what the
//             floor becomes if white space is skipped 4 bytes at a time
//   detect  : Engine.detectObjects per page
//   bands   : Engine.findBands on the detect mask
//   read    : full Engine.readPage (detection recomputed, same as a real run)
//
// The read phase hashes the glyph stream (baseline, font, every ch@pen, every
// fail column) and compares it against baseline.json — an optimization that
// changes ANY of it is rejected as wrong, not fast. First run records.
//
//   node bench.mjs                      # big.pdf, engine = ../../src/ocr-engine.js
//   node bench.mjs --pages 40 --reps 5  # quick iteration on a slice
//   node bench.mjs --engine candidate/ocr-engine.js   # race a hacked copy
//   node bench.mjs --doc v3 --record    # (re-)record the baseline hash
//
// A candidate only graduates to src/ after: identical hash here on the FULL
// doc, then npm test + npm run gate.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { materializeSet } from '../../tools/glyph-bundle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const o = { doc: 'big', pages: 0, reps: 3, record: false, engine: null, glyphs: ['times16'] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--doc') o.doc = next();
  else if (a === '--pages') o.pages = parseInt(next(), 10);
  else if (a === '--reps') o.reps = parseInt(next(), 10);
  else if (a === '--record') o.record = true;
  else if (a === '--engine') o.engine = next();
  else if (a === '--glyphs') o.glyphs = next().split(',');
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}

const enginePath = o.engine ? resolve(process.cwd(), o.engine) : join(REPO, 'src', 'ocr-engine.js');
const Engine = createRequire(import.meta.url)(enginePath);

// ---- rasters (mode-1 GRY1 only — pick a grayscale doc for racing) ----
function readGray(path) {
  const raw = gunzipSync(readFileSync(path));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  if (hdr[0] !== 0x31595247) throw new Error(`bad GRY1 magic: ${path}`);
  const mode = hdr[1], w = hdr[2], h = hdr[3];
  if (mode === 0) return null;
  if (mode !== 1) throw new Error(`bench handles mode-1 (gray) rasters only, got mode ${mode}`);
  // compact copy: drop the gz buffer, and pad to a multiple of 4 so the
  // Uint32 sol pass can view it (pad bytes are white)
  const gray = new Uint8Array((w * h + 3) & ~3).fill(255);
  gray.set(new Uint8Array(raw.buffer, raw.byteOffset + 16, w * h));
  return { w, h, gray: gray.subarray(0, w * h), padded: gray };
}
function loadPages() {
  const pdf = join(REPO, 'corpus', `${o.doc}.pdf`);
  const key = createHash('sha256').update(readFileSync(pdf)).digest('hex').slice(0, 16);
  const dir = join(REPO, 'tools', 'raster-cache', key);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const n = o.pages > 0 ? Math.min(o.pages, meta.numPages) : meta.numPages;
  const pages = [];
  for (let p = 1; p <= n; p++) {
    const pg = readGray(join(dir, `page-${String(p).padStart(4, '0')}.gray.gz`));
    if (pg) pages.push({ pno: p, ...pg });
  }
  return pages;
}
function loadSet(file) {
  const s = materializeSet(file);
  const stem = s.font.replace(/_\d+.*$/, '');
  return { ...s, fontFile: `C:/Windows/Fonts/${stem || 'times'}.ttf` };
}

// ---- timing ----
const ms = () => Number(process.hrtime.bigint()) / 1e6;
function best(reps, fn) {                 // best-of-reps: least-noise estimate
  let b = Infinity, r;
  for (let i = 0; i < reps; i++) { const t = ms(); r = fn(); b = Math.min(b, ms() - t); }
  return { best: b, r };
}

async function main() {
  console.log(`engine: ${enginePath}`);
  let t = ms();
  const pages = loadPages();
  const decodeMs = ms() - t;
  const bytes = pages.reduce((s, p) => s + p.gray.length, 0);
  const MB = bytes / 1e6;
  console.log(`${o.doc}: ${pages.length} pages, ${MB.toFixed(1)} MB gray  (decode+load ${(decodeMs / 1000).toFixed(1)}s, untimed below)\n`);

  const row = (name, msTotal, extra = '') => console.log(
    name.padEnd(7) + `${(msTotal / 1000).toFixed(3).padStart(8)} s ` +
    `${(MB / (msTotal / 1000)).toFixed(0).padStart(7)} MB/s ` +
    `${(msTotal / pages.length).toFixed(2).padStart(7)} ms/page  ${extra}`);

  // sol8: every byte once, byte loads
  let inkPx = 0;
  const sol8 = best(o.reps, () => {
    let ink = 0;
    for (const p of pages) { const g = p.gray; for (let i = 0; i < g.length; i++) if (g[i] < 255) ink++; }
    return ink;
  });
  inkPx = sol8.r;
  row('sol8', sol8.best, `<- floor: every byte once (${(100 * inkPx / bytes).toFixed(1)}% of bytes are ink)`);

  // sol32: white words skipped 4-at-a-time
  const words = pages.map(p => new Uint32Array(p.padded.buffer, 0, p.padded.length >> 2));
  const sol32 = best(o.reps, () => {
    let ink = 0;
    for (const wds of words) for (let i = 0; i < wds.length; i++) {
      const v = wds[i];
      if (v === 0xFFFFFFFF) continue;
      if ((v & 0xFF) < 255) ink++; if (((v >>> 8) & 0xFF) < 255) ink++;
      if (((v >>> 16) & 0xFF) < 255) ink++; if ((v >>> 24) < 255) ink++;
    }
    return ink;
  });
  if (sol32.r !== inkPx) throw new Error('sol32 ink count mismatch — padding bug');
  row('sol32', sol32.best, '<- floor if white is skipped word-at-a-time');

  // detect: fresh page wrappers so readPage's memo can't leak in
  const det = best(o.reps, () =>
    pages.map(p => Engine.detectObjects({ w: p.w, h: p.h, gray: p.gray })));
  row('detect', det.best);

  // bands on the detect masks
  const bands = best(o.reps, () =>
    pages.map((p, i) => Engine.findBands(p, det.r[i].mask)));
  row('bands', bands.best);

  // full read — fresh wrappers again: detection recomputed, like a real run
  const sets = o.glyphs.map(g => {
    const parts = g.split('+');
    return parts.length > 1 ? Engine.unionSets(parts.map(loadSet)) : loadSet(g);
  });
  const carry = { last: null, picks: new Map() };
  const hash = createHash('sha256');
  let totLines = 0, totGlyphs = 0, totFails = 0;
  t = ms();
  for (const p of pages) {
    const { lines } = await Engine.readPage({ w: p.w, h: p.h, gray: p.gray }, sets, { tol: 0, carry });
    for (const L of lines) {
      if (!L.set) { if (!L.fragOnly) { totFails++; hash.update(`□@${L.top}\n`); } continue; }
      totLines++; totGlyphs += L.glyphs.length; totFails += L.fails.length;
      hash.update(`${L.baseline}|${L.phy}|${L.font}|`);
      for (const g of L.glyphs) hash.update(`${g.ch}@${g.pen.toFixed(3)};`);
      hash.update(`|F${L.fails.join(',')}\n`);
    }
  }
  const readMs = ms() - t;
  const digest = hash.digest('hex').slice(0, 16);
  row('read', readMs, `${totLines} lines, ${totGlyphs} glyphs, ${totFails} □`);

  // baseline: the correctness gate of the race
  const balFile = join(__dirname, 'baseline.json');
  const balKey = `${o.doc}:${o.pages || 'all'}:${o.glyphs.join(',')}`;
  const bal = existsSync(balFile) ? JSON.parse(readFileSync(balFile, 'utf8')) : {};
  if (o.record || !bal[balKey]) {
    bal[balKey] = { digest, totLines, totGlyphs, totFails, recorded: new Date().toISOString().slice(0, 10) };
    writeFileSync(balFile, JSON.stringify(bal, null, 1));
    console.log(`\nbaseline ${o.record ? 'RE-' : ''}RECORDED [${balKey}] ${digest}`);
  } else if (bal[balKey].digest === digest) {
    console.log(`\nglyph stream BYTE-IDENTICAL to baseline [${balKey}] ${digest}`);
  } else {
    console.log(`\n*** GLYPH STREAM DIFFERS from baseline [${balKey}]: ${digest} != ${bal[balKey].digest} — candidate is WRONG, not fast ***`);
    process.exitCode = 1;
  }
  console.log(`read is ${(readMs / sol8.best).toFixed(0)}× the every-byte-once floor, ` +
    `${(readMs / sol32.best).toFixed(0)}× the white-skip floor`);
}
main().catch(e => { console.error(e); process.exit(1); });

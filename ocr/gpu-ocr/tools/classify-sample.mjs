// classify-sample.mjs — corpus COMPOSITION by random sample, from pixels.
//
// The prioritization question for the 300 GB dataset is "what fraction can
// the known families read, and what is the biggest unknown cluster?" — the
// census can't answer it (it greps bytes, and its fingerprint is biased
// toward the one family it was built from). This tool draws a seeded random
// sample of the whole folder, classifies every doc with the pixel
// classifier, and reports family shares (per file AND page-weighted) plus a
// signature clustering of the unknowns (page dims × raster mode × palette)
// so the next hunt can be chosen by page-mass instead of anecdote.
//
//   node tools/classify-sample.mjs --n 1500 [--seed 42] [--samples 4]
//   node tools/classify-sample.mjs --summarize          # re-print from jsonl
//
// Resumable: results append to sample-composition-<seed>.jsonl per doc and
// already-done ids are skipped, so a bigger --n later EXTENDS the same
// sample (the seeded shuffle makes the first N picks stable). Page exports
// are deleted after each doc — only the jsonl accumulates.
import { readdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDoc, ensureTemplates, scoreLabels, DATASET } from './classify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const o = { n: 1500, seed: 42, samples: 4, dir: DATASET, summarize: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--n') o.n = +next();
  else if (a === '--seed') o.seed = +next();
  else if (a === '--samples') o.samples = +next();
  else if (a === '--dir') o.dir = next();
  else if (a === '--summarize') o.summarize = true;
  else { console.error(`unknown arg ${a}`); process.exit(1); }
}
const OUT = join(ROOT, `sample-composition-${o.seed}.jsonl`);

// mulberry32 — tiny seeded PRNG, good enough for a shuffle
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function loadDone() {
  const done = new Map();
  if (existsSync(OUT))
    for (const l of readFileSync(OUT, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const e = JSON.parse(l); done.set(e.id, rescore(e)); } catch {}
    }
  return done;
}

// stored entries carry the raw per-family tallies in `detail` — recompute
// labels with the CURRENT rule so threshold tuning never forces a re-run
function rescore(e) {
  if (!e.detail || ['no-image', 'unreadable', 'error'].includes(e.verdict)) return e;
  const best = {};
  for (const part of e.detail.split(' ')) {
    const m = /^(\w+):(\d+)$/.exec(part);
    if (m) best[m[1]] = +m[2];
  }
  const labels = scoreLabels(best);
  return { ...e, labels, verdict: labels.length ? labels.join('+') : 'none' };
}

function summarize(done) {
  const rs = [...done.values()];
  if (!rs.length) { console.log('no results yet'); return; }
  const totPages = rs.reduce((s, r) => s + (r.nPages || 0), 0);
  console.log(`\n=== composition, n=${rs.length} sampled docs, ` +
    `${totPages} pages (seed ${o.seed}) ===`);

  // family shares: a doc counts once per label; 'none'/'no-image'/... as-is
  const byClass = new Map();
  for (const r of rs) {
    const keys = r.labels?.length ? r.labels : [r.verdict];
    for (const k of keys) {
      const c = byClass.get(k) ?? { docs: 0, pages: 0 };
      c.docs++; c.pages += r.nPages || 0;
      byClass.set(k, c);
    }
  }
  const rows = [...byClass.entries()].sort((a, b) => b[1].pages - a[1].pages);
  console.log('\nclass            docs   doc%   pages  page%');
  for (const [k, c] of rows)
    console.log(`${k.padEnd(16)} ${String(c.docs).padStart(4)}  ${(100 * c.docs / rs.length).toFixed(1).padStart(5)}  ${String(c.pages).padStart(6)}  ${(100 * c.pages / totPages).toFixed(1).padStart(5)}`);
  const known = rs.filter(r => r.labels?.length);
  const knownPages = known.reduce((s, r) => s + (r.nPages || 0), 0);
  console.log(`\nany known family: ${known.length} docs (${(100 * known.length / rs.length).toFixed(1)}%), ` +
    `${knownPages} pages (${(100 * knownPages / totPages).toFixed(1)}%)`);

  // unknown clusters by cheap pixel signatures — the next-hunt ranking
  const clusters = new Map();
  for (const r of rs) {
    if (r.verdict !== 'none') continue;
    const m = r.meta ?? {};
    const key = `${m.dims ?? '?'} mode${(m.modes ?? []).join('/') || '?'} ` +
      `${m.lutPages ? 'palette' : 'nopal'}${m.emptyPages ? ` +${m.emptyPages}noimg` : ''}`;
    const c = clusters.get(key) ?? { docs: 0, pages: 0, ids: [] };
    c.docs++; c.pages += r.nPages || 0;
    if (c.ids.length < 3) c.ids.push(r.id);
    clusters.set(key, c);
  }
  const cl = [...clusters.entries()].sort((a, b) => b[1].pages - a[1].pages);
  console.log(`\nzero-hit clusters (${cl.length} signatures), by page-mass:`);
  console.log('signature                                  docs   pages  examples');
  for (const [k, c] of cl.slice(0, 15))
    console.log(`${k.padEnd(42)} ${String(c.docs).padStart(4)}  ${String(c.pages).padStart(6)}  ${c.ids.join(',')}`);
  if (cl.length > 15) console.log(`  … ${cl.length - 15} more signatures`);
}

if (o.summarize) { summarize(loadDone()); process.exit(0); }

console.log(`listing ${o.dir} …`);
const all = readdirSync(o.dir).filter(f => /\.pdf$/i.test(f)).sort();
console.log(`${all.length} PDFs; sampling ${o.n} with seed ${o.seed}`);
const r = rng(o.seed);
for (let i = all.length - 1; i > 0; i--) {           // Fisher–Yates, seeded
  const j = Math.floor(r() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}
const picks = all.slice(0, Math.min(o.n, all.length));

ensureTemplates();
const done = loadDone();
let processed = 0;
const t0 = Date.now();
for (const f of picks) {
  const id = f.replace(/\.pdf$/i, '');
  if (done.has(id)) continue;
  const t = Date.now();
  const res = await classifyDoc(join(o.dir, f), { samples: o.samples, cleanup: true });
  res.secs = +((Date.now() - t) / 1000).toFixed(1);
  appendFileSync(OUT, JSON.stringify(res) + '\n');
  done.set(id, res);
  processed++;
  console.log(`[${done.size}/${picks.length}] ${id} ${String(res.nPages).padStart(4)}pp -> ` +
    `${res.verdict} (${res.secs}s)`);
}
console.log(`\n${processed} new docs in ${((Date.now() - t0) / 60000).toFixed(1)} min -> ${OUT}`);
summarize(done);

// classify.mjs — pixel-level renderer-family classifier for the F:\ dataset.
//
// The census greps BYTES; the trust rule says pixels are the only ground
// truth. This tool answers "which face/family is this doc" from PIXELS:
// sample interior pages (the court family's P1 is an ornate cover the P1
// probe famously misses), decode them mupdf-direct with per-page palette
// LUTs, run ONE gpu-ocr launch with every registered family's template sets,
// and score the per-SET assembled-glyph tallies the exe emits (--classify).
//
//   node tools/classify.mjs <pdf> [<pdf>...]      # classify docs
//   node tools/classify.mjs --labeled             # this week's labeled docs
//                                                 # -> confusion matrix
//   --samples N    interior pages to sample (default 5)
//   --keep         keep data/classify/<doc> page exports (default: reuse)
//
// Two kernel passes per doc: tol 0 for the exact families, tol 2 ONLY for
// the calibri tally (its per-page harvest wobble is ±1 by proof; at tol 0 it
// under-fires). tol 2 tallies for the OTHER families are ignored — the
// linear law is a ±1 byte shift, so tol 2 would let lin/no-lin twins
// cross-fire and destroy exactly the discrimination this tool exists for.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'build', 'gpu-ocr.exe');
const DATASET = 'F:\\_Epstein\\dataset9-more-complete';

// family -> template sets (npz stems). Sets fire per family; a doc's verdict
// is the dominant family by assembled glyphs on its best sampled page.
// Gray companion sets (g35/g27/g118) are tol-2 material — left out, the
// black body faces carry the signal.
const FAMILIES = {
  corpusTimes: ['times_16', 'timesbd_16', 'timesi_16'],
  arial: ['arial_16'],
  courier13: ['cour_13'],
  nimbus791: ['nimbus_791'],
  nimbusromLin: ['nimbusromlin_1024', 'nimbusrombdlin_1024', 'nimbusromilin_1024', 'tnrlin_1024'],
  nimbusromCourt: ['nimbusrom_1024', 'nimbusrombd_1024', 'nimbusromi_1024'],
  censcbkCourt: ['censcbk_1198', 'censcbkbd_1198', 'censcbki_1198'],
  calibri: ['calibri102mid_1024', 'calibrib102mid_1024', 'calibri102g23_1024'],
};
const TOL2_FAMILIES = new Set(['calibri']);
const ALL_SETS = Object.values(FAMILIES).flat();
const SET_FAMILY = new Map(Object.entries(FAMILIES).flatMap(([f, ss]) => ss.map(s => [s, f])));

// this week's labeled docs — the confusion-matrix deliverable
const LABELED = [
  { id: 'EFTA00316714', expect: 'nimbusromCourt' },
  { id: 'EFTA00610965', expect: 'nimbusromCourt' },
  { id: 'EFTA00615869', expect: 'nimbusromCourt' },
  { id: 'EFTA00093044', expect: 'censcbkCourt' },
  { id: 'EFTA00039208', expect: 'nimbusromLin' },
  { id: 'EFTA00039421', expect: 'nimbusromLin' },
  { id: 'EFTA00751637', expect: 'nimbus791' },
  // the calibri pair lives in the repo's NEW/ triage folder, not on F:\
  { id: 'EFTA00038617', expect: 'calibri', path: resolve(ROOT, '..', '..', 'NEW', 'calibri', 'EFTA00038617.pdf') },
  { id: 'EFTA01649149', expect: 'calibri', path: resolve(ROOT, '..', '..', 'NEW', 'calibri', 'EFTA01649149.pdf') },
  { id: 'EFTA00281516', expect: 'none' },   // resample-render class (triage law: skip)
  { id: 'EFTA00240536', expect: 'none' },   // skewed scan (rotation terms)
];

// verdict threshold (tuned on the labeled run): a family is PRESENT if some
// sampled page assembles this many of its glyphs. Verdicts are MULTI-LABEL —
// eDiscovery compilations really do mix families per section (EFTA00093044:
// censcbk brief p3 + old-rev NimbusRoman p382 in one doc); a dominance rule
// would erase exactly that structure. Observed cross-fire tops out well
// below the floor (≤232, and that one looks like REAL corpus-TNR16 pixels).
const MIN_GLYPHS = 300;

const o = { samples: 5, labeled: false, docs: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--samples') o.samples = +next();
  else if (a === '--labeled') o.labeled = true;
  else o.docs.push(a);
}
if (o.labeled) o.docs = LABELED.map(l => l.path ?? join(DATASET, l.id + '.pdf'));
if (!o.docs.length) { console.error('usage: node tools/classify.mjs <pdf>... | --labeled'); process.exit(1); }

const node = process.execPath;
function ensureTemplates() {
  for (const s of ALL_SETS) {
    if (existsSync(join(ROOT, 'data', 'templates', `${s}.tpl`))) continue;
    console.error(`  exporting templates ${s}`);
    execFileSync(node, [join(ROOT, 'tools', 'export-templates.mjs'), '--set', `${s}.npz`],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

// interior sample: never p1/p2 (cover/banner pages miss the family), spread
// over the doc so one bad region (exhibit scans) cannot dominate
function samplePages(n) {
  if (n <= 2) return [1, 2].slice(0, n);
  const want = Math.min(o.samples, n - 2);
  const picks = new Set();
  for (let k = 0; k < want; k++)
    picks.add(Math.min(n, 3 + Math.round((n - 3) * (k / Math.max(1, want - 1)))));
  return [...picks].sort((a, b) => a - b);
}

async function countPages(pdf) {
  const mupdf = await import('mupdf');
  try { return mupdf.Document.openDocument(readFileSync(pdf), 'application/pdf').countPages(); }
  catch { return 0; }
}

function runExe(pagesDir, tol) {
  const args = [];
  for (const s of ALL_SETS) args.push('--templates', join(ROOT, 'data', 'templates', `${s}.tpl`));
  args.push('--pages', pagesDir, '--out', join(ROOT, 'out', 'classify-tmp'),
    '--classify', '--tol', String(tol));
  const stdout = execFileSync(EXE, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pages = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('CLASSIFY ')) pages.push(JSON.parse(line.slice(9)));
  }
  return pages;
}

// per page: family glyphs = sum of member-set assembled glyphs
function familyTally(page, tol2) {
  const fam = Object.fromEntries(Object.keys(FAMILIES).map(f => [f, 0]));
  for (const [set, [glyphs]] of Object.entries(page.sets)) {
    const f = SET_FAMILY.get(set);
    if (TOL2_FAMILIES.has(f) !== tol2) continue;
    fam[f] += glyphs;
  }
  return fam;
}

async function classifyDoc(pdf) {
  const id = basename(pdf).replace(/\.pdf$/i, '');
  const nPages = await countPages(pdf);
  if (!nPages) return { id, verdict: 'unreadable', nPages: 0, detail: '' };
  const pages = samplePages(nPages);
  const dir = join(ROOT, 'data', 'classify', id);
  if (!existsSync(join(dir, 'pages.json'))) {
    execFileSync(node, [join(ROOT, 'tools', 'export-pages.mjs'), '--pdf', pdf, '--out', dir,
      '--mupdf', '--palette', '--pages', pages.join(',')],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
  }
  const t0 = runExe(dir, 0), t2 = runExe(dir, 2);
  // best sampled page per family; verdict from the overall best page
  const best = Object.fromEntries(Object.keys(FAMILIES).map(f => [f, 0]));
  for (const p of t0) for (const [f, g] of Object.entries(familyTally(p, false)))
    best[f] = Math.max(best[f], g);
  for (const p of t2) for (const [f, g] of Object.entries(familyTally(p, true)))
    best[f] = Math.max(best[f], g);
  const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
  const labels = ranked.filter(([, g]) => g >= MIN_GLYPHS).map(([f]) => f);
  const verdict = labels.length ? labels.join('+') : 'none';
  const detail = ranked.filter(([, g]) => g > 0).slice(0, 4)
    .map(([f, g]) => `${f}:${g}`).join(' ');
  return { id, verdict, labels, nPages, sampled: pages.length, detail };
}

ensureTemplates();
const results = [];
for (const pdf of o.docs) {
  const r = await classifyDoc(pdf);
  results.push(r);
  console.log(`${r.id}  ${String(r.nPages).padStart(4)}pp  -> ${r.verdict.padEnd(15)} (${r.detail || 'no hits'})`);
}

if (o.labeled) {
  console.log('\nconfusion matrix (rows = truth, cols = verdict; multi-label' +
    ' verdicts count as correct when they contain the truth):');
  const byId = new Map(results.map(r => [r.id, r]));
  const cells = new Map();
  let ok = 0;
  for (const l of LABELED) {
    const r = byId.get(l.id);
    const v = r?.verdict ?? 'unreadable';
    cells.set(`${l.expect}|${v}`, (cells.get(`${l.expect}|${v}`) ?? 0) + 1);
    if (l.expect === 'none' ? v === 'none' : (r?.labels ?? []).includes(l.expect)) ok++;
  }
  const rows = [...new Set(LABELED.map(l => l.expect))];
  const cols = [...new Set([...rows, ...results.map(r => r.verdict)])];
  const w = Math.max(...cols.map(c => c.length)) + 2;
  console.log(' '.repeat(16) + cols.map(c => c.padStart(w)).join(''));
  for (const r of rows)
    console.log(r.padEnd(16) + cols.map(c => String(cells.get(`${r}|${c}`) ?? '').padStart(w)).join(''));
  console.log(`\n${ok}/${LABELED.length} correct`);
}

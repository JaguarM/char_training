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
//
// classify-sample.mjs imports the core (classifyDoc/ensureTemplates) for the
// corpus composition survey — the CLI below is a thin wrapper around it.
//
// Two kernel passes per doc: tol 0 for the exact families, tol 2 ONLY for
// the calibri tally (its per-page harvest wobble is ±1 by proof; at tol 0 it
// under-fires). tol 2 tallies for the OTHER families are ignored — the
// linear law is a ±1 byte shift, so tol 2 would let lin/no-lin twins
// cross-fire and destroy exactly the discrimination this tool exists for.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'build', 'gpu-ocr.exe');
export const DATASET = 'F:\\_Epstein\\dataset9-more-complete';

// family -> template sets (npz stems). Sets fire per family; a doc's verdict
// is the families whose assembled glyphs clear the floor on some sampled
// page. Gray companion sets (g35/g27/g118) are tol-2 material — left out,
// the black body faces carry the signal.
export const FAMILIES = {
  corpusTimes: ['times_16', 'timesbd_16', 'timesi_16'],
  arial: ['arial_16'],
  courier13: ['cour_13'],
  nimbus791: ['nimbus_791'],
  nimbusromLin: ['nimbusromlin_1024', 'nimbusrombdlin_1024', 'nimbusromilin_1024', 'tnrlin_1024'],
  nimbusromCourt: ['nimbusrom_1024', 'nimbusrombd_1024', 'nimbusromi_1024'],
  // sans-body email family (COMPOSITION.md hunt #1, solved 07-22 late):
  // real Arial em64 1194, no-linear + per-page palette
  arialEmail: ['arial_1194', 'arialbd_1194', 'ariali_1194'],
  censcbkCourt: ['censcbk_1198', 'censcbkbd_1198', 'censcbki_1198'],
  calibri: ['calibri102mid_1024', 'calibrib102mid_1024', 'calibri102g23_1024'],
};
const TOL2_FAMILIES = new Set(['calibri']);
const ALL_SETS = Object.values(FAMILIES).flat();
const SET_FAMILY = new Map(Object.entries(FAMILIES).flatMap(([f, ss]) => ss.map(s => [s, f])));

// this week's labeled docs — the confusion-matrix validation set
export const LABELED = [
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

// verdict thresholds (tuned on the labeled run + the composition sample):
// a family is PRESENT if some sampled page assembles MIN_GLYPHS of its
// glyphs, OR — the short-document rule — at least MIN_SMALL with 10×
// dominance over every other family's best. The corpus median doc is a
// 1–2 page email whose whole text is ~150–300 glyphs; the absolute floor
// alone misses those entirely (the n=2000 sample put readable Times emails
// in 'none'). Dominance keeps the cross-fire guard: observed FALSE
// cross-fire tops out at ≤60 glyphs and always beside a dominant real
// family; real multi-family compilations (EFTA00093044) clear MIN_GLYPHS
// per family and are unaffected. Verdicts stay MULTI-LABEL.
export const MIN_GLYPHS = 300;
export const MIN_SMALL = 80;

// best: {family: bestPageGlyphs} -> ordered label list (shared by the CLI,
// the sampler, and any rescoring of stored tallies)
export function scoreLabels(best) {
  const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
  const labels = [];
  for (const [f, g] of ranked) {
    const other = Math.max(0, ...ranked.filter(([f2]) => f2 !== f).map(([, g2]) => g2));
    // dominance is only demanded against sub-floor families: cross-fire
    // (false matches inside another face's ink) tops out at ~60 glyphs and
    // always sits beside a dominant real family — but a short EMAIL is two
    // REAL faces on one page (Arial body 190 + Times header 141), and
    // requiring 10× there labeled genuinely-known docs 'none'.
    if (g >= MIN_GLYPHS || (g >= MIN_SMALL && (other >= MIN_SMALL || g >= 10 * other)))
      labels.push(f);
  }
  return labels;
}

const node = process.execPath;
export function ensureTemplates() {
  for (const s of ALL_SETS) {
    if (existsSync(join(ROOT, 'data', 'templates', `${s}.tpl`))) continue;
    console.error(`  exporting templates ${s}`);
    execFileSync(node, [join(ROOT, 'tools', 'export-templates.mjs'), '--set', `${s}.npz`],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

// sample = page 1 + an interior spread. P1 always rides along: scoring takes
// the MAX over sampled pages, so an ornate court cover contributes zeros
// (harmless) while the email corpus — where P1 IS the payload and interior
// pages are attachments — detects. (The original never-P1 rule guarded a
// pick-one-page probe; for max-scoring it only masked email bodies:
// EFTA01136215 read arialEmail in batch but classified 'none' off pages 3+.)
// The interior spread still keeps one bad region from dominating.
export function samplePages(n, want) {
  if (n <= 2) return [1, 2].slice(0, n);
  const picks = new Set([1]);
  const w = Math.min(want - 1, n - 2);
  for (let k = 0; k < w; k++)
    picks.add(Math.min(n, 3 + Math.round((n - 3) * (k / Math.max(1, w - 1)))));
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

// classify one PDF. Returns { id, verdict, labels, nPages, sampled, detail,
// meta } where meta carries the cheap clustering signatures read off the
// page export: dominant page dims, raster modes seen, palette-LUT pages,
// and pages with NO embedded image (a text-rendered PDF looks like that —
// mupdf-direct cannot see it and the verdict says 'no-image', a class of
// its own: those docs need the Chrome raster path, not a new family hunt).
export async function classifyDoc(pdf, { samples = 5, cleanup = false } = {}) {
  const id = basename(pdf).replace(/\.pdf$/i, '');
  const nPages = await countPages(pdf);
  if (!nPages) return { id, verdict: 'unreadable', labels: [], nPages: 0, detail: '', meta: {} };
  const pages = samplePages(nPages, samples);
  const dir = join(ROOT, 'data', 'classify', id);
  try {
    if (!existsSync(join(dir, 'pages.json'))) {
      execFileSync(node, [join(ROOT, 'tools', 'export-pages.mjs'), '--pdf', pdf, '--out', dir,
        '--mupdf', '--palette', '--pages', pages.join(',')],
        { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'pages.json'), 'utf8')).pages;
    const dimCount = new Map();
    const meta = { modes: new Set(), lutPages: 0, emptyPages: 0 };
    for (const p of manifest) {
      if (p.empty) { meta.emptyPages++; continue; }
      dimCount.set(`${p.w}x${p.h}`, (dimCount.get(`${p.w}x${p.h}`) ?? 0) + 1);
      meta.modes.add(p.mode);
      if (p.lut) meta.lutPages++;
    }
    meta.dims = [...dimCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    meta.modes = [...meta.modes].sort();
    if (!dimCount.size) {
      return { id, verdict: 'no-image', labels: [], nPages, sampled: pages.length, detail: '', meta };
    }
    // skip classes (user rule 07-22): pages that are not text pages.
    // Thumbnails (either side < 400 px) are photo attachments; landscape
    // rasters (w > h) are image exhibits — both unreadable by nature, and
    // the frontend should route them straight to "no text", not to a hunt.
    const [dw, dh] = meta.dims.split('x').map(Number);
    if (dw < 400 || dh < 400) {
      return { id, verdict: 'skip-thumbnail', labels: [], nPages, sampled: pages.length, detail: '', meta };
    }
    if (dw > dh) {
      return { id, verdict: 'skip-landscape', labels: [], nPages, sampled: pages.length, detail: '', meta };
    }
    const t0 = runExe(dir, 0), t2 = runExe(dir, 2);
    // best sampled page per family; labels from the per-family best page
    const best = Object.fromEntries(Object.keys(FAMILIES).map(f => [f, 0]));
    for (const p of t0) for (const [f, g] of Object.entries(familyTally(p, false)))
      best[f] = Math.max(best[f], g);
    for (const p of t2) for (const [f, g] of Object.entries(familyTally(p, true)))
      best[f] = Math.max(best[f], g);
    const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
    const labels = scoreLabels(best);
    const verdict = labels.length ? labels.join('+') : 'none';
    const detail = ranked.filter(([, g]) => g > 0).slice(0, 4)
      .map(([f, g]) => `${f}:${g}`).join(' ');
    return { id, verdict, labels, nPages, sampled: pages.length, detail, meta };
  } catch (e) {
    return { id, verdict: 'error', labels: [], nPages, sampled: pages.length,
      detail: String(e).slice(0, 120), meta: {} };
  } finally {
    if (cleanup) rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------- CLI ----------------
const isMain = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const o = { samples: 5, labeled: false, docs: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i], next = () => process.argv[++i];
    if (a === '--samples') o.samples = +next();
    else if (a === '--labeled') o.labeled = true;
    else o.docs.push(a);
  }
  if (o.labeled) o.docs = LABELED.map(l => l.path ?? join(DATASET, l.id + '.pdf'));
  if (!o.docs.length) { console.error('usage: node tools/classify.mjs <pdf>... | --labeled'); process.exit(1); }

  ensureTemplates();
  const results = [];
  for (const pdf of o.docs) {
    const r = await classifyDoc(pdf, { samples: o.samples });
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
}

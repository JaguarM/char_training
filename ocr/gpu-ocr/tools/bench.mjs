// bench.mjs — the gpu-ocr scoreboard. ONE command: materialize whatever is
// missing (templates from char_training npz sets, pages from its raster
// cache), run the matcher on every roster doc, score against the certified
// gate transcripts, and diff the deterministic integers against
// bench-baseline.json. This is gpu-ocr's equivalent of char_training's
// `npm run gate`: run it after every matcher/template change; DRIFT is a
// conversation, not necessarily a bug — accept intentional changes with
// --update.
//
//   node tools/bench.mjs                # full roster vs baseline
//   node tools/bench.mjs --doc big     # one roster entry
//   node tools/bench.mjs --update     # accept current numbers as baseline
//   node tools/bench.mjs --clean     # wipe regenerable data (pages/tpl/out)
//
// Everything under data/ and out/ is a disposable cache (~1.6 MB/page for
// pages); --clean deletes it all and the next run regenerates what it needs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from './compare.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CT = resolve(ROOT, '..', '..');          // the enclosing char_training repo
const EXE = join(ROOT, 'build', 'gpu-ocr.exe');

// ---- the roster: what a healthy gpu-ocr reads, and with which recipe ----
// sets are fontgen npz stems (char_training assets/fonts/<set>.npz, exported
// on demand to data/templates/<set>.tpl). They mirror the exact engine's
// registry POOLS for each doc, flattened to one naive union — gpu-ocr has no
// per-band groups. crop = [w, h, yoff] (see README; [3,11,-3] is the swept
// optimum for TNR16). 'big-tnr' pins the README/BENCHMARK single-set numbers
// so the documented sweep stays reproducible forever.
// email (needs the --quant law) and nimbusrom (needs --palette) are NOT
// benchable until the matcher learns those page laws — listed in README.
const ROSTER = [
  { doc: 'big-tnr', pdf: 'corpus/big.pdf', pages: 'big', ref: 'tools/gate-ref/big.txt',
    sets: ['times_16'], crop: [3, 11, -3] },
  { doc: 'big', pdf: 'corpus/big.pdf', pages: 'big', ref: 'tools/gate-ref/big.txt',
    sets: ['times_16', 'timesbd_16', 'timesi_16', 'cour_13', 'arial_16'], crop: [3, 11, -3] },
  { doc: 'v3', pdf: 'corpus/v3.pdf', pages: 'v3', ref: 'tools/gate-ref/v3.txt',
    sets: ['times_16', 'timesbd_16', 'timesi_16', 'cour_13', 'arial_16'], crop: [3, 11, -3] },
  // courier docs run UNCROPPED: the TNR-swept 3×11 window makes cropped
  // times templates fire inside Courier glyphs (~112% chars emitted, 0.4%
  // lines). Uncropped, over-emission vanishes; spaces come from the per-line
  // spaceAdv vote (Courier's uniform 7.418 cell vs Times' 4.0).
  { doc: 'courier_1', pdf: 'corpus/courier_1.pdf', pages: 'courier_1', ref: 'tools/gate-ref/courier_1.txt',
    sets: ['times_16', 'timesbd_16', 'timesi_16', 'cour_13'], crop: null },
  { doc: 'courier_2', pdf: 'corpus/courier_2.pdf', pages: 'courier_2', ref: 'tools/gate-ref/courier_2.txt',
    sets: ['times_16', 'timesbd_16', 'timesi_16', 'cour_13'], crop: null },
];

const BASELINE = join(ROOT, 'bench-baseline.json');

// ---- args ----
const o = { doc: null, update: false, clean: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--doc') o.doc = next();
  else if (a === '--update') o.update = true;
  else if (a === '--clean') o.clean = true;
  else { console.error(`unknown arg ${a}`); process.exit(1); }
}

if (o.clean) {
  for (const d of ['data/pages', 'data/templates', 'out'])
    rmSync(join(ROOT, d), { recursive: true, force: true });
  console.log('cleaned data/pages, data/templates, out — next run regenerates on demand');
  process.exit(0);
}
if (!existsSync(EXE)) { console.error(`no ${EXE} — run .\\build.ps1 first`); process.exit(1); }

const node = process.execPath;
function ensureTemplates(sets) {
  for (const s of sets) {
    const tpl = join(ROOT, 'data', 'templates', `${s}.tpl`);
    if (existsSync(tpl)) continue;
    console.log(`  exporting templates ${s}`);
    execFileSync(node, [join(ROOT, 'tools', 'export-templates.mjs'), '--set', `${s}.npz`],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
function ensurePages(entry) {
  const dir = join(ROOT, 'data', 'pages', entry.pages);
  if (existsSync(join(dir, 'pages.json'))) return dir;
  console.log(`  exporting pages ${entry.pages} (from ${entry.pdf})`);
  execFileSync(node, [join(ROOT, 'tools', 'export-pages.mjs'),
    '--pdf', join(CT, entry.pdf), '--out', dir],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  return dir;
}

// deterministic integers only — wall time is reported but never gated
function run(entry) {
  ensureTemplates(entry.sets);
  const pagesDir = ensurePages(entry);
  const outDir = join(ROOT, 'out', entry.doc);
  const args = [];
  for (const s of entry.sets) args.push('--templates', join(ROOT, 'data', 'templates', `${s}.tpl`));
  args.push('--pages', pagesDir, '--out', outDir);
  if (entry.crop) {
    args.push('--crop', String(entry.crop[0]), String(entry.crop[1]));
    if (entry.crop[2]) args.push('--crop-yoff', String(entry.crop[2]));
  }
  const stdout = execFileSync(EXE, args, { cwd: ROOT, encoding: 'utf8' });
  const m = /(\d+) pages: (\d+) lines, (\d+) glyphs, (\d+) hits — ([\d.]+) s wall/.exec(stdout);
  if (!m) throw new Error(`no summary line from gpu-ocr for ${entry.doc}:\n${stdout.slice(-500)}`);
  const s = score(join(outDir, 'all.txt'), join(CT, entry.ref));
  return {
    pages: +m[1], lines: +m[2], glyphs: +m[3], hits: +m[4], wall: +m[5],
    exact: s.exact, refLines: s.refLines, ourChars: s.ourChars, refChars: s.refChars,
  };
}

const GATED = ['pages', 'lines', 'glyphs', 'hits', 'exact', 'ourChars'];
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const roster = ROSTER.filter(e => !o.doc || e.doc === o.doc);
if (!roster.length) { console.error(`no roster entry '${o.doc}'`); process.exit(1); }

let drift = 0;
const results = {};
for (const entry of roster) {
  console.log(`${entry.doc} …`);
  const r = run(entry);
  results[entry.doc] = r;
  const b = baseline[entry.doc];
  const verdict = !b ? 'NEW'
    : GATED.every(k => b[k] === r[k]) ? 'PASS'
    : 'DRIFT ' + GATED.filter(k => b[k] !== r[k]).map(k => `${k} ${b[k]}→${r[k]}`).join(', ');
  if (verdict.startsWith('DRIFT')) drift++;
  console.log(`  ${r.pages}p  ${r.wall.toFixed(2)}s  chars ${r.ourChars}/${r.refChars}` +
    ` (${(100 * r.ourChars / r.refChars).toFixed(1)}%)  exact lines ${r.exact}/${r.refLines}` +
    ` (${(100 * r.exact / r.refLines).toFixed(1)}%)  [${verdict}]`);
}

if (o.update) {
  const merged = { ...baseline };
  for (const [k, r] of Object.entries(results)) {
    merged[k] = Object.fromEntries([...GATED, 'refLines', 'refChars'].map(g => [g, r[g]]));
  }
  writeFileSync(BASELINE, JSON.stringify(merged, null, 1) + '\n');
  console.log(`\nbaseline written: ${BASELINE}`);
} else if (drift) {
  console.log(`\n${drift} doc(s) DRIFTED — investigate, then --update if intentional`);
  process.exit(1);
} else {
  console.log('\nall PASS');
}

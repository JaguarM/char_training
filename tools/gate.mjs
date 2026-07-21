// gate.mjs — one-command regression gate (docs/README.md "The regression gate").
// Runs every gate document through blind-read.mjs, writes each transcript to
// an output directory, and byte-compares against a reference run. The
// COMMITTED reference is tools/gate-ref/ — the expected numbers ARE those
// files, not prose — and it is the default --ref when present:
//
//   npm run gate                            # run + certify vs tools/gate-ref
//   node gate.mjs --out gate-ref --ref none # re-record the reference (after
//                                           #   an INTENDED output change)
//
// The summary of each run (lines / glyphs / □ / frags / truth rows) is
// captured next to the transcript (<name>.summary) and compared too — a
// change in ANY number is the signal, not the absolute.
// App test (test-blind-app.mjs) and glyphs-check stay separate commands: this
// runner certifies the READER; run those after engine or exporter changes.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { POOLS } from './glyph-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Certified family read commands come from the ONE registry
// (tools/glyph-registry.mjs). Expected nimbusrom output: 223 lines /
// 13034 glyphs / 38 □ (red footer legend + P1 seal graphic only —
// ocr/FINDINGS-nimbusrom.md).
const LIN = POOLS.linear.glyphs;
const COURIER = POOLS.courierDoc.glyphs;
const NIMBUSROM = POOLS.nimbusrom.glyphs;

const DOCS = [
  { name: 'v3', args: ['--pdf', '../corpus/v3.pdf', '--all', '--truth', '../corpus/v3.txt'] },
  { name: 'big', args: ['--pdf', '../corpus/big.pdf', '--all', '--truth', '../corpus/big.txt'] },
  { name: 'email', args: ['--pdf', '../corpus/email.pdf', '--all', '--truth', '../corpus/email.txt', '--quant'] },
  { name: 'report', args: ['--raster', 'raster-cache/a42927acc2aaca91/page-0001.gray.gz',
    '--tol', '0', '--glyphs', LIN] },
  { name: 'courier_1', args: ['--pdf', '../corpus/courier_1.pdf', '--all', '--glyphs', COURIER] },
  { name: 'courier_2', args: ['--pdf', '../corpus/courier_2.pdf', '--all', '--glyphs', COURIER] },
  { name: 'nimbusrom', args: ['--pdf', '../corpus/nimbusrom.pdf', '--all', '--palette', '--tol', '0',
    '--glyphs', NIMBUSROM] },
];

let outDir = join(__dirname, 'gate-out'), refDir = null, refGiven = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--out') outDir = resolve(process.cwd(), next());
  else if (a === '--ref') { refGiven = true; const v = next(); refDir = v === 'none' ? null : resolve(process.cwd(), v); }
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!refGiven && existsSync(join(__dirname, 'gate-ref'))) refDir = join(__dirname, 'gate-ref');
mkdirSync(outDir, { recursive: true });

let fail = 0;
const t0 = Date.now();
for (const d of DOCS) {
  const outTxt = join(outDir, `${d.name}.txt`);
  const t = Date.now();
  const r = spawnSync(process.execPath, ['blind-read.mjs', ...d.args, '--out', outTxt],
    { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.log(`FAIL  ${d.name}: reader exited ${r.status}\n${(r.stderr || '').slice(-2000)}`);
    fail++; continue;
  }
  // summary = everything the run certifies (counts + truth diff rows), minus
  // the timing figure and the transcript path
  const summary = r.stdout.split('\n')
    .filter(l => l.trim() && !l.startsWith('wrote '))
    .map(l => l.replace(/, \d+\.\d+s$/, '')).join('\n') + '\n';
  writeFileSync(join(outDir, `${d.name}.summary`), summary);
  let verdict = `${secs}s`;
  if (refDir) {
    const same = (f) => existsSync(join(refDir, f)) &&
      readFileSync(join(outDir, f), 'utf8') === readFileSync(join(refDir, f), 'utf8');
    const txtOk = same(`${d.name}.txt`), sumOk = same(`${d.name}.summary`);
    if (txtOk && sumOk) verdict += '  BYTE-IDENTICAL';
    else { verdict += `  DIFFERS (${txtOk ? '' : 'transcript'}${!txtOk && !sumOk ? '+' : ''}${sumOk ? '' : 'summary'})`; fail++; }
  }
  console.log(`${d.name.padEnd(10)} ${summary.split('\n')[0]}  [${verdict}]`);
}
console.log(`\ngate: ${DOCS.length - fail}/${DOCS.length} ok, ${((Date.now() - t0) / 1000).toFixed(0)}s total` +
  (refDir ? ` (vs ${refDir})` : ''));
process.exit(fail ? 1 : 0);

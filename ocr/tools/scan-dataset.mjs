// scan-dataset.mjs — cheap byte-fingerprint triage of a PDF folder, built for
// the F:\ eDiscovery sets. NO rendering: reads each file once and greps the
// raw bytes for producer fingerprints, so thousands of files triage in
// drive-read time.
//
//   node tools/scan-dataset.mjs --dir "F:/_Epstein/dataset9-more-complete" [--limit N] [--csv out.csv]
//
// Columns:
//   indexed  — count of /Indexed /DeviceRGB colorspaces (the Nimbus-family
//              palette pages; ≈ page count in that family)
//   tnr      — 'TimesNewRoman' name appears (overlay claim OR real font)
//   embTNR   — a TimesNewRoman /FontFile2|3 embed marker near the name
//              (the real-TNR-subset mix proven in FINDINGS-nimbusrom.md)
//   dct/flate— page image filters seen (DCTDecode = JPEG family, needs tol;
//              FlateDecode+Indexed = lossless palette family, tol 0)
//   helv/cour— Helvetica / Courier base-font claims (→ Nimbus Sans/Mono)
//   brokenXref — xref keyword count is odd/low heuristic skipped; we flag
//              'startxref' missing instead (needs in-repo copy for pdf.js)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('dir', 'F:/_Epstein/dataset9-more-complete');
const LIMIT = +opt('limit', 0);
const CSV = opt('csv', null);
const MAXB = 64 * 1024 * 1024;      // skip giants; the family docs are ~1MB

const count = (s, needle) => {
  let n = 0, i = 0;
  while ((i = s.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
};

const files = readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
console.error(`${files.length} PDFs in ${DIR}`);
const rows = [];
let done = 0;
for (const f of files) {
  if (LIMIT && done >= LIMIT) break;
  const p = join(DIR, f);
  let sz;
  try { sz = statSync(p).size; } catch { continue; }
  if (sz > MAXB) { rows.push({ f, sz, skip: 'big' }); continue; }
  let s;
  try { s = readFileSync(p).toString('latin1'); } catch { continue; }
  const indexed = count(s, '/Indexed /DeviceRGB');
  const tnr = count(s, 'TimesNewRoman');
  // embedded TNR: a font descriptor mentioning TimesNewRoman with a FontFile
  let embTNR = 0;
  let i = 0;
  while ((i = s.indexOf('TimesNewRoman', i)) >= 0) {
    const win = s.slice(Math.max(0, i - 200), i + 1200);
    if (/\/FontFile[23]?\s/.test(win)) embTNR++;
    i += 13;
  }
  const row = {
    f, sz,
    indexed,
    tnr,
    embTNR,
    dct: count(s, '/DCTDecode'),
    flate: count(s, '/FlateDecode') > 0 ? 1 : 0,
    helv: count(s, 'Helvetica') > 0 ? 1 : 0,
    cour: /Courier/.test(s) ? 1 : 0,
    startxref: s.includes('startxref') ? 1 : 0,
  };
  rows.push(row);
  done++;
  if (done % 100 === 0) process.stderr.write(`\r  ${done}/${files.length}`);
}
process.stderr.write('\n');

const cand = rows.filter(r => !r.skip && r.indexed > 0 && r.tnr > 0);
const candEmb = cand.filter(r => r.embTNR > 0);
console.log(`\n${rows.length} scanned; ${cand.length} palette+TNR candidates; ${candEmb.length} with EMBEDDED TNR subsets`);
console.log('\nTop candidates (palette pages + embedded TNR), by page count:');
for (const r of candEmb.sort((a, b) => b.indexed - a.indexed).slice(0, 30))
  console.log(`  ${r.f}  pages~${r.indexed}  tnrRefs=${r.tnr} embTNR=${r.embTNR} dct=${r.dct} ${(r.sz / 1e6).toFixed(1)}MB`);
console.log('\nPalette+TNR without embed marker (pure builtin-substitution docs):');
for (const r of cand.filter(r => !r.embTNR).sort((a, b) => b.indexed - a.indexed).slice(0, 15))
  console.log(`  ${r.f}  pages~${r.indexed}  tnrRefs=${r.tnr} dct=${r.dct} ${(r.sz / 1e6).toFixed(1)}MB`);
if (CSV) {
  const hdr = 'file,size,indexed,tnr,embTNR,dct,flate,helv,cour,startxref';
  writeFileSync(CSV, hdr + '\n' + rows.filter(r => !r.skip).map(r =>
    [r.f, r.sz, r.indexed, r.tnr, r.embTNR, r.dct, r.flate, r.helv, r.cour, r.startxref].join(',')).join('\n') + '\n');
  console.log(`\nwrote ${CSV}`);
}

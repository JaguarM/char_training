// adopt-ocr-rows.mjs — one source-correction round: for every row where the
// dump DIVERGES MID-ROW from the source (a mismatch, not a truncation), adopt
// the OCR text — the pixels outvote the transcription. Truncated rows (OCR
// stopped early: missing template context, not a source error) are left alone.
//
//   node adopt-ocr-rows.mjs <dump.txt> <source.txt>
//
// Prints the number of adopted rows; exits 1 if any were adopted (so a driver
// loop knows to re-harvest), 0 when the source already matches everywhere.
import { readFileSync, writeFileSync } from 'node:fs';

const [dumpPath, srcPath] = process.argv.slice(2);
const ROWS = 54;
const chunk = p => {
  const L = readFileSync(p, 'utf8').replace(/\r/g, '').split('\n');
  let sep = 1;
  for (let i = ROWS; i < L.length - 1; i += ROWS + 1) if (L[i] !== '') { sep = 0; break; }
  const out = [];
  for (let i = 0; i < L.length; i += ROWS + sep) {
    const pg = L.slice(i, i + ROWS);
    if (!pg.some(l => l && l.trim()) && i + ROWS >= L.length) break;
    while (pg.length < ROWS) pg.push('');
    out.push(pg);
    if (i + ROWS >= L.length) break;
  }
  return out;
};

const dump = chunk(dumpPath);
const src = chunk(srcPath);
let adopted = 0;
const notes = [];
for (let p = 0; p < Math.min(dump.length, src.length); p++) {
  for (let r = 0; r < ROWS; r++) {
    const want = src[p][r] ?? '', got = (dump[p][r] ?? '').trimEnd();
    if (got === want.trimEnd()) continue;
    let i = 0;
    while (i < got.length && i < want.length && got[i] === want[i]) i++;
    const truncated = i === got.length && i < want.length;
    if (truncated) continue;               // OCR stopped early — not a source verdict
    if (!got && want.trim()) continue;     // OCR read nothing — don't blank a row
    src[p][r] = got;
    adopted++;
    if (notes.length < 12) notes.push(`P${p + 1} L${r}: "${want.slice(0, 30)}" -> "${got.slice(0, 30)}"`);
  }
}
writeFileSync(srcPath, src.map(pg => pg.join('\n')).join('\n\n') + '\n');
console.log(`adopted ${adopted} OCR rows into ${srcPath}`);
for (const n of notes) console.log('  ' + n);
process.exit(adopted ? 1 : 0);

// compare-dump.mjs — score a dump-ocr.mjs --out file against the ground-truth
// transcription, row by row. Both files hold pages separated by a blank line,
// one line per row (see bench/README.md).
//
//   node compare-dump.mjs out.txt ../source.txt
//
// Rows are classified: exact · truncated (OCR stopped early: output is a prefix
// of the source row) · mismatch (differs before the end). The char accuracy is
// matched-prefix chars over source chars. Exit code 0 only when every row is
// exact — the "repeat until it fits" loop keys off this.
import { readFileSync } from 'node:fs';

const [dumpPath, srcPath] = process.argv.slice(2);
if (!dumpPath || !srcPath) {
  console.error('usage: node compare-dump.mjs <dump.txt> <source.txt>');
  process.exit(2);
}
// Pages are fixed-shape: ROWS rows + one separator line each (dump-ocr writes
// exactly that). Splitting on blank lines would break on documents whose pages
// CONTAIN empty rows (an email body, a blank cover page).
const ROWS = 54;
const pages = p => {
  const lines = readFileSync(p, 'utf8').replace(/\r/g, '').split('\n');
  // Separator auto-detect (see synth-templates.mjs): blank line after each page,
  // or none when the file is exactly N·54 content lines.
  let sep = 1;
  for (let i = ROWS; i < lines.length - 1; i += ROWS + 1)
    if (lines[i] !== '') { sep = 0; break; }
  const out = [];
  for (let i = 0; i < lines.length; i += ROWS + sep) {
    const pg = lines.slice(i, i + ROWS);
    if (!pg.some(l => l && l.trim()) && i + ROWS >= lines.length) break;
    while (pg.length < ROWS) pg.push('');
    out.push(pg);
    if (i + ROWS >= lines.length) break;
  }
  return out;
};
const dump = pages(dumpPath);
const src = pages(srcPath);
// A partial dump ends before the source does — don't score pages it never OCR'd.
while (dump.length && dump[dump.length - 1].every(l => !l.trim()) &&
       !(src[dump.length - 1] ?? []).every(l => !l.trim())) dump.pop();

let rows = 0, exact = 0, trunc = 0, mism = 0, srcChars = 0, okChars = 0;
const mismatches = [];   // {page,row,col,got,want,context}
const truncated = [];    // {page,row,col(=len),nextChar}
const stopChar = new Map();  // source char at the first divergence → count

const nPages = Math.min(dump.length, src.length);
for (let p = 0; p < nPages; p++) {
  const dp = dump[p], sp = src[p];
  for (let r = 0; r < sp.length; r++) {
    const want = sp[r] ?? '';
    if (!want.length) continue;
    const got = (dp[r] ?? '').trimEnd();
    rows++; srcChars += want.length;
    let i = 0;
    while (i < got.length && i < want.length && got[i] === want[i]) i++;
    okChars += i;
    if (i === want.length && i === got.length) { exact++; continue; }
    const sc = want[i] ?? '(end)';
    stopChar.set(sc, (stopChar.get(sc) ?? 0) + 1);
    if (i === got.length && i < want.length) {
      trunc++;
      truncated.push({ page: p + 1, row: r, col: i, next: sc });
    } else {
      mism++;
      mismatches.push({ page: p + 1, row: r, col: i,
        got: got.slice(i, i + 12), want: want.slice(i, i + 12) });
    }
  }
}

console.log(`pages compared: ${nPages} (dump ${dump.length}, source ${src.length})`);
console.log(`rows: ${rows}  exact: ${exact} (${(100 * exact / rows).toFixed(2)}%)  ` +
  `truncated: ${trunc}  mismatched: ${mism}`);
console.log(`char accuracy: ${okChars}/${srcChars} (${(100 * okChars / srcChars).toFixed(3)}%)`);

if (stopChar.size) {
  const top = [...stopChar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\nsource char at first divergence (top): ` +
    top.map(([c, n]) => `'${c}'×${n}`).join('  '));
}
for (const [label, list] of [['mismatches', mismatches], ['truncations', truncated]]) {
  if (!list.length) continue;
  console.log(`\nfirst ${Math.min(10, list.length)} ${label}:`);
  for (const m of list.slice(0, 10)) {
    console.log(m.got !== undefined
      ? `  P${m.page} L${m.row} col ${m.col}: got "${m.got}" want "${m.want}"`
      : `  P${m.page} L${m.row} col ${m.col}: stopped before '${m.next}'`);
  }
}
process.exit(exact === rows ? 0 : 1);

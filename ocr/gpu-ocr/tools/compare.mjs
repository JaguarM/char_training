// compare.mjs — score our output against a reference transcript (e.g.
// char_training's certified tools/gate-ref/big.txt). Order-free multiset
// compare: how many reference lines did we reproduce exactly? Also reports a
// space-collapsed variant (missing glyphs leave space runs behind) and the
// per-character hit rate over non-space chars.
//
//   node tools/compare.mjs [--ours out/big/all.txt] [--ref <path>]
//
// bench.mjs imports score(); the CLI below is a thin wrapper around it.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const clean = s => s.split(/\r?\n/).filter(l => !/^=== page \d+ ===$/.test(l) && l.length);

function multisetHits(a, b, norm = s => s) {
  const pool = new Map();
  for (const l of b) { const k = norm(l); pool.set(k, (pool.get(k) ?? 0) + 1); }
  let n = 0;
  for (const l of a) {
    const k = norm(l);
    if (pool.get(k) > 0) { pool.set(k, pool.get(k) - 1); n++; }
  }
  return n;
}

// score(oursPath, refPath) → deterministic integers, ready for baselines
export function score(oursPath, refPath) {
  const ours = clean(readFileSync(oursPath, 'utf8'));
  const ref = clean(readFileSync(refPath, 'utf8'));
  const squash = s => s.replace(/ +/g, ' ').trim();
  const chars = s => s.join('').replace(/\s/g, '').length;
  return {
    ourLines: ours.length, refLines: ref.length,
    exact: multisetHits(ours, ref),
    spaceFree: multisetHits(ours, ref, squash),
    ourChars: chars(ours), refChars: chars(ref),
  };
}

const isMain = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const o = {
    ours: resolve(ROOT, 'out', 'big', 'all.txt'),
    ref: resolve(ROOT, '..', '..', 'tools', 'gate-ref', 'big.txt'),
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i], next = () => process.argv[++i];
    if (a === '--ours') o.ours = resolve(next());
    else if (a === '--ref') o.ref = resolve(next());
    else { console.error(`unknown arg ${a}`); process.exit(1); }
  }
  const s = score(o.ours, o.ref);
  console.log(`ours: ${s.ourLines} lines, ref: ${s.refLines} lines`);
  console.log(`exact line matches:          ${s.exact} / ${s.refLines} (${(100 * s.exact / s.refLines).toFixed(1)}%)`);
  console.log(`space-collapsed matches:     ${s.spaceFree} / ${s.refLines} (${(100 * s.spaceFree / s.refLines).toFixed(1)}%)`);
  console.log(`non-space chars emitted:     ${s.ourChars} / ${s.refChars} (${(100 * s.ourChars / s.refChars).toFixed(1)}%)`);
}

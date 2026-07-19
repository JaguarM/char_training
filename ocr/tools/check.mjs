// check.mjs — score a candidate render against the harvested target rasters.
//
// Contract: your renderer writes candidates/<name>/<id>.pgm — one PGM per
// target id it attempts (ids and chars are in targets/index.json; render the
// char however you like, whitespace margins are fine). Then:
//
//   node tools/check.mjs candidates/<name>            # summary
//   node tools/check.mjs candidates/<name> --verbose  # per-target lines
//   node tools/check.mjs candidates/<name> --id 101_p0_v1   # one target, dump both
//
// Scoring: the target (a tight ink crop) is slid over the candidate at every
// integer offset; best = lowest SAD. EXACT means a placement where every
// pixel matches byte-for-byte AND the candidate has no unexplained ink
// outside the matched window (checked in a 1px border). The goal of the
// whole workspace: a renderer whose every attempted target is EXACT.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { readPgm } from './view.mjs';

const dir = process.argv[2];
const verbose = process.argv.includes('--verbose');
const onlyId = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : null;
if (!dir) { console.error('usage: node tools/check.mjs candidates/<name> [--verbose] [--id <id>]'); process.exit(1); }

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));

function score(tgt, cand) {
  // slide with overhang: pixels outside the candidate count as white (255),
  // so tight candidate rasters (e.g. GGO black-box) still match targets
  // whose harvest window carries white margin
  let best = { sad: Infinity, maxd: 255, dx: 0, dy: 0 };
  for (let dy = -tgt.h + 1; dy < cand.h; dy++) for (let dx = -tgt.w + 1; dx < cand.w; dx++) {
    let sad = 0, maxd = 0;
    for (let r = 0; r < tgt.h && sad < best.sad; r++) for (let c = 0; c < tgt.w; c++) {
      const rr = r + dy, cc = c + dx;
      const v = rr >= 0 && rr < cand.h && cc >= 0 && cc < cand.w ? cand.px[rr * cand.w + cc] : 255;
      const d = Math.abs(v - tgt.px[r * tgt.w + c]);
      sad += d; if (d > maxd) maxd = d;
    }
    if (sad < best.sad) best = { sad, maxd, dx, dy };
  }
  if (best.sad === 0) {           // no stray candidate ink hugging the match?
    const { dx, dy } = best;
    for (let r = -1; r <= tgt.h; r++) for (const c of [-1, tgt.w]) {
      const rr = r + dy, cc = c + dx;
      if (rr >= 0 && rr < cand.h && cc >= 0 && cc < cand.w && cand.px[rr * cand.w + cc] < 250) best.strayInk = true;
    }
  }
  return best;
}

let attempted = 0, exact = 0;
const misses = [];
for (const t of targets) {
  if (onlyId && t.id !== onlyId) continue;
  const f = `${dir}/${t.id}.pgm`;
  if (!existsSync(f)) continue;
  attempted++;
  const tgt = readPgm(`${root}/targets/${t.id}.pgm`);
  const cand = readPgm(f);
  const b = score(tgt, cand);
  const isExact = b.sad === 0 && !b.strayInk;
  if (isExact) exact++;
  else misses.push({ t, b });
  if (verbose || onlyId)
    console.log(`${t.id} '${t.ch}'  ${isExact ? 'EXACT' : `sad ${b.sad} avg ${(b.sad / (tgt.w * tgt.h)).toFixed(1)} maxd ${b.maxd}`}${b.strayInk ? ' (stray ink)' : ''}`);
  if (onlyId) {
    console.log('--- target:');
    for (let r = 0; r < tgt.h; r++) console.log('   ', Array.from({ length: tgt.w }, (_, c) => String(tgt.px[r * tgt.w + c]).padStart(4)).join(''));
    console.log('--- candidate (best window):');
    for (let r = 0; r < tgt.h; r++) console.log('   ', Array.from({ length: tgt.w }, (_, c) => {
      const rr = r + b.dy, cc = c + b.dx;
      const v = rr >= 0 && rr < cand.h && cc >= 0 && cc < cand.w ? cand.px[rr * cand.w + cc] : 255;
      return String(v).padStart(4);
    }).join(''));
  }
}
if (!onlyId) {
  misses.sort((a, b2) => (b2.b?.sad ?? 1e9) - (a.b?.sad ?? 1e9));
  console.log(`\n${exact}/${attempted} EXACT  (${targets.length} targets available)`);
  if (misses.length && !verbose) {
    console.log('worst 10:');
    for (const m of misses.slice(0, 10))
      console.log(`  ${m.t.id} '${m.t.ch}' ${m.note ?? `sad ${m.b.sad} maxd ${m.b.maxd}`}`);
  }
}

// stem-survey.mjs — pixel-only hinting probe: find vertical stems (runs of
// dark pixels in a column) in body text and tabulate (leftFringe, stemVal,
// rightFringe) triples. Hinted rasterizers snap stems to the pixel grid →
// few distinct fringe pairs; unhinted continuous pens → broad spread.
//   node tools/attic/stem-survey.mjs pages/EFTA00038617/page-0001.pgm [yMin]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const yMin = +(process.argv[3] ?? 160);
const b = readFileSync(file);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
const w = +m[1], h = +m[2], px = b.subarray(m[0].length);
const at = (x, y) => px[y * w + x];

// a stem sample: >=6 consecutive rows where col x is dark (<32) and both
// neighbors are strictly lighter than the stem for every row (1-px stem)
const pairs = new Map();
let stems = 0;
for (let x = 1; x < w - 1; x++) {
  let run = 0, y0 = 0;
  for (let y = yMin; y < h; y++) {
    const v = at(x, y);
    if (v < 32 && at(x - 1, y) > v && at(x + 1, y) > v) { if (!run) y0 = y; run++; }
    else {
      if (run >= 6) {
        // uniform fringes along the run?
        let l0 = at(x - 1, y0), r0 = at(x + 1, y0), uni = true;
        for (let yy = y0; yy < y0 + run; yy++)
          if (at(x - 1, yy) !== l0 || at(x + 1, yy) !== r0) { uni = false; break; }
        if (uni) {
          stems++;
          const k = `${l0}|${at(x, y0)}|${r0}`;
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
      }
      run = 0;
    }
  }
}
console.log('uniform 1-px stems found:', stems, ' distinct (L|stem|R) triples:', pairs.size);
const sorted = [...pairs.entries()].sort((a, b2) => b2[1] - a[1]);
for (const [k, n] of sorted.slice(0, 30)) console.log(String(n).padStart(4), k);

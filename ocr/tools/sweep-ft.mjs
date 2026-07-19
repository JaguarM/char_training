// sweep-ft.mjs — THE hunt, unlocked by the certified ftclone: for each target
// try every 1/64-px pen phase (64x64) at given em64 configs and draw counts;
// report EXACT matches (byte-for-byte incl. the target's white margins, plus
// check.mjs's no-stray-ink border rule). fillText could only reach 4 of these
// 4096 phases per glyph — this covers the whole lattice.
//
//   node tools/sweep-ft.mjs --ems 791x768,791x791 --draws 1,2
//   node tools/sweep-ft.mjs --ems 790x768 --draws 2 --report hits.json
import { readFileSync, writeFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const EMS = optS('ems', '791x768').split(',').map(s => s.split('x').map(Number));
const DRAWS = optS('draws', '1,2').split(',').map(Number);
const REPORT = optS('report', null);
const SAD = args.includes('--sad');   // also track best bbox-aligned SAD per target

const FONT = optS('font', 'fonts/cour.ttf');
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));

function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}
function inkBbox(px, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (px[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

for (const t of targets) {
  t.pgm = readPgm(`${root}/targets/${t.id}.pgm`);
  t.bbox = inkBbox(t.pgm.px, t.pgm.w, t.pgm.h);
}
const byCp = new Map();
for (const t of targets) {
  if (!byCp.has(t.cp)) byCp.set(t.cp, []);
  byCp.get(t.cp).push(t);
}

const W = 40, H = 40, PENX = 10, BASEY = 28;
const clone = new FTClone(`${root}/${FONT}`, W, H);
if (FONT.endsWith('.cff')) {
  const mupdf = await import('mupdf');
  const bfont = new mupdf.Font(optS('builtin', 'Courier'));
  clone.setGidMap(new Map([...byCp.keys()].map(cp => [cp, bfont.encodeCharacter(cp)])));
}

// exact test: align candidate ink bbox to target ink bbox, compare the FULL
// target window byte-for-byte (white margins included), then border stray-ink
function exactAt(t, cand, cb) {
  if (!cb || !t.bbox) return false;
  if (cb.x1 - cb.x0 !== t.bbox.x1 - t.bbox.x0 || cb.y1 - cb.y0 !== t.bbox.y1 - t.bbox.y0) return false;
  const dx = cb.x0 - t.bbox.x0, dy = cb.y0 - t.bbox.y0;
  const { w, h, px } = t.pgm;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const rr = r + dy, cc = c + dx;
    const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
    if (v !== px[r * w + c]) return false;
  }
  for (let r = -1; r <= h; r++) for (const c of [-1, w]) {
    const rr = r + dy, cc = c + dx;
    if (rr >= 0 && rr < H && cc >= 0 && cc < W && cand[rr * W + cc] < 250) return false;
  }
  return true;
}
function sadAt(t, cand, cb) {          // bbox-center-aligned SAD (any dims)
  if (!cb || !t.bbox) return Infinity;
  const dx = Math.round((cb.x0 + cb.x1 - t.bbox.x0 - t.bbox.x1) / 2);
  const dy = Math.round((cb.y0 + cb.y1 - t.bbox.y0 - t.bbox.y1) / 2);
  const { w, h, px } = t.pgm;
  let sad = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const rr = r + dy, cc = c + dx;
    const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
    sad += Math.abs(v - px[r * w + c]);
  }
  return sad;
}

const hits = [];
for (const [em64x, em64y] of EMS) {
  const t0 = Date.now();
  let exactTargets = new Set();
  const best = new Map();              // id -> {sad, draws, fx, fy}
  for (const [cp, list] of byCp) {
    for (let fy = 0; fy < 64; fy++) {
      for (let fx = 0; fx < 64; fx++) {
        const cov = clone.coverage(cp, em64x, em64y, PENX * 64 + fx, BASEY * 64 + fy);
        if (!cov) break;
        for (const draws of DRAWS) {
          const dst = new Uint8Array(W * H).fill(255);
          for (let d = 0; d < draws; d++)
            for (let i = 0; i < dst.length; i++) {
              const g = cov[i];
              if (g) dst[i] = (dst[i] * (256 - (g + (g >> 7)))) >> 8;
            }
          const cb = inkBbox(dst, W, H);
          for (const t of list) {
            if (exactAt(t, dst, cb)) {
              hits.push({ id: t.id, ch: t.ch, em64x, em64y, draws, fx, fy });
              exactTargets.add(t.id);
            }
            if (SAD) {
              const s = sadAt(t, dst, cb);
              const b = best.get(t.id);
              if (!b || s < b.sad) best.set(t.id, { sad: s, draws, fx, fy });
            }
          }
        }
      }
      clone.cache.clear();   // coverage cache only needed within a row sweep
    }
  }
  console.log(`em64 (${em64x},${em64y}): ${exactTargets.size}/${targets.length} targets have >=1 EXACT phase  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  if (SAD) {
    const rows = [...best.entries()].map(([id, b]) => ({ id, ...b, t: targets.find(t => t.id === id) }));
    rows.sort((a, b) => a.sad - b.sad);
    const so = optS('sadout', null);
    if (so) writeFileSync(`${root}/${so}`, JSON.stringify(rows.map(r => ({
      id: r.id, ch: r.t.ch, sad: r.sad, avg: +(r.sad / (r.t.pgm.w * r.t.pgm.h)).toFixed(1),
      draws: r.draws, fx: r.fx, fy: r.fy,
    })), null, 1));
    let tot = 0;
    for (const r of rows) tot += r.sad;
    console.log(`  mean best sad ${(tot / rows.length).toFixed(0)};  best 12 / worst 6:`);
    for (const r of [...rows.slice(0, 12), ...rows.slice(-6)])
      console.log(`    ${r.id.padEnd(14)} '${r.t.ch}' sad ${String(r.sad).padStart(5)} avg ${(r.sad / (r.t.pgm.w * r.t.pgm.h)).toFixed(1).padStart(5)}  draws ${r.draws} pen (${r.fx}/64,${r.fy}/64)`);
  }
}
for (const h of hits.slice(0, 60))
  console.log(`  ${h.id} '${h.ch}'  em64(${h.em64x},${h.em64y}) draws ${h.draws} pen frac (${h.fx}/64, ${h.fy}/64)`);
if (hits.length > 60) console.log(`  ... ${hits.length} hits total`);
if (REPORT) writeFileSync(`${root}/${REPORT}`, JSON.stringify(hits, null, 1));

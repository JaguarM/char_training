// identify.mjs — the zero-priors first move of every hunt: fingerprint the
// harvested targets and try EVERY proven renderer family (families.mjs)
// against them through the certified ftclone. A new mystery document needs
// three commands total:
//
//   node tools/ingest.mjs path/to/DOC.pdf
//   node tools/harvest.mjs
//   node tools/identify.mjs
//
// and the report says either "family X — engine set Y exists, integrate"
// or "unknown — here is the fingerprint and the next probes to run".
//
//   node tools/identify.mjs --scan fonts/face.ttf [--ems 448..1280] [--fy 0,32]
//       em64 sweep for an UNKNOWN size of a known face: exact counts per
//       em64 at the ¼-px pen lattice (the follow-up when no family matches
//       but the face looks right). ~1 min for the default range.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';
import { FAMILIES, SCAN_DEFAULT } from '../families.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TDIR = optS('targets', 'targets');
const FX = [0, 16, 32, 48];                       // the ¼-px pen lattice, always
const W = 48, H = 48, PENX = 12, BASEY = 32;

// ---- targets ----
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
// same EXACT test as sweep-ft.mjs: ink bboxes must agree, the FULL target
// window must match byte-for-byte (white margins included), and no darker
// stray candidate ink may hug the window border
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

const { targets, source } = JSON.parse(readFileSync(`${root}/${TDIR}/index.json`, 'utf8'));
for (const t of targets) {
  t.pgm = readPgm(`${root}/${TDIR}/${t.id}.pgm`);
  t.bbox = inkBbox(t.pgm.px, t.pgm.w, t.pgm.h);
}
const byCp = new Map();
for (const t of targets) {
  if (!byCp.has(t.cp)) byCp.set(t.cp, []);
  byCp.get(t.cp).push(t);
}

// ---- fingerprint ----
{
  const dims = new Map();
  const pagesDir = `${root}/pages`;
  if (existsSync(pagesDir))
    for (const d of readdirSync(pagesDir)) {
      if (source && !source.includes(d)) continue;   // only this hunt's docs
      try {
        const m = JSON.parse(readFileSync(`${pagesDir}/${d}/meta.json`, 'utf8'));
        for (const p of Object.values(m.pages ?? {})) {
          if (!p || p.empty) continue;
          const k = `${p.w}x${p.h}`;
          dims.set(k, (dims.get(k) ?? 0) + 1);
        }
      } catch {}
    }
  const seen = new Uint32Array(256);
  let ink = 0;
  for (const t of targets) for (const v of t.pgm.px) { seen[v]++; if (v < 255) ink++; }
  const distinct = seen.reduce((s, n) => s + (n > 0 ? 1 : 0), 0);
  const advs = targets.map(t => t.adv).filter(Boolean).sort((a, b) => a - b);
  const med = advs.length ? advs[advs.length >> 1] : null;
  console.log(`targets: ${targets.length} rasters, ${byCp.size} chars` +
    (med ? `, median cell advance ${med.toFixed(3)} px` : ''));
  if (dims.size) console.log(`pages:   ${[...dims.entries()].map(([k, n]) => `${k} ×${n}`).join(', ')}` +
    '  (816x1056 = 96dpi letter; 816x1073 = the Outside In variant-B geometry)');
  console.log(`bytes:   ${distinct} distinct target values, ${ink} ink px` +
    (distinct < 64 ? '  << FEW: palette producer suspected — see family palette-quant' : ''));
  console.log('');
}

// ---- render helpers ----
async function gidMapFor(fontPath, cps) {
  const mupdf = await import('mupdf');
  const f = new mupdf.Font('F', readFileSync(fontPath));
  return new Map(cps.map(cp => [cp, f.encodeCharacter(cp)]));
}
const postMap = (dst, post) => {
  if (post !== 'linear' && post !== 'linear254') return dst;
  const hi = post === 'linear254' ? 254 : 253;   // linear254: raw 254 (cov 1) → 255, drops the pixel
  const out = Uint8Array.from(dst);
  for (let i = 0; i < out.length; i++) if (out[i] >= 128 && out[i] <= hi) out[i]++;
  return out;
};
// exact-count of one (font-clone, em64, fy-list, post) config; earlyStop
// skips a target's remaining pens once it matched
function tryConfig(clone, em64, fys, post) {
  const hit = new Set(), chars = new Set();
  for (const [cp, list] of byCp) {
    outer: for (const fy of fys) for (const fx of FX) {
      if (list.every(t => hit.has(t.id))) break outer;
      const dst = clone.render(cp, em64, em64, PENX * 64 + fx, BASEY * 64 + fy, 1);
      if (!dst) break outer;                       // no outline for this cp
      const cand = postMap(dst, post);
      const cb = inkBbox(cand, W, H);
      for (const t of list) if (!hit.has(t.id) && exactAt(t, cand, cb)) { hit.add(t.id); chars.add(cp); }
    }
    clone.cache.clear();
  }
  return { exact: hit.size, chars: chars.size };
}

// ---- mode: em64 scan of one face ----
const scanFont = optS('scan', null);
if (scanFont) {
  const [a, b] = (optS('ems', `${SCAN_DEFAULT.from}..${SCAN_DEFAULT.to}`)).split('..').map(Number);
  const fys = optS('fy', '0').split(',').map(Number);
  const path = existsSync(`${root}/${scanFont}`) ? `${root}/${scanFont}` : scanFont;
  const clone = new FTClone(path, W, H);
  if (clone.cff) clone.setGidMap(await gidMapFor(path, [...byCp.keys()]));
  const rows = [];
  const t0 = Date.now();
  for (let em = a; em <= b; em++) {
    const r = tryConfig(clone, em, fys, null);
    if (r.exact) rows.push({ em, ...r });
    if ((em - a) % 64 === 63) process.stderr.write(`\r  ${em - a + 1}/${b - a + 1} ems`);
  }
  process.stderr.write('\n');
  rows.sort((x, y) => y.exact - x.exact);
  console.log(`em64 scan ${a}..${b} of ${scanFont} (fy ${fys.join(',')})  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  if (!rows.length) console.log('  no em64 in range produces a single byte-exact target — wrong face, or not this pipeline (see README next steps)');
  for (const r of rows.slice(0, 12))
    console.log(`  em64 ${String(r.em).padStart(4)} = ${(r.em / 64).toFixed(6)} px  ${String(r.exact).padStart(4)} exact (${r.chars} chars)`);
  process.exit(0);
}

// ---- mode: all known families ----
const results = [];
for (const f of FAMILIES) {
  if (!f.renderable) continue;
  const path = f.font.startsWith('fonts/') ? `${root}/${f.font}` : f.font;
  if (!existsSync(path)) { results.push({ f, skipped: 'font file missing' }); continue; }
  const clone = new FTClone(path, W, H);
  if (clone.cff) clone.setGidMap(await gidMapFor(path, [...byCp.keys()]));
  const t0 = Date.now();
  const r = tryConfig(clone, f.em64, f.fy, f.post);
  results.push({ f, ...r, secs: (Date.now() - t0) / 1000 });
}
results.sort((a, b) => (b.exact ?? -1) - (a.exact ?? -1));
console.log('known renderable families (byte-exact targets / total):');
for (const r of results) {
  if (r.skipped) { console.log(`  ${r.f.name.padEnd(16)} skipped: ${r.skipped}`); continue; }
  console.log(`  ${r.f.name.padEnd(16)} ${String(r.exact).padStart(4)}/${targets.length}  (${r.chars} distinct chars, ${r.secs.toFixed(1)}s)`);
}
const top = results.find(r => !r.skipped);
console.log('');
if (top && top.exact >= Math.max(5, targets.length * 0.03) && top.chars >= 4) {
  console.log(`VERDICT: ${top.f.name} — proven family (${top.f.record})`);
  console.log(`  engine set: ${top.f.engineSet ?? '(none yet)'} — non-exact remainders are usually`);
  console.log('  neighbor-AA / rule composition, which the main engine handles: try');
  console.log(`  cd ../tools && node blind-read.mjs --pdf <doc.pdf> --all --glyphs ${top.f.engineSet ?? '<set>'}`);
} else {
  console.log('VERDICT: no known family matches. Next, in order (see README):');
  console.log('  1. right face / unknown size?  node tools/identify.mjs --scan fonts/<face> ');
  console.log('  2. palette? (few distinct bytes above)  re-check candidates through the palette law');
  console.log('  3. full pen lattice + em neighborhood:  node tools/sweep-ft.mjs --font <face> --ems <a>x<a>,... --sad');
  console.log('  4. genuinely new pipeline: FINDINGS.md documents how the last one fell.');
}

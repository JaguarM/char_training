// harvest-band.mjs — transcription-anchored PARTITION-CUT harvester for
// layout-constant bands the model-guided harvester can't crack (letterhead
// strings whose glyphs touch, bullets, any run where only the PAGE knows the
// bytes). The band's text is supplied by eye; the band recurs byte-identically
// (±the per-page wobble) at the SAME coords on every listed page, so ANY
// consistent column partition of the band into per-char spans yields templates
// that re-match the page exactly. Boundaries: white gaps first, then
// advance-weighted cuts snapped to ink valleys inside touching clusters.
//
//   node tools/harvest-band.mjs --text "UNCLASSIFIED//LES" \
//     --rect 330,28,110,17 --docs EFTA00038617,EFTA01649149 --pages 1,2,3 \
//     --size 11.33 --advfont C:/Windows/Fonts/segoeui.ttf --advem 725 \
//     --out ../assets/fonts/hdr_les.npz
//
// Every (doc,page) instance must byte-agree within --spread (default 3, the
// cross-page wobble); the emitted template is the per-pixel MEDIAN. Repeated
// chars with differing rasters occupy successive ¼-phase slots (≤4 per char).
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import * as mupdf from 'mupdf';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TEXT = optS('text', null);
const [RX, RY, RW, RH] = optS('rect', '0,0,0,0').split(',').map(Number);
const DOCS = optS('docs', 'EFTA00038617,EFTA01649149').split(',');
const PAGES = optS('pages', '1,2,3').split(',').map(Number);
const OUT = optS('out', null);
const SIZE = +optS('size', '16');
const ADVFONT = optS('advfont', null);
const ADVEM = +optS('advem', '1024');
const SPREAD = +optS('spread', '4');   // ≤4 keeps midrange within tol 2 of every instance
// A column is ink when ANY byte < 255: the reader explains every sub-255
// pixel, so a 253 AA-fringe column split off a glyph's template becomes an
// unexplained cluster (FEDERAL 'E' lesson). Runs that are PURE ghost
// (min ≥ 244, white-separated) are dropped below — the engine's ghost mask
// eats those same components.
const INKTH = +optS('inkth', '255');
const PREFIX = optS('prefix', 'page'); // 'white' = reader-view pgm (gen-white.mjs)
const BASEROW = optS('baseline', null); // rect-relative baseline row override
                                        // (floating glyphs: bullets sit at
                                        // mid-x, "last ink row + 1" is wrong)
if (!TEXT || !OUT) { console.error('need --text and --out'); process.exit(2); }

const readPgm = p => {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
};

// ---- collect instances, median-consensus the band ----
// --inst "doc:page:x,y;doc:page:x,y;..." overrides the docs×pages grid with
// per-instance rect origins (same w,h) — bullets recur at different y per page
const instSpec = optS('inst', null);
const sources = instSpec
  ? instSpec.split(';').map(s => {
      const [doc, pno, xy] = s.split(':');
      const [x, y] = xy.split(',').map(Number);
      return { doc, pno: +pno, x, y };
    })
  : DOCS.flatMap(doc => PAGES.map(pno => ({ doc, pno, x: RX, y: RY })));
const insts = [];
for (const s of sources) {
  const { w, px } = readPgm(`${root}/pages/${s.doc}/${PREFIX}-000${s.pno}.pgm`);
  const cut = new Uint8Array(RW * RH);
  for (let y = 0; y < RH; y++)
    for (let x = 0; x < RW; x++) cut[y * RW + x] = px[(s.y + y) * w + s.x + x];
  insts.push({ id: `${s.doc.slice(-4)}/${s.pno}`, cut });
}
let maxSp = 0;
const band = new Uint8Array(RW * RH);
{
  // MIDRANGE consensus, not median: with cross-instance spread ≤4 the
  // midrange sits within 2 (= the read tol) of EVERY instance; the median
  // can sit 3-4 from a lone wobbled page and fail single pixels there.
  const vals = new Uint8Array(insts.length);
  for (let i = 0; i < band.length; i++) {
    for (let j = 0; j < insts.length; j++) vals[j] = insts[j].cut[i];
    let mn = 255, mx = 0;
    for (let j = 0; j < insts.length; j++) { if (vals[j] < mn) mn = vals[j]; if (vals[j] > mx) mx = vals[j]; }
    band[i] = (mn + mx + 1) >> 1;
    // never round an inked pixel up to 255: a template-255 pixel is outside
    // the ink list, and the instances where the page has 254 there would
    // keep an eternally-unexplained residue pixel
    if (band[i] === 255 && mn < 255) band[i] = 254;
    const sp = mx - mn;
    if (sp > maxSp) maxSp = sp;
  }
}
console.log(`${insts.length} instances, cross-instance max spread ${maxSp}`);
if (maxSp > SPREAD) {
  // locate the worst offenders to help diagnosis
  for (const inst of insts) {
    let n = 0;
    for (let i = 0; i < band.length; i++) if (Math.abs(inst.cut[i] - band[i]) > SPREAD) n++;
    if (n) console.log(`  ${inst.id}: ${n} px beyond ±${SPREAD}`);
  }
  console.error('instances disagree — not one layout-constant band'); process.exit(1);
}

// ---- column ink profile / runs ----
const colInk = new Array(RW).fill(false), colMin = new Array(RW).fill(255);
for (let x = 0; x < RW; x++) {
  let mn = 255, s = 0;
  for (let y = 0; y < RH; y++) { const v = band[y * RW + x]; if (v < mn) mn = v; s += 255 - v; }
  colMin[x] = mn; colInk[x] = mn < INKTH;
  colMin[x + RW] = s; // total darkness stored past end? no — keep separate
}
const colDark = new Array(RW).fill(0);
for (let x = 0; x < RW; x++) { let s = 0; for (let y = 0; y < RH; y++) s += 255 - band[y * RW + x]; colDark[x] = s; }
const runs = [];
let cur = -1;
for (let x = 0; x <= RW; x++) {
  const ink = x < RW && colInk[x];
  if (ink && cur < 0) cur = x;
  else if (!ink && cur >= 0) { runs.push([cur, x]); cur = -1; }
}
for (let i = runs.length - 1; i >= 0; i--) {   // pure-ghost runs -> engine's mask
  let mn = 255;
  for (let x = runs[i][0]; x < runs[i][1]; x++) if (colMin[x] < mn) mn = colMin[x];
  if (mn >= 244) runs.splice(i, 1);
}
console.log(`runs: ${runs.map(r => `${r[0]}-${r[1] - 1}`).join(' ')}`);

// ---- advance-weighted char assignment ----
const chars = Array.from(TEXT);
const glyphChars = chars.filter(c => c !== ' ');
let weights;
if (ADVFONT) {
  const mfont = new mupdf.Font('F', readFileSync(ADVFONT));
  weights = chars.map(c => c === ' ' ? 0 :
    mfont.advanceGlyph(mfont.encodeCharacter(c.codePointAt(0)), 0) * ADVEM / 64);
} else weights = chars.map(c => c === ' ' ? 0 : 1);

// distribute glyph chars over runs: walk runs left→right, put chars into runs
// proportionally to width; spaces bind to the white gap between runs.
// Greedy: for each run, take as many chars as fit its share of total width.
const totalInk = runs.reduce((s, [a, b]) => s + (b - a), 0);
const totalW = weights.reduce((s, v) => s + v, 0);
const assign = [];                       // per run: [charIdx...]
{
  let ci = 0;
  for (let ri = 0; ri < runs.length; ri++) {
    const [a, b] = runs[ri];
    const runW = b - a;
    const target = runW / totalInk * totalW;
    const mine = [];
    let acc = 0;
    while (ci < chars.length && chars[ci] === ' ') ci++;   // spaces ride the gap
    while (ci < chars.length) {
      if (chars[ci] === ' ') break;
      // stop if adding this char overshoots target AND at least one taken AND
      // there are more runs to fill
      if (mine.length && ri < runs.length - 1 && acc + weights[ci] / 2 > target) break;
      acc += weights[ci];
      mine.push(ci); ci++;
    }
    assign.push(mine);
  }
  if (assign.flat().length !== glyphChars.length) {
    console.error(`assignment mismatch: placed ${assign.flat().length} of ${glyphChars.length} glyph chars`);
    assign.forEach((m, i) => console.error(`  run ${runs[i][0]}-${runs[i][1] - 1}: "${m.map(k => chars[k]).join('')}"`));
    process.exit(1);
  }
  assign.forEach((m, i) => console.log(`  run ${runs[i][0]}-${runs[i][1] - 1}: "${m.map(k => chars[k]).join('')}"`));
}

// ---- cut spans (valley-snapped inside multi-char runs) ----
const spans = [];                        // {charIdx, x0, x1}
for (let ri = 0; ri < runs.length; ri++) {
  const [a, b] = runs[ri], mine = assign[ri];
  if (!mine.length) continue;
  if (mine.length === 1) { spans.push({ ci: mine[0], x0: a, x1: b }); continue; }
  const wsum = mine.reduce((s, k) => s + weights[k], 0);
  let cuts = [a];
  let acc = 0;
  for (let j = 0; j < mine.length - 1; j++) {
    acc += weights[mine[j]];
    const ideal = a + acc / wsum * (b - a);
    // snap to darkest-relief valley within ±2 of ideal
    let best = Math.round(ideal);
    for (let x = Math.round(ideal) - 2; x <= Math.round(ideal) + 2; x++)
      if (x > cuts[cuts.length - 1] && x < b && colDark[x] < colDark[best]) best = x;
    cuts.push(best);
  }
  cuts.push(b);
  // faint-lead columns (min ≥ 200) at a cut boundary move to the PREVIOUS
  // glyph: a template anchoring on a faint column is fragile at read time
  // (the scan can absorb such a column into dust/previous ink, and every
  // later column then misaligns by one — the ION 'O' lesson); trailing faint
  // columns on the previous glyph are read inside that glyph's own accept.
  for (let j = 1; j < cuts.length - 1; j++)
    while (cuts[j] < cuts[j + 1] - 1 && colMin[cuts[j]] >= 244) cuts[j]++;
  for (let j = 0; j < mine.length; j++)
    spans.push({ ci: mine[j], x0: cuts[j], x1: cuts[j + 1] });
}

// ---- templates: trim rows, common baseline = last ink row of band ----
let baseRow = 0;
for (let y = 0; y < RH; y++)
  for (let x = 0; x < RW; x++) if (band[y * RW + x] < INKTH) baseRow = y;
const baseline = BASEROW !== null ? +BASEROW : baseRow + 1; // pen y
const glyphs = [];                       // {ch, x0, bytes, w, h, dy}
for (const s of spans) {
  let y0 = RH, y1 = -1, x0 = s.x1, x1 = s.x0 - 1;
  for (let y = 0; y < RH; y++)
    for (let x = s.x0; x < s.x1; x++)
      if (band[y * RW + x] < 255) {
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
      }
  if (y1 < 0) { console.error(`empty span for '${chars[s.ci]}'`); process.exit(1); }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const bytes = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) bytes[y * w + x] = band[(y0 + y) * RW + x0 + x];
  glyphs.push({ ch: chars[s.ci], x0, bytes, w, h, dy: y0 - baseline });
}
glyphs.sort((a, b) => a.x0 - b.x0);

// ---- per-char slots: dedupe identical rasters, ≤4 variants ----
const byChar = new Map();                // ch -> {advs: [], variants: [{bytes,w,h,dy}]}
for (let i = 0; i < glyphs.length; i++) {
  const g = glyphs[i];
  if (!byChar.has(g.ch)) byChar.set(g.ch, { advs: [], variants: [] });
  const e = byChar.get(g.ch);
  const sig = `${g.w}|${g.h}|${g.dy}|${g.bytes.toString('latin1')}`;
  if (!e.variants.some(v => v.sig === sig)) e.variants.push({ ...g, sig });
  const nxt = glyphs[i + 1];
  if (nxt && nxt.x0 - g.x0 < g.w + 4) e.advs.push(nxt.x0 - g.x0);
  else e.advs.push(g.w + 1);
}
for (const [ch, e] of byChar) {
  if (e.variants.length > 4) { console.error(`'${ch}' needs ${e.variants.length} phase slots (>4)`); process.exit(1); }
  console.log(`'${ch}' x${e.variants.length} variant(s), adv ${e.advs.join('/')}`);
}

// ---- npz writer (same layout as harvest-prop) ----
function npy(descr, shape, data) {
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let hdr = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  hdr += ' '.repeat((64 - (10 + hdr.length + 1) % 64) % 64) + '\n';
  const out = Buffer.alloc(10 + hdr.length + data.length);
  out.write('\x93NUMPY', 0, 'latin1'); out[6] = 1; out[7] = 0;
  out.writeUInt16LE(hdr.length, 8);
  out.write(hdr, 10, 'latin1');
  data.copy(out, 10 + hdr.length);
  return out;
}
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = b => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function writeZip(path, entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data] of entries) {
    const comp = deflateRawSync(data, { level: 9 });
    const nameB = Buffer.from(name, 'latin1');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, nameB]));
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, eocd]));
}

const uniq = [...byChar.keys()];
const meta = {
  fontfile: `page-cut:${DOCS.join('+')}`, size_px: SIZE, chars: uniq.join(''),
  phases_x: [0, 0.25, 0.5, 0.75], phases_y: [0],
  pipeline: `partition-cut page bytes, rect ${RX},${RY},${RW},${RH} "${TEXT}" (ocr/FINDINGS-calibri.md)`,
};
const advBuf = Buffer.alloc(uniq.length * 8);
uniq.forEach((c, i) => {
  const advs = byChar.get(c).advs.slice().sort((a, b) => a - b);
  advBuf.writeDoubleLE(advs[advs.length >> 1], i * 8);
});
const entries = [
  ['meta.npy', npy('|u1', [Buffer.byteLength(JSON.stringify(meta))], Buffer.from(JSON.stringify(meta)))],
  ['adv.npy', npy('<f8', [uniq.length], advBuf)],
];
for (const c of uniq) {
  const { variants } = byChar.get(c);
  for (let pi = 0; pi < 4; pi++) {
    const key = `${c.codePointAt(0)}_${pi}_0`;
    const v = variants[pi];
    const o = Buffer.alloc(4);
    if (v) { o.writeInt16LE(0, 0); o.writeInt16LE(v.dy, 2); }
    entries.push([`g_${key}.npy`, npy('|u1', v ? [v.h, v.w] : [0, 0], v ? Buffer.from(v.bytes) : Buffer.alloc(0))]);
    entries.push([`o_${key}.npy`, npy('<i2', [2], o)]);
  }
}
writeZip(OUT, entries);
console.log(`${OUT}: ${uniq.length} chars, ${glyphs.length} glyph cuts, baseline row ${baseline} (rect-relative)`);

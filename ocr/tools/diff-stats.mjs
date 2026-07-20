// diff-stats.mjs — quantify producer-vs-ftclone deviations for the
// EFTA00039208 Nimbus Roman family. Takes a blind-read --json dump (tol 2),
// re-renders every accepted glyph at its pen through ftclone + linear +
// per-page palette LUT, diffs against the ingested page bytes, and reports
// per-(ch, phase) stable deviations.
//
//   node tools/diff-stats.mjs --json <read.json> --doc EFTA00039208 --pdf ../NEW/EFTA00039208.pdf
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';

const o = { json: null, doc: 'EFTA00039208', pdf: '../NEW/EFTA00039208.pdf',
  font: 'fonts/NimbusRoman-Regular.cff', fontbd: 'fonts/NimbusRoman-Bold.cff' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--json') o.json = next();
  else if (a === '--doc') o.doc = next();
  else if (a === '--pdf') o.pdf = next();
}

function readPGM(p) {
  const b = readFileSync(p);
  let i = 0, tok = [], s = '';
  while (tok.length < 4) {
    const c = b[i++];
    if (c === 35) { while (b[i++] !== 10); }
    else if (c <= 32) { if (s) { tok.push(s); s = ''; } }
    else s += String.fromCharCode(c);
  }
  return { w: +tok[1], h: +tok[2], d: b.subarray(i) };
}

// per-page palette LUTs from the PDF (post-linear byte -> page gray)
function paletteLUTs(pdfPath) {
  const buf = readFileSync(pdfPath);
  const s = buf.toString('latin1');
  const luts = new Map();
  const re = /\[\s*\/Indexed\s*\/DeviceRGB\s*\d+\s+(\d+)\s+0\s+R\s*\]/g;
  let m, pno = 0;
  while ((m = re.exec(s))) {
    pno++;
    const om = new RegExp(`(?:^|\\s)${m[1]} 0 obj\\b`).exec(s);
    if (!om) continue;
    const dictEnd = s.indexOf('stream', om.index);
    let start = dictEnd + 'stream'.length;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    const pal = buf.subarray(start, end);
    const entries = [];
    for (let k = 0; k + 2 < pal.length; k += 3) entries.push([pal[k], pal[k + 1], pal[k + 2]]);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      let best = null, bd = Infinity;
      for (const e of entries) {
        const d = (e[0] - v) ** 2 + (e[1] - v) ** 2 + (e[2] - v) ** 2;
        if (d < bd || (d === bd && e[0] + e[1] + e[2] < best[0] + best[1] + best[2])) { bd = d; best = e; }
      }
      lut[v] = Math.round((best[0] + best[1] + best[2]) / 3);
    }
    luts.set(pno, lut);
  }
  return luts;
}

const mupdf = await import('mupdf');
function makeClone(path) {
  const ft = new FTClone(path, 64, 48);
  const mf = new mupdf.Font('F', readFileSync(path));
  ft.setGidMap(new Map());
  ft._mf = mf;
  return ft;
}
const clones = { reg: makeClone(o.font), bd: makeClone(o.fontbd) };
function coverageOf(ft, cp, px64, py64) {
  if (!ft.gidMap.has(cp)) ft.gidMap.set(cp, ft._mf.encodeCharacter(cp));
  return ft.coverage(cp, 1024, 1024, px64, py64);
}

const j = JSON.parse(readFileSync(o.json, 'utf8'));
const luts = paletteLUTs(o.pdf);
const stats = new Map();   // `${ch}|${phase}` -> Map(`${dx},${dy}` -> Map(diffval -> n)), plus occurrence count
const occ = new Map();
let totGlyphs = 0, cleanGlyphs = 0;

for (const P of j.pages) {
  const pg = readPGM(`pages/${o.doc}/page-${String(P.pno).padStart(4, '0')}.pgm`);
  const lut = luts.get(P.pno);
  if (!lut) continue;
  for (const L of P.lines) {
    if (!L.glyphs) continue;
    for (const [ch, pen] of L.glyphs) {
      const cp = ch.codePointAt(0);
      const penX = Math.round(pen * 64);          // pen is in px, ¼-px lattice
      const fx = penX & 63, ix = penX >> 6;
      // render in a local buffer with pen at (8 + fx/64, 36)
      const ft = clones.reg;                       // per-glyph face unknown; try reg, fall back bd
      for (const face of [clones.reg, clones.bd]) {
        const cov = coverageOf(face, cp, 8 * 64 + fx, 36 * 64);
        if (!cov) continue;
        const W = 64, H = 48;
        // diff against page at (ix - 8, baseline - 36)
        let bad = 0, tot = 0;
        const diffs = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const c = cov[y * W + x];
          if (!c) continue;
          tot++;
          let b = (255 * (256 - (c + (c >> 7)))) >> 8;
          if (b >= 128 && b <= 253) b++;
          const predicted = lut[b];
          const px = ix - 8 + x, py = L.baseline - 36 + y;
          const pv = pg.d[py * pg.w + px];
          if (pv !== predicted) { bad++; diffs.push([x - 8, y - 36, predicted, pv]); }
        }
        if (!tot) continue;
        // attribute to whichever face fits better; simple heuristic: accept
        // if over half the ink pixels match
        if (bad <= tot * 0.5) {
          totGlyphs++;
          if (!bad) cleanGlyphs++;
          const key = `${ch}|${fx}|${face === clones.bd ? 'bd' : 'reg'}`;
          occ.set(key, (occ.get(key) ?? 0) + 1);
          if (bad) {
            let m2 = stats.get(key);
            if (!m2) stats.set(key, m2 = new Map());
            for (const [dx, dy, pr, pv] of diffs) {
              const k2 = `${dx},${dy}`;
              let m3 = m2.get(k2);
              if (!m3) m2.set(k2, m3 = new Map());
              const k3 = `${pr}->${pv}`;
              m3.set(k3, (m3.get(k3) ?? 0) + 1);
            }
          }
          break;
        }
      }
    }
  }
}

console.log(`${totGlyphs} glyphs re-rendered, ${cleanGlyphs} byte-exact under law (${(100 * cleanGlyphs / totGlyphs).toFixed(1)}%)`);
const rows = [...stats.entries()].map(([k, m2]) => {
  const n = occ.get(k);
  const px = [...m2.entries()].map(([pos, m3]) => {
    const tr = [...m3.entries()].map(([t, c]) => `${t}×${c}`).join(' ');
    return `${pos}:{${tr}}`;
  });
  return { k, n, npx: m2.size, px };
});
rows.sort((a, b) => b.npx - a.npx);
console.log(`\n${rows.length} (ch|phase|face) combos with deviations:`);
for (const r of rows.slice(0, 30))
  console.log(`  ${r.k} (${r.n} occ): ${r.npx} px — ${r.px.slice(0, 6).join(' ')}`);

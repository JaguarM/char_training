// levels.mjs — fingerprint the target rasterizer from its byte statistics.
// Run this FIRST (no rendering needed): different rasterizers leave
// different byte lattices.
//
//   GDI GetGlyphOutline GGO_GRAY8_BITMAP  → 65 coverage levels 0..64,
//        bytes ∈ {255 - round(k·255/64)}          (~3.98 spacing)
//   GDI GGO_GRAY4_BITMAP                   → 17 levels (k/16)
//   FreeType / MuPDF 8-bit AA              → all 256 values, no lattice
//   Java2D, GDI+                           → 256 values, gamma-shaped histogram
//
//   node tools/levels.mjs            # histogram + best-lattice residuals
import { readFileSync } from 'node:fs';
import { readPgm } from './view.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));

const hist = new Uint32Array(256);
for (const t of targets) {
  const { w, h, px } = readPgm(`${root}/targets/${t.id}.pgm`);
  for (let i = 0; i < w * h; i++) hist[px[i]]++;
}
let tot = 0, distinct = 0;
for (let v = 0; v < 256; v++) if (hist[v]) { tot += hist[v]; distinct++; }
console.log(`ink+white bytes: ${tot}, distinct values: ${distinct}`);

for (const n of [16, 32, 64, 128]) {
  let on = 0;
  for (let v = 0; v < 256; v++) {
    if (!hist[v]) continue;
    const k = Math.round((255 - v) * n / 255);
    if (255 - Math.round(k * 255 / n) === v) on += hist[v];
  }
  console.log(`on ${n + 1}-level lattice: ${(100 * on / tot).toFixed(2)}%`);
}
console.log('\nvalue histogram (nonzero):');
const rows = [];
for (let v = 0; v < 256; v++) if (hist[v]) rows.push(`${v}:${hist[v]}`);
console.log(rows.join(' '));

// merge-templates.mjs — merge a freshly harvested template dir into an existing
// dictionary: variants whose pixels already exist for the same char are dropped,
// genuinely new rasters are copied under the next free variant number and their
// template_metrics.json entries appended (renamed to match). Grows one dictionary
// across documents instead of keeping a set per PDF.
//
//   node merge-templates.mjs <srcDir> <dstDir>
//   node merge-templates.mjs ../templates_synth_new ../templates_synth
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stemToChar } = require('../core.js');

const [srcDir, dstDir] = process.argv.slice(2).map(p => resolve(process.cwd(), p));
if (!srcDir || !dstDir) {
  console.error('usage: node merge-templates.mjs <srcDir> <dstDir>');
  process.exit(2);
}

// Decode a template PNG to per-pixel channel sums (R+G+B) — the exact value
// the loaders reduce to (gray = sum/3), so equal sums = equal template.
// Handles our filter-0 RGB output and browser-saved manual cuts (RGBA,
// filters 0–4); alpha is ignored like the canvas loader does.
function pngSums(file) {
  const p = readFileSync(file);
  let off = 8, W = 0, H = 0, colorType = 2; const idat = [];
  while (off < p.length) {
    const len = p.readUInt32BE(off), ty = p.toString('ascii', off + 4, off + 8);
    if (ty === 'IHDR') {
      W = p.readUInt32BE(off + 8); H = p.readUInt32BE(off + 12);
      if (p[off + 16] !== 8) throw new Error(`${file}: unsupported bit depth ${p[off + 16]}`);
      colorType = p[off + 17];
      if (colorType !== 2 && colorType !== 6) throw new Error(`${file}: unsupported color type ${colorType}`);
    }
    if (ty === 'IDAT') idat.push(p.subarray(off + 8, off + 8 + len));
    off += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3, stride = bpp * W;
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  const sums = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    const rowOff = y * (stride + 1), ft = raw[rowOff];
    for (let i = 0; i < stride; i++) {
      const x = raw[rowOff + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { // Paeth
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
        default: throw new Error(`${file}: unexpected PNG row filter ${ft}`);
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < W; x++) {
      const o = x * bpp;
      sums[y * W + x] = cur[o] + cur[o + 1] + cur[o + 2];
    }
    prev.set(cur);
  }
  return { W, H, sums };
}

const stemOf = f => {
  const m = /^(.*)_(\d+)\.png$/.exec(f);
  if (m) return { stem: m[1], n: parseInt(m[2], 10) };
  // unnumbered manual cut ("q.png", "0.png") — the loader accepts these, so
  // treat them as variant 0 of their stem
  const base = f.slice(0, -4);
  if (stemToChar(base)) return { stem: base, n: 0 };
  throw new Error(`unparseable template name: ${f}`);
};
const pngs = dir => readdirSync(dir).filter(f => f.endsWith('.png') && !f.includes('unmatched'));

// Index the destination: per stem, existing pixel buffers + highest variant number.
const dstByStem = new Map(); // stem → { maxN, rasters: [{W,H,sums}] }
for (const f of pngs(dstDir)) {
  const { stem, n } = stemOf(f);
  let e = dstByStem.get(stem);
  if (!e) { e = { maxN: 0, rasters: [] }; dstByStem.set(stem, e); }
  e.maxN = Math.max(e.maxN, n);
  e.rasters.push(pngSums(join(dstDir, f)));
}

const metPath = join(dstDir, 'template_metrics.json');
const dstMet = JSON.parse(readFileSync(metPath, 'utf8'));
const srcMet = JSON.parse(readFileSync(join(srcDir, 'template_metrics.json'), 'utf8'));
if (srcMet.fontSpec !== dstMet.fontSpec)
  throw new Error(`fontSpec mismatch: src "${srcMet.fontSpec}" vs dst "${dstMet.fontSpec}"`);
const srcMetByFile = new Map(srcMet.templates.map(t => [t.filename, t]));

// Does dst raster `r` appear as a horizontal sub-block of src raster `px`?
// A narrower same-char template that src merely EXTENDS already exact-matches
// every page spot src would (matchAt crops per template width), so src adds no
// reading coverage — it only SHADOWS the narrower cut in matchAt's widest-wins
// (typically with worse metrics: the extra column merges more phases).
const contains = (px, r) => {
  if (r.H !== px.H || r.W > px.W) return false;
  for (let dx = 0; dx + r.W <= px.W; dx++) {
    let ok = true;
    for (let y = 0; y < r.H && ok; y++)
      for (let x = 0; x < r.W; x++)
        if (px.sums[y * px.W + dx + x] !== r.sums[y * r.W + x]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
};

let copied = 0, dup = 0, shadowed = 0, singles = 0;
const added = new Map(); // char → count, for the summary line
for (const f of pngs(srcDir)) {
  const { stem } = stemOf(f);
  const px = pngSums(join(srcDir, f));
  let e = dstByStem.get(stem);
  if (!e) { e = { maxN: 0, rasters: [] }; dstByStem.set(stem, e); }
  const same = e.rasters.some(r => r.W === px.W && r.H === px.H &&
    r.sums.every((v, i) => v === px.sums[i]));
  if (same) { dup++; continue; }
  if (e.rasters.some(r => contains(px, r))) { shadowed++; continue; }
  // a single-occurrence variant of a char the dictionary already covers is more
  // often harvest debris (a sliver from a marginally-registered row) than signal
  if (e.rasters.length && (srcMetByFile.get(f)?.count ?? 0) <= 1) { singles++; continue; }
  const name = `${stem}_${++e.maxN}.png`;
  copyFileSync(join(srcDir, f), join(dstDir, name));
  e.rasters.push(px);
  const met = srcMetByFile.get(f);
  if (met) dstMet.templates.push({ ...met, filename: name });
  else console.warn(`  no metrics entry for ${f} — copied without one`);
  const ch = stemToChar(stem);
  added.set(ch, (added.get(ch) ?? 0) + 1);
  copied++;
}

writeFileSync(metPath, JSON.stringify(dstMet));
console.log(`merged ${srcDir} → ${dstDir}: ${copied} new template(s), ${dup} already present, ` +
  `${shadowed} contained-in-existing (skipped), ${singles} single-occurrence (skipped)`);
if (copied) console.log('new variants per char: ' +
  [...added.entries()].sort().map(([c, n]) => `${c}:${n}`).join(' '));

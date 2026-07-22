// export-pages.mjs — turn char_training's per-page raster cache into plain
// PGM (P5) grayscale files the C++ matcher mmap-reads. The cache is keyed by
// sha256(pdf)[:16] and stores gzipped GRY1 records; decoding here mirrors
// tools/raster-cache-browser.js exactly (modes 1/2/3 incl. the mode-3
// colored-flood whitening).
//
//   node tools/export-pages.mjs                        # big.pdf, all pages
//   node tools/export-pages.mjs --pdf <path> [--out <dir>] [--from <root>]
//
// If the cache is missing pages, rasterize first (in char_training):
//   node tools/rasterize.mjs --pdf corpus/big.pdf
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// gpu-ocr lives at <char_training>/ocr/gpu-ocr — the enclosing repo is ../..
const o = { from: resolve(ROOT, '..', '..'), pdf: null, out: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--from') o.from = resolve(next());
  else if (a === '--pdf') o.pdf = resolve(next());
  else if (a === '--out') o.out = resolve(next());
  else { console.error(`unknown arg ${a}`); process.exit(1); }
}
if (!o.pdf) o.pdf = join(o.from, 'corpus', 'big.pdf');
const stem = basename(o.pdf).replace(/\.pdf$/i, '');
if (!o.out) o.out = join(ROOT, 'data', 'pages', stem);

const key = createHash('sha256').update(readFileSync(o.pdf)).digest('hex').slice(0, 16);
const cacheDir = join(o.from, 'tools', 'raster-cache', key);
if (!existsSync(cacheDir)) {
  console.error(`no raster cache at ${cacheDir}\n` +
    `run (in char_training): node tools/rasterize.mjs --pdf ${o.pdf}`);
  process.exit(1);
}

// GRY1 record → {w,h,gray:Uint8Array} | {empty:true}. Same laws as
// raster-cache-browser.js rcFetchPage; PGM wants u8, so mode-2/3 sums round.
function decodeGry1(buf) {
  const hdr = new Uint32Array(buf.buffer, buf.byteOffset, 4);
  if (hdr[0] !== 0x31595247) throw new Error('bad GRY1 magic');
  const mode = hdr[1], w = hdr[2], h = hdr[3], n = w * h;
  if (mode === 0) return { empty: true };
  const gray = new Uint8Array(n);
  if (mode === 1) {
    gray.set(new Uint8Array(buf.buffer, buf.byteOffset + 16, n));
  } else if (mode === 2 || mode === 3) {
    const s = new Uint16Array(buf.buffer, buf.byteOffset + 16, n);
    for (let i = 0; i < n; i++) gray[i] = s[i] >= 765 ? 255 : Math.round(s[i] / 3);
    if (mode === 3) {
      // colored ink (channel spread ≥4) seeds a flood through any-spread
      // pixels; whatever it reaches is whitened — neutral text survives
      const sp = new Uint8Array(buf.buffer, buf.byteOffset + 16 + 2 * n, n);
      const colored = new Uint8Array(n), stack = [];
      for (let i = 0; i < n; i++) if (sp[i] >= 4) { colored[i] = 1; stack.push(i); }
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!colored[j] && sp[j]) { colored[j] = 1; stack.push(j); }
        }
      }
      for (let i = 0; i < n; i++) if (colored[i]) gray[i] = 255;
    }
  } else throw new Error(`unknown GRY1 mode ${mode}`);
  return { w, h, gray, mode };
}

mkdirSync(o.out, { recursive: true });
const pageFiles = readdirSync(cacheDir).filter(f => /^page-\d{4}\.gray\.gz$/.test(f)).sort();
let written = 0, empty = 0;
const manifest = [];
for (const f of pageFiles) {
  const pno = +/(\d{4})/.exec(f)[1];
  const rec = decodeGry1(gunzipSync(readFileSync(join(cacheDir, f))));
  if (rec.empty) { empty++; manifest.push({ page: pno, empty: true }); continue; }
  const name = `page-${String(pno).padStart(4, '0')}.pgm`;
  writeFileSync(join(o.out, name),
    Buffer.concat([Buffer.from(`P5\n${rec.w} ${rec.h}\n255\n`, 'latin1'), Buffer.from(rec.gray)]));
  manifest.push({ page: pno, file: name, w: rec.w, h: rec.h, mode: rec.mode });
  written++;
}
writeFileSync(join(o.out, 'pages.json'), JSON.stringify(
  { pdf: basename(o.pdf), cacheKey: key, pages: manifest }, null, 1));
console.log(`${o.out}: ${written} pages written, ${empty} empty (cache ${key})`);

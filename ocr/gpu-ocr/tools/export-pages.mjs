// export-pages.mjs — materialize a document as plain PGM (P5) grayscale pages
// the C++ matcher mmap-reads, plus optional per-page 256-byte .lut sidecars
// carrying a page law (palette / quant) the matcher applies to template bytes.
//
// Two page sources:
//
//   (default)  char_training's Chrome raster cache — gzipped GRY1 records
//              keyed by sha256(pdf)[:16]; decoding mirrors
//              tools/raster-cache-browser.js exactly (modes 1/2/3 incl. the
//              mode-3 colored-flood whitening). Needs a prior
//              `node tools/rasterize.mjs --pdf <pdf>` over there.
//
//   --mupdf    drive-speed direct decode: the page's largest image XObject's
//              samples via mupdf (raw decode of the embedded stream, like
//              ocr/tools/ingest.mjs) reduced under the SAME mode-2/3 laws.
//              No Chrome, no cache — this is the F:\ classifier feed. Pages
//              with no embedded image are recorded empty.
//
// Page-law sidecars (written as data/pages/<doc>/page-NNNN.lut, raw 256
// bytes; the exe auto-applies a sidecar to TEMPLATE bytes — the engine's law:
// predictions go through the map, the page stays in original space):
//
//   --palette  per-page /Indexed palette read straight from the PDF (the
//              eDiscovery Nimbus family): lut[v] = gray of the RGB-nearest
//              palette entry, ties darker; a palette that darkens white
//              (lut[255] < 250) is a scan image, not this family — skipped.
//              Same laws as char_training tools/blind-read.mjs --palette.
//   --quant    histogram law (email.pdf): available grays = the page's own
//              bytes (palette grays are fixpoints); lut[v] = nearest
//              available, ties darker. Same as ocr-engine.js quantMap.
//
//   node tools/export-pages.mjs                                  # big.pdf, cache
//   node tools/export-pages.mjs --pdf <path> [--out <dir>] [--from <root>]
//        [--mupdf] [--palette] [--quant] [--pages 1,3-5]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// gpu-ocr lives at <char_training>/ocr/gpu-ocr — the enclosing repo is ../..
const o = { from: resolve(ROOT, '..', '..'), pdf: null, out: null,
  mupdf: false, palette: false, quant: false, pages: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--from') o.from = resolve(next());
  else if (a === '--pdf') o.pdf = resolve(next());
  else if (a === '--out') o.out = resolve(next());
  else if (a === '--mupdf') o.mupdf = true;
  else if (a === '--palette') o.palette = true;
  else if (a === '--quant') o.quant = true;
  else if (a === '--pages') o.pages = next();
  else { console.error(`unknown arg ${a}`); process.exit(1); }
}
if (!o.pdf) o.pdf = join(o.from, 'corpus', 'big.pdf');
const stem = basename(o.pdf).replace(/\.pdf$/i, '');
if (!o.out) o.out = join(ROOT, 'data', 'pages', stem);

function pageFilter() {
  if (!o.pages) return null;
  const keep = new Set();
  for (const part of o.pages.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) { console.error(`bad --pages part: ${part}`); process.exit(1); }
    for (let p = +m[1]; p <= +(m[2] ?? m[1]); p++) keep.add(p);
  }
  return keep;
}
const keepPages = pageFilter();

// ---------------- shared reduction laws ----------------
// mode-2: page byte = sum>=765 ? 255 : round(sum/3). mode-3 adds the colored
// flood: channel-spread >=4 seeds, flood through any-spread pixels
// (8-connected), reached pixels whiten — neutral text survives.
function reduceRgb(rgb, n, w, h) {
  const N = w * h;
  const gray = new Uint8Array(N), spread = new Uint8Array(N);
  let colored = false;
  for (let i = 0; i < N; i++) {
    const r = rgb[i * n], g = rgb[i * n + 1], b = rgb[i * n + 2];
    const s = r + g + b;
    gray[i] = s >= 765 ? 255 : Math.round(s / 3);
    const sp = Math.max(r, g, b) - Math.min(r, g, b);
    spread[i] = sp > 255 ? 255 : sp;
    if (sp >= 4) colored = true;
  }
  if (!colored) return { gray, mode: 2 };
  floodWhiten(gray, spread, w, h);
  return { gray, mode: 3 };
}
function floodWhiten(gray, sp, w, h) {
  const n = w * h;
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

// GRY1 record → {w,h,gray} | {empty:true}. Same laws as raster-cache-browser.js.
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
      const sp = new Uint8Array(buf.buffer, buf.byteOffset + 16 + 2 * n, n);
      floodWhiten(gray, sp, w, h);
    }
  } else throw new Error(`unknown GRY1 mode ${mode}`);
  return { w, h, gray, mode };
}

// ---------------- page sources ----------------
function* cachePages() {
  const key = createHash('sha256').update(readFileSync(o.pdf)).digest('hex').slice(0, 16);
  const cacheDir = join(o.from, 'tools', 'raster-cache', key);
  if (!existsSync(cacheDir)) {
    console.error(`no raster cache at ${cacheDir}\n` +
      `run (in char_training): node tools/rasterize.mjs --pdf ${o.pdf}\n` +
      `or use --mupdf for image-based PDFs (no Chrome needed)`);
    process.exit(1);
  }
  const files = readdirSync(cacheDir).filter(f => /^page-\d{4}\.gray\.gz$/.test(f)).sort();
  for (const f of files) {
    const pno = +/(\d{4})/.exec(f)[1];
    if (keepPages && !keepPages.has(pno)) continue;
    yield { pno, ...decodeGry1(gunzipSync(readFileSync(join(cacheDir, f)))) };
  }
}

async function* mupdfPages(doc) {
  const n = doc.countPages();
  for (let p = 0; p < n; p++) {
    const pno = p + 1;
    if (keepPages && !keepPages.has(pno)) continue;
    let best = null;
    try {
      const page = doc.loadPage(p);
      const xo = page.getObject()?.get('Resources')?.get('XObject');
      xo?.forEach?.((v) => {
        try {
          const d = v.resolve?.() ?? v;
          if (d.get('Subtype')?.asName?.() !== 'Image') return;
          const w = d.get('Width')?.asNumber?.() ?? 0, h = d.get('Height')?.asNumber?.() ?? 0;
          if (!best || w * h > best.w * best.h) best = { ref: v, w, h };
        } catch {}
      });
    } catch {}
    if (!best) { yield { pno, empty: true }; continue; }
    let pix;
    try { pix = doc.loadImage(best.ref).toPixmap(); }
    catch { yield { pno, empty: true }; continue; }
    const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getNumberOfComponents();
    const px = pix.getPixels();
    if (nc === 1) yield { pno, w, h, gray: Uint8Array.from(px.subarray ? px.subarray(0, w * h) : px), mode: 1 };
    else if (nc >= 3) yield { pno, w, h, ...reduceRgb(px, nc, w, h) };
    else yield { pno, empty: true };
  }
}

// ---------------- LUT producers ----------------
// per-page /Indexed palette LUTs, straight from the PDF (blind-read law)
function paletteLUTs(doc) {
  const luts = new Map();
  const n = doc.countPages();
  for (let p = 0; p < n; p++) {
    try {
      const page = doc.loadPage(p);
      const xo = page.getObject()?.get('Resources')?.get('XObject');
      if (!xo || !xo.isDictionary?.()) continue;
      let best = null, bestPx = -1;
      xo.forEach(val => {
        try {
          const im = val.resolve?.() ?? val;
          if (im.get('Subtype')?.asName?.() !== 'Image') return;
          const px = (im.get('Width')?.asNumber?.() ?? 0) * (im.get('Height')?.asNumber?.() ?? 0);
          const cs = im.get('ColorSpace')?.resolve?.() ?? im.get('ColorSpace');
          if (!cs?.isArray?.() || cs.get(0)?.asName?.() !== 'Indexed') return;
          if (px > bestPx) { bestPx = px; best = cs; }
        } catch {}
      });
      if (!best) continue;
      const hival = Math.min(best.get(2)?.asNumber?.() ?? 255, 255);
      // readStream must be called on the indirect REF (mupdf-js quirk)
      const lookup = best.get(3);
      let pal = null;
      try { pal = lookup.readStream().asUint8Array(); } catch {}
      if (!pal) { try { pal = Uint8Array.from(lookup.asByteString()); } catch {} }
      if (!pal || pal.length < 3) continue;
      const entries = [];
      const nEnt = Math.min(Math.floor(pal.length / 3), hival + 1);
      for (let k = 0; k + 2 < nEnt * 3; k += 3) entries.push([pal[k], pal[k + 1], pal[k + 2]]);
      if (!entries.length) continue;
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        let bst = null, bd = Infinity;
        for (const e of entries) {
          const d = (e[0] - v) ** 2 + (e[1] - v) ** 2 + (e[2] - v) ** 2;
          if (d < bd || (d === bd && e[0] + e[1] + e[2] < bst[0] + bst[1] + bst[2])) { bd = d; bst = e; }
        }
        lut[v] = Math.round((bst[0] + bst[1] + bst[2]) / 3);
      }
      if (lut[255] < 250) continue;          // darkens white: scan image, not this family
      luts.set(pno0(p), lut);
    } catch {}
  }
  return luts;
}
const pno0 = p => p + 1;

// histogram quant LUT from the page's own bytes (ocr-engine.js quantMap law)
function quantLut(gray) {
  const seen = new Uint8Array(256);
  for (const v of gray) seen[v] = 1;
  const avail = [];
  for (let v = 0; v < 256; v++) if (seen[v]) avail.push(v);
  if (avail.length === 256) return null;     // identity — no sidecar needed
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let best = avail[0];
    for (const a of avail) {
      const d = Math.abs(a - v), bd = Math.abs(best - v);
      if (d < bd || (d === bd && a < best)) best = a;
    }
    lut[v] = best;
  }
  return lut;
}

// ---------------- main ----------------
let docHandle = null;
async function main() {
  if (o.mupdf || o.palette) {
    const mupdf = await import('mupdf');
    docHandle = mupdf.PDFDocument.openDocument(readFileSync(o.pdf), 'application/pdf');
  }
  const palLuts = o.palette ? paletteLUTs(docHandle) : new Map();
  if (o.palette && !palLuts.size) console.error('  (--palette: no /Indexed palettes found)');

  mkdirSync(o.out, { recursive: true });
  let written = 0, empty = 0, luts = 0;
  const manifest = [];
  const source = o.mupdf ? mupdfPages(docHandle) : cachePages();
  for await (const rec of source) {
    if (rec.empty) { empty++; manifest.push({ page: rec.pno, empty: true }); continue; }
    const tag = String(rec.pno).padStart(4, '0');
    const name = `page-${tag}.pgm`;
    writeFileSync(join(o.out, name),
      Buffer.concat([Buffer.from(`P5\n${rec.w} ${rec.h}\n255\n`, 'latin1'), Buffer.from(rec.gray)]));
    let lut = palLuts.get(rec.pno) ?? null, law = lut ? 'palette' : null;
    if (!lut && o.quant) { lut = quantLut(rec.gray); if (lut) law = 'quant'; }
    if (lut) { writeFileSync(join(o.out, `page-${tag}.lut`), Buffer.from(lut)); luts++; }
    manifest.push({ page: rec.pno, file: name, w: rec.w, h: rec.h, mode: rec.mode,
      ...(law ? { lut: law } : {}) });
    written++;
  }
  writeFileSync(join(o.out, 'pages.json'), JSON.stringify(
    { pdf: basename(o.pdf), source: o.mupdf ? 'mupdf' : 'raster-cache',
      palette: o.palette, quant: o.quant, pages: manifest }, null, 1));
  console.log(`${o.out}: ${written} pages written, ${empty} empty, ${luts} lut sidecars` +
    ` (${o.mupdf ? 'mupdf-direct' : 'raster cache'})`);
}
await main();

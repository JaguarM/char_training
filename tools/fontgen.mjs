// ---------------------------------------------------------------------------
// fontgen.mjs — glyph raster generator (JS successor of the retired Python
// tools/fontgen/fontgen.py, tag `python-era`). Renders every char of a font
// at all requested subpixel pen phases and writes one assets/fonts/*.npz in
// the exact layout export-glyphs.mjs consumes (meta/adv/g_*/o_* npy entries).
//
// The rasterizer is ocr/tools/ftclone.mjs — the certified pure-JS port of the
// mupdf-1.28 glyph pipeline (FT 26.6 unhinted + ftgrays FT_INT64 + FZ_BLEND
// over white), byte-certified 0-diff against mupdf-wasm fillText for both TTF
// and CFF paths (run `node ocr/tools/ftclone.mjs` to re-certify). Unlike
// fillText it can place pens on any 1/64 px, so all phases are first-class.
//
// mupdf (the wasm npm package) is used ONLY for character→gid mapping and
// design-unit advances; it is resolved from ocr/node_modules (the main repo
// stays dependency-free). Run `cd ocr && npm install` once if missing.
//
//   node tools/fontgen.mjs --font ocr/fonts/NimbusMonoPS-Regular.cff \
//        --em64 791 --phases-y 0 --out assets/fonts/nimbus_791.npz
//   node tools/fontgen.mjs --font path/to/face.ttf --size 16   # em64 = 1024
//
// --em64 N   : matrix coefficient trunc(em·64) — THE sharp identifier of a
//              render config (sizePx = N/64). --size S is the convenience
//              spelling (em64 = trunc(S·64)).
// --phases-y : "0" (integer-baseline producers, e.g. the Outside In / builtin
//              Courier family) or "0,0.5" (the corpus-era 8-phase layout).
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { FTClone } from '../ocr/tools/ftclone.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// printable ASCII + the corpus punctuation/ligatures + Western-European
// accents — verbatim the retired Python DEFAULT_CHARS (171 chars)
const DEFAULT_CHARS = (() => {
  let s = '';
  for (let c = 33; c < 127; c++) s += String.fromCharCode(c);
  return s + '‘’“”–—…•§¶©ﬁﬂ'
    + 'àâäçèéêëìîïòôöùûüÿñæœÀÂÄÇÈÉÊËÌÎÏÒÔÖÙÛÜŸÑÆŒáíóúýÁÍÓÚÝßãõÃÕ°±²³€£¥';
})();

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', null);
if (!FONT) { console.error('usage: node tools/fontgen.mjs --font <file> (--em64 N | --size S) --out <npz> [--phases-y 0|0,0.5] [--chars <string>]'); process.exit(1); }
const EM64 = optS('em64', null) !== null ? +optS('em64', null)
  : optS('size', null) !== null ? Math.trunc(+optS('size', null) * 64)
  : (() => { console.error('need --em64 or --size'); process.exit(1); })();
const SIZE_PX = EM64 / 64;
const PHASES_X = [0, 0.25, 0.5, 0.75];
const PHASES_Y = optS('phases-y', '0,0.5').split(',').map(Number);
const CHARS = optS('chars', DEFAULT_CHARS);
// --linear: bake the eDiscovery post-law into the set bytes (raw ∈ [128,253]
// → +1) and tag meta.pipeline 'linear-remap' so the engine's linear-set
// machinery (glyph-bundle alphaOf, scanLine shift accounting) engages.
const LINEAR = args.includes('--linear');
// --ink C: gray srcover ink over white (b = 255 − round(cov·(255−C)/255))
// instead of black FZ_BLEND — the court/ECF sub-family's gray blockquote
// (C=27) and ECF-banner (C=118) text, FINDINGS-nimbusrom.md §sub-family 2.
// Carries the family's known srcover ±1 quirk: read these sets at tol 2
// (calibri g23 precedent). Mutually exclusive with --linear.
const INK = optS('ink', null) !== null ? +optS('ink', null) : null;
if (INK !== null && LINEAR) { console.error('--ink and --linear are mutually exclusive'); process.exit(1); }
const OUT = resolve(REPO, optS('out', `assets/fonts/${FONT.replace(/^.*[\\/]/, '').replace(/\..*$/, '')}_${EM64}.npz`));
const fontPath = resolve(REPO, FONT);

// ---- mupdf (gid map + design advances), resolved from ocr/node_modules ----
async function loadMupdf() {
  const dir = join(REPO, 'ocr', 'node_modules', 'mupdf');
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch { throw new Error('mupdf not installed — run: cd ocr && npm install'); }
  const exp = pkg.exports;
  const entry = typeof exp === 'string' ? exp
    : exp?.['.'] ? (typeof exp['.'] === 'string' ? exp['.'] : exp['.'].import ?? exp['.'].default)
    : pkg.module ?? pkg.main;
  return import(pathToFileURL(join(dir, entry)).href);
}
const mupdf = await loadMupdf();
const mfont = new mupdf.Font('F', readFileSync(fontPath));

// ---- render every (char, phx, phy) through the certified clone ------------
const PENX = Math.ceil(SIZE_PX) + 3, BASEY = Math.ceil(SIZE_PX * 1.6) + 3;
const W = PENX + Math.ceil(SIZE_PX * 2.4), H = BASEY + Math.ceil(SIZE_PX * 0.9);
const clone = new FTClone(fontPath, W, H);
const upm = clone.upm;
if (clone.cff) clone.setGidMap(new Map([...CHARS].map(c => [c.codePointAt(0), mfont.encodeCharacter(c.codePointAt(0))])));

const glyphs = new Map();        // key `${cp}_${phx*4}_${phy*2}` -> {raster,w,h,dx,dy}
const advances = [];             // per char, px (design units × sizePx / upm — exact ints in, one rounding out)
let nInk = 0;
for (const c of CHARS) {
  const cp = c.codePointAt(0);
  const gid = mfont.encodeCharacter(cp);
  advances.push(gid ? Math.round(mfont.advanceGlyph(gid, 0) * upm) * SIZE_PX / upm : 0);
  for (const phx of PHASES_X) for (const phy of PHASES_Y) {
    const key = `${cp}_${Math.round(phx * 4)}_${Math.round(phy * 2)}`;
    const empty = { raster: Buffer.alloc(0), w: 0, h: 0, dx: 0, dy: 0 };
    if (!gid) { glyphs.set(key, empty); continue; }
    let dst;
    if (INK !== null) {
      const cov = clone.coverage(cp, EM64, EM64, PENX * 64 + Math.round(phx * 64), BASEY * 64 + Math.round(phy * 64));
      if (cov) {
        dst = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) dst[i] = 255 - Math.round(cov[i] * (255 - INK) / 255);
      }
    } else dst = clone.render(cp, EM64, EM64, PENX * 64 + Math.round(phx * 64), BASEY * 64 + Math.round(phy * 64), 1);
    if (!dst) { glyphs.set(key, empty); continue; }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let r = 0; r < H; r++) for (let col = 0; col < W; col++)
      if (dst[r * W + col] < 255) { if (col < x0) x0 = col; if (col > x1) x1 = col; if (r < y0) y0 = r; if (r > y1) y1 = r; }
    if (x1 < 0) { glyphs.set(key, empty); continue; }
    if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1)
      throw new Error(`glyph '${c}' phase ${phx}/${phy} touches the render window edge — enlarge W/H`);
    const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
    const raster = Buffer.alloc(gw * gh);
    for (let r = 0; r < gh; r++)
      for (let col = 0; col < gw; col++) {
        let b = dst[(y0 + r) * W + x0 + col];
        if (LINEAR && b >= 128 && b <= 254) b++;   // raw 254 (cov 1) → 255: producer drops it (EFTA00039208 byte-proven)
        raster[r * gw + col] = b;
      }
    glyphs.set(key, { raster, w: gw, h: gh, dx: x0 - PENX, dy: y0 - BASEY });
    nInk++;
  }
  clone.cache.clear();
}

// ---- npz writer (numpy-compatible zip of .npy entries) --------------------
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
function writeZip(path, entries) {            // entries: [name, Buffer][]
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data] of entries) {
    const comp = deflateRawSync(data, { level: 9 });
    const nameB = Buffer.from(name, 'latin1');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10);           // method 8, time/date 0
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

const meta = {
  fontfile: FONT.replace(/\\/g, '/'), size_px: SIZE_PX, chars: CHARS,
  phases_x: PHASES_X, phases_y: PHASES_Y,
  pipeline: `ftclone em64 ${EM64} unhinted-ft ftgrays single-draw (certified vs mupdf-wasm; ocr/FINDINGS.md)`
    + (LINEAR ? ' linear-remap' : '') + (INK !== null ? ` srcover-ink-${INK}` : ''),
};
const advBuf = Buffer.alloc(advances.length * 8);
advances.forEach((a, i) => advBuf.writeDoubleLE(a, i * 8));
const entries = [
  ['meta.npy', npy('|u1', [Buffer.byteLength(JSON.stringify(meta))], Buffer.from(JSON.stringify(meta)))],
  ['adv.npy', npy('<f8', [advances.length], advBuf)],
];
for (const c of CHARS) for (const phx of PHASES_X) for (const phy of PHASES_Y) {
  const key = `${c.codePointAt(0)}_${Math.round(phx * 4)}_${Math.round(phy * 2)}`;
  const g = glyphs.get(key);
  entries.push([`g_${key}.npy`, npy('|u1', [g.h, g.w], g.raster)]);
  const o = Buffer.alloc(4);
  o.writeInt16LE(g.dx, 0); o.writeInt16LE(g.dy, 2);
  entries.push([`o_${key}.npy`, npy('<i2', [2], o)]);
}
writeZip(OUT, entries);
console.log(`${OUT}: ${CHARS.length} chars x ${PHASES_X.length * PHASES_Y.length} phases (${nInk} rasters with ink), em64 ${EM64} = ${SIZE_PX} px, upm ${upm}`);

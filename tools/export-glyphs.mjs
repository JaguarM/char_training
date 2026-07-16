// ---------------------------------------------------------------------------
// export-glyphs.mjs — build assets/glyphs/glyphs.bin, THE glyph dictionary
// (every fontgen set in one binary file), from the committed .npz rasters
// (assets/fonts/, zero corpus pixels). Layout: tools/glyph-bundle.mjs.
// Zero dependencies (own zip/npy parser).
//
//   node tools/export-glyphs.mjs            # (re)build glyphs.bin
//   node tools/export-glyphs.mjs --check    # rebuild in memory and byte-
//         compare against the committed bundle — proves it is a pure
//         derivation of the committed rasters (npm run glyphs-check)
//
// SETS below is the explicit name → npz manifest (a new font = new line).
// Both y-phases are exported (integer and half-px baselines); rasters are
// the raw uint8 MuPDF gray windows plus the true rasterizer alpha derived
// through the set's compositor law (see COV), with (dx, dy) offsets
// relative to the integer pen / baseline and the exact dyadic freetype
// advance. The per-set JSON era (glyphs_*.json) ended 2026-07-16; the one
// parked _OFF experiment keeps its JSON as provenance.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(REPO, 'assets', 'fonts');
const BUNDLE = join(REPO, 'assets', 'glyphs', 'glyphs.bin');

// name → npz manifest (bundle order; names are what --glyphs / loadSets use)
const SETS = [
  ['arial16', 'arial_16.npz'],
  ['arialbd16', 'arialbd_16.npz'],
  ['calibri16', 'calibri_16.npz'],
  ['calibrib16', 'calibrib_16.npz'],
  ['calibrii16', 'calibrii_16.npz'],
  ['cour10', 'cour_10.npz'],
  ['cour11', 'cour_11.npz'],
  ['cour12', 'cour_12.npz'],
  ['cour13', 'cour_13.npz'],
  ['cour16', 'cour_16.npz'],
  ['courbd13', 'courbd_13.npz'],
  ['courbd16', 'courbd_16.npz'],
  ['georgia16', 'georgia_16.npz'],
  ['segoeui16', 'segoeui_16.npz'],
  ['segoeuib16', 'segoeuib_16.npz'],
  ['segoeuii16', 'segoeuii_16.npz'],
  ['times13', 'times_13.npz'],
  ['times16', 'times_16.npz'],
  ['timesbd16', 'timesbd_16.npz'],
  ['timesbd17', 'timesbd_17.npz'],
  ['timesbd18', 'timesbd_18.npz'],
  ['timesbdlin16', 'timesbdlin_16.npz'],
  ['timesi16', 'timesi_16.npz'],
  ['timesilin16', 'timesilin_16.npz'],
  ['timeslin16', 'timeslin_16.npz'],
  ['tnr8_16', 'tnr8_16.npz'],
  ['tnr8lin10', 'tnr8lin_10.667.npz'],
  ['tnr8lin16', 'tnr8lin_16.npz'],
  ['verdana16', 'verdana_16.npz'],
  ['verdanab16', 'verdanab_16.npz'],
];

// --- minimal ZIP reader (central directory walk; stored + deflate) --------
function zipEntries(buf) {
  let eocd = -1;                                   // EOCD signature scan from the end
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30),
      clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('latin1', off + 46, off + 46 + nlen);
    const dataOff = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    entries.set(name, () => {
      const raw = buf.subarray(dataOff, dataOff + csize);
      return method === 8 ? inflateRawSync(raw) : method === 0 ? raw
        : (() => { throw new Error(`zip method ${method}`); })();
    });
    off += 46 + nlen + xlen + clen;
  }
  return entries;
}

// --- minimal .npy parser (v1/v2, C-order, |u1 / <i2 / <f8) -----------------
function parseNpy(b) {
  if (b.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('not npy');
  const major = b[6];
  const hlen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hoff = major === 1 ? 10 : 12;
  const hdr = b.toString('latin1', hoff, hoff + hlen);
  const descr = /'descr':\s*'([^']+)'/.exec(hdr)[1];
  if (/'fortran_order':\s*True/.test(hdr)) throw new Error('fortran order unsupported');
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(hdr)[1].match(/\d+/g) ?? []).map(Number);
  const data = b.subarray(hoff + hlen);
  const n = shape.reduce((a, v) => a * v, 1);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const arr = descr === '|u1' ? new Uint8Array(ab, 0, n)
    : descr === '<i2' ? new Int16Array(ab, 0, n)
    : descr === '<f8' ? new Float64Array(ab, 0, n)
    : (() => { throw new Error(`dtype ${descr}`); })();
  return { shape, arr, bytes: data.subarray(0, n * arr.BYTES_PER_ELEMENT) };
}

// True rasterizer alpha, derived per byte through each producer's proven law
// (the .npz windows are MuPDF gray-on-white renders — page space):
//   standard  gb = (255·(256−e))>>8 with e = cov + (cov>>7)  →  coverage.
//             The single collision (gb=0 ← cov 254 AND 255) predicts the
//             same page byte at EVERY canvas value ((cv·(256−e))>>8 = 0 for
//             both), so the smaller coverage is canonical.
//   linear    gb = raw + 1 for raw ∈ [128,253], else gb = raw  →  raw byte.
// White (gb=255) carries no glyph contribution: alpha 0 / raw 255.
const COV = (() => {
  const t = new Uint8Array(256);
  for (let cov = 255; cov >= 0; cov--) {          // descending: smaller cov wins the tie
    const e = cov + (cov >> 7);
    t[(255 * (256 - e)) >> 8] = cov;
  }
  return t;                                        // t[255] = 0 (cov 0 → gb 255)
})();
const alphaOf = (bytes, linear) => {
  const a = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    a[i] = linear ? (b === 255 ? 255 : b - (b >= 129 ? 1 : 0)) : COV[b];
  }
  return a;
};

// one set's payload (see glyph-bundle.mjs layout) + its directory fields.
// Char and phase order mirror the retired JSON exporter exactly (chars from
// meta.chars, phases phx-outer × phy-inner) — candidate order inside the
// readers is tie-break-significant and must never drift.
function buildSet(npzBase) {
  const entries = zipEntries(readFileSync(join(FONTS, npzBase)));
  const get = name => {
    const e = entries.get(name + '.npy');
    if (!e) throw new Error(`missing ${name}.npy in ${npzBase}`);
    return parseNpy(e());
  };
  const meta = JSON.parse(Buffer.from(get('meta').bytes).toString('utf8'));
  const adv = get('adv').arr;
  const linear = (meta.pipeline ?? '').includes('linear-remap');
  const charList = Array.from(meta.chars);
  const parts = [];
  const head = Buffer.alloc(4);
  head.writeUInt32LE(charList.length, 0);
  parts.push(head);
  charList.forEach((c, i) => {
    const ch = Buffer.alloc(13);
    ch.writeUInt32LE(c.codePointAt(0), 0);
    ch.writeDoubleLE(adv[i], 4);
    ch.writeUInt8(meta.phases_x.length * meta.phases_y.length, 12);
    parts.push(ch);
    for (const phx of meta.phases_x) for (const phy of meta.phases_y) {
      const suffix = `_${c.codePointAt(0)}_${Math.round(phx * 4)}_${Math.round(phy * 2)}`;
      const g = get('g' + suffix), o = get('o' + suffix);
      const empty = g.arr.length === 0;
      const w = empty ? 0 : g.shape[1], h = empty ? 0 : g.shape[0];
      const p = Buffer.alloc(10);
      p.writeUInt8(Math.round(phx * 4), 0);
      p.writeUInt8(Math.round(phy * 2), 1);
      p.writeInt16LE(o.arr[0], 2);
      p.writeInt16LE(o.arr[1], 4);
      p.writeUInt16LE(w, 6);
      p.writeUInt16LE(h, 8);
      parts.push(p);
      if (!empty) { parts.push(Buffer.from(g.bytes)); parts.push(alphaOf(g.bytes, linear)); }
    }
  });
  return { payload: Buffer.concat(parts), linear, sizePx: meta.size_px };
}

function buildBundle() {
  const built = SETS.map(([name, npz]) => ({ name, npz, ...buildSet(npz) }));
  let dirLen = 8;
  for (const s of built) dirLen += 1 + Buffer.byteLength(s.name) + 1 + Buffer.byteLength(s.npz) + 1 + 8 + 8;
  const dir = [Buffer.from('GBF1')];
  const cnt = Buffer.alloc(4);
  cnt.writeUInt32LE(built.length, 0);
  dir.push(cnt);
  let off = dirLen;
  for (const s of built) {
    const nameB = Buffer.from(s.name), npzB = Buffer.from(s.npz);
    const e = Buffer.alloc(1 + nameB.length + 1 + npzB.length + 1 + 8 + 8);
    let p = 0;
    e.writeUInt8(nameB.length, p); nameB.copy(e, p + 1); p += 1 + nameB.length;
    e.writeUInt8(npzB.length, p); npzB.copy(e, p + 1); p += 1 + npzB.length;
    e.writeUInt8(s.linear ? 1 : 0, p); p += 1;
    e.writeDoubleLE(s.sizePx, p); p += 8;
    e.writeUInt32LE(off, p); e.writeUInt32LE(s.payload.length, p + 4);
    dir.push(e);
    off += s.payload.length;
  }
  return Buffer.concat([...dir, ...built.map(s => s.payload)]);
}

const argv = process.argv.slice(2);
const want = buildBundle();
if (argv[0] === '--check') {
  let have = null;
  try { have = readFileSync(BUNDLE); } catch {}
  if (have && have.equals(want)) {
    console.log(`ok    glyphs.bin ⇔ ${SETS.length} npz sets (${Math.round(want.length / 1024)} KB)`);
  } else {
    console.log(have ? `FAIL  glyphs.bin differs from npz rebuild (${have.length} vs ${want.length} bytes)`
      : 'FAIL  glyphs.bin missing — run: node tools/export-glyphs.mjs');
    process.exit(1);
  }
} else if (argv.length === 0) {
  writeFileSync(BUNDLE, want);
  console.log(`${BUNDLE}: ${SETS.length} sets, ${Math.round(want.length / 1024)} KB`);
} else {
  console.error('usage: node tools/export-glyphs.mjs [--check]');
  process.exit(1);
}

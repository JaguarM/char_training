// glyph-bundle.mjs — node reader for assets/glyphs/glyphs.bin, THE glyph
// dictionary: every fontgen set in one binary file (raw gray + true-alpha
// planes, no JSON/base64 at load). Built and byte-certified against the
// committed .npz rasters by export-glyphs.mjs; the browser engine
// (src/blindocr.js parseBundle) reads the identical layout via DataView.
//
// Layout (little-endian):
//   'GBF1' u32-nSets
//   directory, per set: u8-nameLen name | u8-fontLen font(npz base) |
//     u8 flags (bit0 linear) | f64 sizePx | u32 payloadOff | u32 payloadLen
//   payload, per set: u32-nChars, per char: u32 cp | f64 adv | u8 nPhases,
//     per phase: u8 phx·4 | u8 phy·2 | i16 dx | i16 dy | u16 w | u16 h |
//     gray[w·h] | alpha[w·h]   (w = 0 ⇒ empty phase, no planes)
//
// materializeSet returns the exact per-candidate shape the readers use
// ({ch, adv, phx, w,h,dx,dy, bytes, alpha, ink, inkC/R/B/A, inkLeft} in the
// same byPhy insertion order the per-set JSONs produced — candidate order
// is tie-break-significant).
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)),
  '..', 'assets', 'glyphs', 'glyphs.bin');

// ---- .npz set building (shared with export-glyphs.mjs) -------------------
// minimal ZIP reader (central directory walk; stored + deflate)
export function zipEntries(buf) {
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

// minimal .npy parser (v1/v2, C-order, |u1 / <i2 / <f8)
export function parseNpy(b) {
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
//             same page byte at EVERY canvas value, so the smaller coverage
//             is canonical.
//   linear    gb = raw + 1 for raw ∈ [128,253], else gb = raw  →  raw byte.
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

// one set's payload in the exact glyphs.bin layout, straight from an .npz.
// Char and phase order mirror the retired JSON exporter exactly — candidate
// order inside the readers is tie-break-significant and must never drift.
export function buildSetFromNpz(npzPath) {
  const entries = zipEntries(readFileSync(npzPath));
  const get = name => {
    const e = entries.get(name + '.npy');
    if (!e) throw new Error(`missing ${name}.npy in ${npzPath}`);
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

// "glyphs_times16.json" / "times16" -> "times16" (legacy --glyphs spellings
// and every documented command line keep working)
export const setName = s => s.replace(/^.*glyphs_/, '').replace(/\.json$/, '');

let _bundle = null;
export function readBundle(path = BUNDLE_PATH) {
  if (_bundle && _bundle.path === path) return _bundle;
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'GBF1') throw new Error(`bad GBF1 magic: ${path}`);
  const dir = new Map();
  let o = 8;
  for (let i = 0, n = buf.readUInt32LE(4); i < n; i++) {
    const nameLen = buf[o]; const name = buf.toString('utf8', o + 1, o + 1 + nameLen); o += 1 + nameLen;
    const fontLen = buf[o]; const font = buf.toString('utf8', o + 1, o + 1 + fontLen); o += 1 + fontLen;
    const flags = buf[o]; o += 1;
    const sizePx = buf.readDoubleLE(o); o += 8;
    const off = buf.readUInt32LE(o), len = buf.readUInt32LE(o + 4); o += 8;
    dir.set(name, { name, font, linear: !!(flags & 1), sizePx, off, len });
  }
  return _bundle = { path, buf, dir };
}

// -> { name, sizePx, linear, font, byPhy, maxAsc, maxDesc }; trimInk is the
// bench's --matchcols hook (called per phase record, may replace ink arrays).
// nameOrFile may also be a PATH to an .npz raster set (fontgen output): the
// set is materialized directly, bypassing the committed bundle — candidate
// fonts become testable without any SETS/export registration ceremony.
export function materializeSet(nameOrFile, trimInk = null, path = BUNDLE_PATH) {
  let buf, d, name;
  if (/\.npz$/i.test(nameOrFile)) {
    const npzPath = resolve(process.cwd(), nameOrFile);
    const s = buildSetFromNpz(npzPath);
    buf = s.payload;
    name = basename(npzPath).replace(/\.npz$/i, '');
    d = { off: 0, sizePx: s.sizePx, linear: s.linear, font: basename(npzPath) };
  } else {
    const bundle = readBundle(path);
    buf = bundle.buf;
    name = setName(nameOrFile);
    d = bundle.dir.get(name);
    if (!d) throw new Error(`set "${name}" not in ${path} (have: ${[...bundle.dir.keys()].join(' ')})`);
  }
  const byPhy = new Map();
  let maxAsc = 0, maxDesc = 0;
  let o = d.off;
  const nChars = buf.readUInt32LE(o); o += 4;
  for (let ci = 0; ci < nChars; ci++) {
    const ch = String.fromCodePoint(buf.readUInt32LE(o)); o += 4;
    const adv = buf.readDoubleLE(o); o += 8;
    const nPh = buf[o]; o += 1;
    for (let pi = 0; pi < nPh; pi++) {
      const phx = buf[o] / 4, phy = buf[o + 1] / 2;
      const dx = buf.readInt16LE(o + 2), dy = buf.readInt16LE(o + 4);
      const w = buf.readUInt16LE(o + 6), h = buf.readUInt16LE(o + 8);
      o += 10;
      if (!w) continue;
      const bytes = buf.subarray(o, o + w * h);
      const alpha = buf.subarray(o + w * h, o + 2 * w * h);
      o += 2 * w * h;
      const ink = [];
      let inkLeft = w;
      for (let c = 0; c < w; c++)
        for (let rr = 0; rr < h; rr++)
          if (bytes[rr * w + c] < 255) { ink.push(rr * w + c); if (c < inkLeft) inkLeft = c; }
      let inkC = new Int16Array(ink.length), inkR = new Int16Array(ink.length),
        inkB = new Uint8Array(ink.length), inkA = new Uint8Array(ink.length);
      for (let k = 0; k < ink.length; k++) {
        inkC[k] = ink[k] % w; inkR[k] = (ink[k] / w) | 0;
        inkB[k] = bytes[ink[k]]; inkA[k] = alpha[ink[k]];
      }
      const rec = { ch, adv, phx, w, h, dx, dy, bytes, alpha, ink, inkC, inkR, inkB, inkA, inkLeft };
      if (trimInk) trimInk(rec);
      if (!byPhy.has(phy)) byPhy.set(phy, []);
      byPhy.get(phy).push(rec);
      maxAsc = Math.max(maxAsc, -dy);
      maxDesc = Math.max(maxDesc, dy + h);
    }
  }
  return { name, sizePx: d.sizePx, linear: d.linear, font: d.font, byPhy, maxAsc, maxDesc };
}

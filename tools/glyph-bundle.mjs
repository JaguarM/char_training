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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)),
  '..', 'assets', 'glyphs', 'glyphs.bin');

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
// bench's --matchcols hook (called per phase record, may replace ink arrays)
export function materializeSet(nameOrFile, trimInk = null, path = BUNDLE_PATH) {
  const { buf, dir } = readBundle(path);
  const name = setName(nameOrFile);
  const d = dir.get(name);
  if (!d) throw new Error(`set "${name}" not in ${path} (have: ${[...dir.keys()].join(' ')})`);
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

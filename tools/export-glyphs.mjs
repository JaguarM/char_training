// ---------------------------------------------------------------------------
// export-glyphs.mjs — export a fontgen GlyphSet (.npz) to the JSON the
// readers consume (assets/glyphs/glyphs_*.json). Node port of the retired
// tools/fontgen/export_glyphs.py; zero dependencies (own zip/npy parser).
//
// Both y-phases are exported (integer and half-px baselines — MuPDF can
// produce either; the known corpus uses integer only). Rasters are the raw
// uint8 gray windows (single glyph on white), base64, row-major, with
// (dx, dy) offsets relative to the integer pen / baseline and the exact
// dyadic freetype advance. Keys are "phx_phy" (e.g. "0.25_0.5"); phy=0 keeps
// the legacy bare key ("0.25"), floats formatted Python-style ("0.0").
//
//   node tools/export-glyphs.mjs <in.npz> <out.json>
//   node tools/export-glyphs.mjs --check     # regenerate every existing
//         assets/glyphs/glyphs_*.json from its .npz in memory and deep-
//         compare — proves the committed sets are reproducible from the
//         committed rasters (also certified the port against the Python
//         originals, 31/31 identical, 2026-07-15)
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(REPO, 'assets', 'fonts');
const GLYPHS = join(REPO, 'assets', 'glyphs');

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

const pyFloat = v => Number.isInteger(v) ? v.toFixed(1) : String(v);

// the exact transform of export_glyphs.py, npz path in → glyph-set object out
export function exportSet(npzPath) {
  const entries = zipEntries(readFileSync(npzPath));
  const get = name => {
    const e = entries.get(name + '.npy');
    if (!e) throw new Error(`missing ${name}.npy in ${npzPath}`);
    return parseNpy(e());
  };
  const meta = JSON.parse(Buffer.from(get('meta').bytes).toString('utf8'));
  const adv = get('adv').arr;
  const charList = Array.from(meta.chars);
  const chars = {};
  charList.forEach((c, i) => {
    const ph = {};
    for (const phx of meta.phases_x) for (const phy of meta.phases_y) {
      const suffix = `_${c.codePointAt(0)}_${Math.round(phx * 4)}_${Math.round(phy * 2)}`;
      const g = get('g' + suffix), o = get('o' + suffix);
      const key = phy === 0 ? pyFloat(phx) : `${pyFloat(phx)}_${pyFloat(phy)}`;
      const empty = g.arr.length === 0;
      ph[key] = { w: empty ? 0 : g.shape[1], h: empty ? 0 : g.shape[0],
        dx: o.arr[0], dy: o.arr[1],
        b64: empty ? '' : Buffer.from(g.bytes).toString('base64') };
    }
    chars[c] = { adv: adv[i], ph };
  });
  return { font: basename(npzPath), size_px: meta.size_px,
    linear: (meta.pipeline ?? '').includes('linear-remap'),
    phases_x: meta.phases_x, phases_y: meta.phases_y, chars };
}

// glyphs_<name><size>.json → assets/fonts/<name>_<size>[…].npz
function npzFor(jsonName) {
  const stem = jsonName.replace(/^glyphs_/, '').replace(/\.json$/, '');  // "tnr8_16", "cour13"
  const m = /^(.+?)_?(\d+)$/.exec(stem);
  if (!m) return null;
  const exact = join(FONTS, `${m[1]}_${m[2]}.npz`);
  try { if (statSync(exact).isFile()) return exact; } catch {}
  const near = readdirSync(FONTS).filter(f => f.startsWith(`${m[1]}_${m[2]}`) && f.endsWith('.npz'));
  return near.length === 1 ? join(FONTS, near[0]) : null;   // tnr8lin_10.667.npz
}

function deepDiff(a, b, path, out) {
  if (out.length >= 5) return;
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) { out.push(`${path}: type ${ta} vs ${tb}`); return; }
  if (ta === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      out.push(`${path}: keys [${ka.slice(0, 4)}…] vs [${kb.slice(0, 4)}…]`); return;
    }
    for (const k of ka) deepDiff(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b) out.push(`${path}: ${String(a).slice(0, 40)} vs ${String(b).slice(0, 40)}`);
}

function check() {
  const sets = readdirSync(GLYPHS).filter(f => /^glyphs_.*\.json$/.test(f)).sort();
  let ok = 0, skip = 0, bad = 0;
  for (const f of sets) {
    if (/_OFF\.json$/.test(f)) { console.log(`skip  ${f} (parked _OFF copy)`); skip++; continue; }
    const npz = npzFor(f);
    if (!npz) { console.log(`FAIL  ${f}: no matching .npz in assets/fonts/`); bad++; continue; }
    const want = JSON.parse(readFileSync(join(GLYPHS, f), 'utf8'));
    const got = JSON.parse(JSON.stringify(exportSet(npz)));   // normalize via JSON round-trip
    const diffs = [];
    deepDiff(want, got, f.replace(/\.json$/, ''), diffs);
    if (diffs.length) { console.log(`FAIL  ${f} ← ${basename(npz)}`); diffs.forEach(d => console.log('      ' + d)); bad++; }
    else { console.log(`ok    ${f} ← ${basename(npz)}`); ok++; }
  }
  console.log(`\n${ok} identical, ${skip} skipped, ${bad} failed of ${sets.length}`);
  process.exit(bad ? 1 : 0);
}

const argv = process.argv.slice(2);
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (!isMain) { /* imported for exportSet */ }
else if (argv[0] === '--check') check();
else if (argv.length >= 2) {
  const set = exportSet(argv[0]);
  writeFileSync(argv[1], JSON.stringify(set));
  const nPh = set.phases_x.length * set.phases_y.length;
  console.log(`${argv[1]}: ${Object.keys(set.chars).length} chars x ${nPh} phases, ` +
    `${Math.round(statSync(argv[1]).size / 1024)} KB`);
} else {
  console.error('usage: node tools/export-glyphs.mjs <in.npz> <out.json> | --check');
  process.exit(1);
}

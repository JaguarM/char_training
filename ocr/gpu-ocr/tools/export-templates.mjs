// export-templates.mjs — pull a fontgen glyph set (.npz) out of char_training
// and flatten it into TPL1, the dumb little binary the C++/CUDA matcher loads.
//
//   node tools/export-templates.mjs                       # times_16.npz
//   node tools/export-templates.mjs --set timesbd_16.npz  # expansion later
//   node tools/export-templates.mjs --from <char_training root>
//
// TPL1 (little-endian):
//   'TPL1' u32 version=1 | f64 sizePx | f64 spaceAdv | u32 nRecords
//   per record: u32 codepoint | f64 advance | u8 phx4 | u8 phy2 |
//               i16 dx | i16 dy | u16 w | u16 h | u8 gray[w*h]
//
// gray is the glyph rendered alone on white in PAGE space (what the page
// bytes look like where nothing overlaps) — the template image, full glyph,
// no cropping. dx/dy place the bitmap's top-left relative to the integer pen
// x / baseline y; phx4/phy2 are the baked-in subpixel phase (x quarters,
// y halves). Advance is the exact dyadic FreeType advance.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// gpu-ocr lives at <char_training>/ocr/gpu-ocr — the enclosing repo is ../..
const o = { from: resolve(ROOT, '..', '..'), set: 'times_16.npz', out: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--from') o.from = resolve(next());
  else if (a === '--set') o.set = next();
  else if (a === '--out') o.out = resolve(next());
  else { console.error(`unknown arg ${a}`); process.exit(1); }
}
if (!o.out) o.out = join(ROOT, 'data', 'templates', basename(o.set).replace(/\.npz$/i, '') + '.tpl');

// ---- minimal ZIP reader (central directory; stored + deflate) ----
function zipEntries(buf) {
  let eocd = -1;
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

// ---- minimal .npy parser (v1/v2, C-order, |u1 / <i2 / <f8) ----
function parseNpy(b) {
  if (b.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('not npy');
  const major = b[6];
  const hlen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hoff = major === 1 ? 10 : 12;
  const hdr = b.toString('latin1', hoff, hoff + hlen);
  const descr = /'descr':\s*'([^']+)'/.exec(hdr)[1];
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

const npzPath = join(o.from, 'assets', 'fonts', o.set);
const entries = zipEntries(readFileSync(npzPath));
const get = name => {
  const e = entries.get(name + '.npy');
  if (!e) throw new Error(`missing ${name}.npy in ${npzPath}`);
  return parseNpy(e());
};

const meta = JSON.parse(Buffer.from(get('meta').bytes).toString('utf8'));
const adv = get('adv').arr;
const chars = Array.from(meta.chars);
const spaceIdx = chars.indexOf(' ');
const spaceAdv = spaceIdx >= 0 ? adv[spaceIdx] : 0;

const records = [];
chars.forEach((c, i) => {
  for (const phx of meta.phases_x) for (const phy of meta.phases_y) {
    const suffix = `_${c.codePointAt(0)}_${Math.round(phx * 4)}_${Math.round(phy * 2)}`;
    const g = get('g' + suffix), off = get('o' + suffix);
    if (g.arr.length === 0) continue;                    // no ink (space etc.)
    records.push({
      cp: c.codePointAt(0), ch: c, adv: adv[i],
      phx4: Math.round(phx * 4), phy2: Math.round(phy * 2),
      dx: off.arr[0], dy: off.arr[1],
      w: g.shape[1], h: g.shape[0], gray: Buffer.from(g.bytes),
    });
  }
});

const parts = [];
const head = Buffer.alloc(4 + 4 + 8 + 8 + 4);
head.write('TPL1', 0, 'latin1');
head.writeUInt32LE(1, 4);
head.writeDoubleLE(meta.size_px, 8);
head.writeDoubleLE(spaceAdv, 16);
head.writeUInt32LE(records.length, 24);
parts.push(head);
for (const r of records) {
  const rb = Buffer.alloc(4 + 8 + 1 + 1 + 2 + 2 + 2 + 2);
  let p = 0;
  rb.writeUInt32LE(r.cp, p); p += 4;
  rb.writeDoubleLE(r.adv, p); p += 8;
  rb.writeUInt8(r.phx4, p++); rb.writeUInt8(r.phy2, p++);
  rb.writeInt16LE(r.dx, p); p += 2; rb.writeInt16LE(r.dy, p); p += 2;
  rb.writeUInt16LE(r.w, p); p += 2; rb.writeUInt16LE(r.h, p); p += 2;
  parts.push(rb, r.gray);
}
mkdirSync(dirname(o.out), { recursive: true });
writeFileSync(o.out, Buffer.concat(parts));
writeFileSync(o.out.replace(/\.tpl$/, '.json'), JSON.stringify({
  set: o.set, sizePx: meta.size_px, spaceAdv,
  phases_x: meta.phases_x, phases_y: meta.phases_y,
  records: records.map(r => ({ ch: r.ch, adv: r.adv, phx4: r.phx4, phy2: r.phy2,
    dx: r.dx, dy: r.dy, w: r.w, h: r.h,
    ink: r.gray.reduce((a, v) => a + (v < 255 ? 1 : 0), 0) })),
}, null, 1));

const kb = Math.round(parts.reduce((a, b) => a + b.length, 0) / 1024);
console.log(`${o.out}: ${records.length} templates (${chars.length} chars, ` +
  `phases ${meta.phases_x.length}x${meta.phases_y.length}), spaceAdv ${spaceAdv}, ${kb} KB`);

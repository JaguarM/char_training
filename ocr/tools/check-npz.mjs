// check-npz.mjs — certify a fontgen .npz against THIS workspace's ground
// truth: every (id, pen) pair in hits-nimbus-791.json (the 113 byte-EXACT
// targets of FINDINGS.md) must be reproduced byte-for-byte by the npz raster
// of that char at that ¼-px phase — same full-window compare as
// sweep-ft.mjs exactAt (target margins included; the npz raster is the tight
// ink crop, everything outside it must be white in the target).
//
//   node tools/check-npz.mjs ../assets/fonts/nimbus_791.npz [hits-nimbus-791.json]
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const npzPath = process.argv[2] ?? `${root}/../assets/fonts/nimbus_791.npz`;
const hitsPath = process.argv[3] ?? `${root}/hits-nimbus-791.json`;

// minimal zip + npy readers (same layout export-glyphs.mjs certifies)
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('latin1', off + 46, off + 46 + nlen);
    const dataOff = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    entries.set(name, () => {
      const raw = buf.subarray(dataOff, dataOff + csize);
      return method === 8 ? inflateRawSync(raw) : raw;
    });
    off += 46 + nlen + xlen + clen;
  }
  return entries;
}
function parseNpy(b) {
  const hlen = b[6] === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hoff = b[6] === 1 ? 10 : 12;
  const hdr = b.toString('latin1', hoff, hoff + hlen);
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(hdr)[1].match(/\d+/g) ?? []).map(Number);
  return { shape, data: b.subarray(hoff + hlen) };
}
function readPgm(p) {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1'));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
}
function inkBbox(px, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (px[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

const entries = zipEntries(readFileSync(npzPath));
const get = n => parseNpy(entries.get(n + '.npy')());
const meta = JSON.parse(Buffer.from(get('meta').data).toString('utf8'));
const advArr = new Float64Array(get('adv').data.buffer.slice(
  get('adv').data.byteOffset, get('adv').data.byteOffset + meta.chars.length * 8));
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
const byId = new Map(targets.map(t => [t.id, t]));
const hits = JSON.parse(readFileSync(hitsPath, 'utf8'));

let pass = 0, fail = 0, skipped = 0;
const advSeen = new Set();
for (const h of hits) {
  if (h.fy !== 0 || h.draws !== 1 || h.fx % 16 !== 0) { skipped++; continue; }
  const t = byId.get(h.id);
  const pgm = readPgm(`${root}/targets/${t.id}.pgm`);
  const tb = inkBbox(pgm.px, pgm.w, pgm.h);
  const g = get(`g_${t.cp}_${h.fx / 16}_0`);
  const [gh, gw] = g.shape.length === 2 ? g.shape : [0, 0];
  advSeen.add(advArr[[...meta.chars].indexOf(String.fromCodePoint(t.cp))]);
  let ok = tb && gw === tb.x1 - tb.x0 + 1 && gh === tb.y1 - tb.y0 + 1;
  if (ok) for (let r = 0; r < pgm.h && ok; r++) for (let c = 0; c < pgm.w && ok; c++) {
    const rr = r - tb.y0, cc = c - tb.x0;
    const v = rr >= 0 && rr < gh && cc >= 0 && cc < gw ? g.data[rr * gw + cc] : 255;
    if (v !== pgm.px[r * pgm.w + c]) ok = false;
  }
  if (ok) pass++;
  else { fail++; if (fail <= 10) console.log(`  FAIL ${t.id} '${t.ch}' phase ${h.fx}/64`); }
}
console.log(`${npzPath.replace(/^.*[\\/]/, '')}: ${pass}/${pass + fail} hit targets byte-EXACT` +
  (skipped ? ` (${skipped} non-¼-lattice hits skipped)` : '') +
  `; advances seen: ${[...advSeen].join(', ')}`);
process.exit(fail ? 1 : 0);

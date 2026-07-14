// inspect-raster.mjs <raster-cache/<key>/page-NNNN.gray.gz> — first-look page diagnosis:
// dims + mode (2 = color source), gray histogram (palette? fractional grays?),
// ink bands + pitch (bands present but nothing pins = wrong font size).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const buf = gunzipSync(readFileSync(process.argv[2]));
// GRY1 record: uint32 magic, mode, w, h; mode1 = uint8 gray, mode2 = uint16 sum(3x)
const magic = buf.readUInt32LE(0), mode = buf.readUInt32LE(4);
const w = buf.readUInt32LE(8), h = buf.readUInt32LE(12), off = 16;
if (magic !== 0x31595247) { console.log('bad magic'); process.exit(1); }
console.log(`dims ${w}x${h} mode ${mode}`);
if (mode === 0) { console.log('empty page'); process.exit(0); }
const px = new Float64Array(w * h);
for (let i = 0; i < w * h; i++)
  px[i] = mode === 1 ? buf[off + i] : buf.readUInt16LE(off + 2 * i) / 3;
const hist = new Map();
for (const v of px) { const k = Math.round(v * 10) / 10; hist.set(k, (hist.get(k) || 0) + 1); }
const levels = [...hist.entries()].sort((a, b) => b[1] - a[1]);
console.log('distinct grays:', hist.size);
console.log('top levels:', levels.slice(0, 12).map(([v, c]) => `${v}:${c}`).join(' '));
// row ink profile -> band pitch
const rows = [];
for (let y = 0; y < h; y++) {
  let ink = 0;
  for (let x = 0; x < w; x++) if (px[y * w + x] < 250) ink++;
  rows.push(ink);
}
const bands = [];
let s = -1;
for (let y = 0; y < h; y++) {
  if (rows[y] > 0 && s < 0) s = y;
  if (rows[y] === 0 && s >= 0) { bands.push([s, y - 1]); s = -1; }
}
if (s >= 0) bands.push([s, h - 1]);
console.log(`ink bands: ${bands.length}`);
for (const [a, b] of bands.slice(0, 25)) console.log(`  y ${a}-${b} (h=${b - a + 1})`);
const starts = bands.map(b => b[0]);
const pitches = starts.slice(1).map((v, i) => v - starts[i]);
console.log('pitches:', pitches.slice(0, 20).join(','));

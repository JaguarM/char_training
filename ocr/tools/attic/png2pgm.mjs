// png2pgm.mjs — minimal PNG (8-bit gray or RGB/RGBA, non-interlaced) to P5 PGM.
//   node tools/attic/png2pgm.mjs in.png out.pgm
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const [inp, outp] = process.argv.slice(2);
const b = readFileSync(inp);
if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
const idat = [];
while (pos < b.length) {
  const len = b.readUInt32BE(pos), type = b.toString('latin1', pos + 4, pos + 8);
  const data = b.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') {
    w = data.readUInt32BE(0); h = data.readUInt32BE(4);
    bitDepth = data[8]; colorType = data[9];
    if (bitDepth !== 8 || data[12] !== 0) throw new Error(`unsupported: depth ${bitDepth} interlace ${data[12]}`);
  } else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  pos += 12 + len;
}
const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
if (!bpp) throw new Error(`unsupported colorType ${colorType}`);
const raw = inflateSync(Buffer.concat(idat));
const stride = w * bpp;
const out = new Uint8Array(w * h);
const prev = new Uint8Array(stride);
const cur = new Uint8Array(stride);
let rp = 0;
for (let y = 0; y < h; y++) {
  const filter = raw[rp++];
  for (let i = 0; i < stride; i++) {
    const x = raw[rp++];
    const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    switch (filter) {
      case 0: v = x; break;
      case 1: v = x + a; break;
      case 2: v = x + up; break;
      case 3: v = x + ((a + up) >> 1); break;
      case 4: {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
        break;
      }
      default: throw new Error('bad filter ' + filter);
    }
    cur[i] = v & 255;
  }
  for (let i = 0; i < w; i++) out[y * w + i] = bpp === 1 ? cur[i] : bpp === 2 ? cur[i * 2] : cur[i * bpp]; // gray or R (gray images: R=G=B)
  prev.set(cur);
}
writeFileSync(outp, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, 'latin1'), Buffer.from(out)]));
console.log(`wrote ${outp} ${w}x${h} (colorType ${colorType})`);

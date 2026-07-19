// gen-white.mjs — materialize the READER's view of each page (GRY1 mode-3
// whitening, byte-identical to blind-read readGray) as pages/<doc>/white-000N.pgm.
// Harvesters MUST cut from these near colored zones: the pgm ingest keeps
// colored/jittered pixels the reader whitens (FEDERAL-line lesson,
// FINDINGS-calibri.md).
//   node tools/gen-white.mjs EFTA00038617 EFTA01649149
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const repo = `${root}/..`;

for (const doc of process.argv.slice(2)) {
  const pdf = readFileSync(`${repo}/NEW/calibri/${doc}.pdf`);
  const key = createHash('sha256').update(pdf).digest('hex').slice(0, 16);
  const dir = `${repo}/tools/raster-cache/${key}`;
  for (const f of readdirSync(dir)) {
    const mm = /^page-(\d+)\.gray\.gz$/.exec(f);
    if (!mm) continue;
    const raw = gunzipSync(readFileSync(`${dir}/${f}`));
    const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
    const mode = hdr[1], w = hdr[2], h = hdr[3];
    if (mode !== 3) throw new Error(`${doc} ${f}: mode ${mode}, expected 3`);
    const sums = new Uint16Array(raw.buffer, raw.byteOffset + 16, w * h);
    const spread = new Uint8Array(raw.buffer, raw.byteOffset + 16 + 2 * w * h, w * h);
    const gray = new Uint8Array(w * h);
    const colored = new Uint8Array(w * h);
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      gray[i] = sums[i] >= 765 ? 255 : Math.round(sums[i] / 3);
      if (spread[i] >= 4) { colored[i] = 1; stack.push(i); }
    }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!colored[j] && sums[j] < 765 && spread[j] >= 1) { colored[j] = 1; stack.push(j); }
        }
    }
    for (let i = 0; i < w * h; i++) if (colored[i]) gray[i] = 255;
    const out = `${root}/pages/${doc}/white-${mm[1]}.pgm`;
    writeFileSync(out, Buffer.concat([Buffer.from(`P5 ${w} ${h} 255 `, 'latin1'), Buffer.from(gray)]));
    console.log(out);
  }
}

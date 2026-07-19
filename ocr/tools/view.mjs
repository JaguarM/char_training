// view.mjs — print a PGM as ASCII art and/or numeric bytes.
//
//   node tools/view.mjs targets/101_p0_v1.pgm            # art
//   node tools/view.mjs targets/101_p0_v1.pgm --num      # numeric bytes
//   node tools/view.mjs pages/page-0001.pgm --crop 40,100,60,20   # x,y,w,h
import { readFileSync } from 'node:fs';

export function readPgm(path) {
  const b = readFileSync(path);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
  if (!m) throw new Error('not a P5 PGM: ' + path);
  const w = +m[1], h = +m[2];
  return { w, h, px: b.subarray(m[0].length, m[0].length + w * h) };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const file = process.argv[2];
  const num = process.argv.includes('--num');
  const ci = process.argv.indexOf('--crop');
  let { w, h, px } = readPgm(file);
  let x0 = 0, y0 = 0, cw = w, chh = h;
  if (ci > 0) [x0, y0, cw, chh] = process.argv[ci + 1].split(',').map(Number);
  for (let r = y0; r < Math.min(h, y0 + chh); r++) {
    let line = '';
    for (let c = x0; c < Math.min(w, x0 + cw); c++) {
      const v = px[r * w + c];
      line += num ? String(v).padStart(4)
        : v === 255 ? '.' : v < 64 ? '#' : v < 160 ? '+' : '-';
    }
    console.log(String(r).padStart(4), line);
  }
}

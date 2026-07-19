// repeat-check.mjs — determinism probe: locate many instances of common
// glyphs on P1 using ftclone+midlaw candidates (SAD-tolerant match), group
// by (glyph, phase), and byte-compare the PAGE rasters across instances.
// Byte-identical repeats => producer deterministic => harvested templates
// give a byte-exact reader.
import { readFileSync } from 'node:fs';
import { FTClone } from '../ftclone.mjs';

const PAGE = 'pages/EFTA00038617/page-0001.pgm';
const FONT = 'fonts/cand/calibri-jondot.ttf';
const b = readFileSync(PAGE);
const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
const pw = +m[1], ph = +m[2], px = b.subarray(m[0].length);

const W = 26, H = 32, PENX = 8, BASEY = 22;
const clone = new FTClone(FONT, W, H);
const covLaw = cov => {
  const t = 255 - cov;
  return Math.max(0, Math.min(255, t + (t >> 7) - ((255 - t) >> 7)));
};
function inkBbox(p, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (p[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// candidates: letters with curves/slants, all 4 phases, trimmed to ink bbox
const LETTERS = 'eoswx';
const cands = [];
for (const ch of LETTERS) {
  for (const fx of [0, 16, 32, 48]) {
    const cov = clone.coverage(ch.codePointAt(0), 1024, 1024, PENX * 64 + fx, BASEY * 64);
    if (!cov) continue;
    const full = new Uint8Array(W * H);
    for (let i = 0; i < full.length; i++) full[i] = covLaw(cov[i]);
    const bb = inkBbox(full, W, H);
    const cw = bb.x1 - bb.x0 + 1, chh = bb.y1 - bb.y0 + 1;
    const t = new Uint8Array(cw * chh);
    for (let r = 0; r < chh; r++) for (let c = 0; c < cw; c++) t[r * cw + c] = full[(bb.y0 + r) * W + bb.x0 + c];
    cands.push({ ch, fx, w: cw, h: chh, t });
  }
}

// scan text band rows 190-560: at each position where page has dark ink,
// try candidates anchored by their ink bbox; accept SAD <= 45
const found = new Map(); // ch|fx -> array of {x,y,bytes}
const seen = new Set();
for (let y = 190; y < 560; y++) {
  for (let x = 60; x < pw - 30; x++) {
    if (px[y * pw + x] > 100) continue;
    for (const cd of cands) {
      // anchor: try aligning candidate's darkest-first pixel at (x,y)? simpler:
      // try all offsets so that (x,y) is within candidate bbox top rows
      for (let oy = 0; oy < 3; oy++) for (let ox = 0; ox < 3; ox++) {
        const X = x - ox, Y = y - oy;
        if (X < 1 || Y < 1 || X + cd.w >= pw - 1 || Y + cd.h >= ph - 1) continue;
        const key = `${cd.ch}|${cd.fx}|${X}|${Y}`;
        if (seen.has(key)) continue;
        let sad = 0, ok = true;
        for (let r = 0; r < cd.h && ok; r++) for (let c = 0; c < cd.w; c++) {
          sad += Math.abs(px[(Y + r) * pw + X + c] - cd.t[r * cd.w + c]);
          if (sad > 45) { ok = false; break; }
        }
        if (!ok) continue;
        // margins white-ish on page (no neighbor contamination)
        for (let r = -1; r <= cd.h && ok; r++) {
          if (px[(Y + r) * pw + X - 1] < 200 || px[(Y + r) * pw + X + cd.w] < 200) ok = false;
        }
        if (!ok) continue;
        seen.add(key);
        const bytes = Buffer.alloc(cd.w * cd.h);
        for (let r = 0; r < cd.h; r++) for (let c = 0; c < cd.w; c++) bytes[r * cd.w + c] = px[(Y + r) * pw + X + c];
        const k = `${cd.ch}|${cd.fx}`;
        if (!found.has(k)) found.set(k, []);
        found.get(k).push({ x: X, y: Y, bytes, sad });
      }
    }
  }
}
for (const [k, arr] of [...found.entries()].sort()) {
  // compare all instances byte-wise
  const groups = new Map();
  for (const inst of arr) {
    const sig = inst.bytes.toString('latin1');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(inst);
  }
  const parts = [...groups.values()].map(g => g.length).sort((a, b2) => b2 - a);
  console.log(`${k}: ${arr.length} instances -> ${groups.size} distinct rasters [${parts.join(',')}]  sads ${arr.map(i => i.sad).join(',')}`);
}

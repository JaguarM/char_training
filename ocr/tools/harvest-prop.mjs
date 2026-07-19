// harvest-prop.mjs — PROPORTIONAL harvester (FINDINGS-calibri.md step 1).
// harvest.mjs cuts cells on a fitted monospace lattice and is useless on a
// proportional face; this tool instead LOCATES glyphs with ftclone+midlaw
// candidates and harvests the PAGE bytes as the template for (char, ¼-px
// x-phase). Cross-instance byte agreement is the certification (determinism
// proven by repeat-check.mjs: 1 raster per glyph×phase).
//
//   node tools/harvest-prop.mjs --docs EFTA00038617,EFTA01649149 \
//        --out calibri102mid_1024.npz --report harvest-calibri.json
//
// Locator physics (all pixel-derived, see FINDINGS-calibri.md):
//   candidate  = ftclone(calibri-1.02, em64 1024, fx∈{0,16,32,48}, fy 0)
//                coverage through the mid law
//                b = clamp(t + (t>>7) − ((255−t)>>7)), t = 255−cov
//   placement  = candidate's darkest pixel aligned on every page pixel <160
//                (dark bytes are stable under the ±1 curve residual)
//   accept     = per-pixel |page−cand| ≤ 4 over the whole bbox window
//                (residuals are ±1 coverage quanta; contamination is ≫)
//                + SAD ≤ max(45, 0.5·ink) + white (≥200) window perimeter
//   NMS        = overlapping accepts ranked by ink − SAD: enough lead for
//                ':' to beat the '.' hiding in its lower dot, while among
//                phase variants of one glyph (near-equal ink, all within
//                ±4/px on a small raster) the true phase's minimal residual
//                wins — ink-first ranking let one comma phase claim every
//                comma on the page and every slot came out disputed
//   slot cert  = determinism is PER (doc, page): every instance inside one
//                page must be byte-identical (measured 2026-07-19: the two
//                docs share one Word layout — same pen positions — but each
//                page renders with its own ±1-quanta curve state, the same
//                open residual FINDINGS logged against the P1 anchors).
//                Within-page majority is the page representative; the slot
//                template is the per-pixel MEDIAN over page reps, which sits
//                within ±1 of every page's true raster — the engine's tol
//                ladder (jpeg-jitter precedent) absorbs the rest. maxSpread
//                in the report = worst per-pixel disagreement across pages.
//
// Output: fontgen-layout .npz (meta/adv/g_*/o_*) the engine loads directly
// (blind-read --glyphs <path>.npz). Harvested slots carry PAGE bytes;
// unharvested slots carry the ftclone+midlaw synthetic (byte-exact for
// straight-edge glyphs, ±1 on curves — logged in the report).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import * as mupdf from 'mupdf';
import { FTClone } from './ftclone.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', `${root}/fonts/cand/calibri-jondot.ttf`);
const EM64 = +optS('em64', '1024');
const DOCS = optS('docs', 'EFTA00038617,EFTA01649149').split(',');
const OUT = optS('out', `${root}/calibri102mid_1024.npz`);
const REPORT = optS('report', null);
// --c <byte>: ink color of the run. 0 (default) = black through the proven
// mid law; >0 = srcover of gray C onto white (byte = 255 − round(cov·(255−C)/255)).
// The observed gray law has ±1 quirks and a −2 dip near full coverage (page
// bytes 22/24 for C≈23, FINDINGS) — candidates absorb that inside the
// per-pixel |Δ|≤4 gate, and harvested slots take the page's own bytes anyway.
const C = +optS('c', '0');
const SIZE_PX = EM64 / 64;

// printable ASCII + corpus punctuation — fontgen's DEFAULT_CHARS
const CHARS = optS('chars', (() => {
  let s = '';
  for (let c = 33; c < 127; c++) s += String.fromCharCode(c);
  return s + '‘’“”–—…•§¶©ﬁﬂ'
    + 'àâäçèéêëìîïòôöùûüÿñæœÀÂÄÇÈÉÊËÌÎÏÒÔÖÙÛÜŸÑÆŒáíóúýÁÍÓÚÝßãõÃÕ°±²³€£¥';
})());

const covLaw = C === 0
  ? cov => {
      const t = 255 - cov;
      return Math.max(0, Math.min(255, t + (t >> 7) - ((255 - t) >> 7)));
    }
  : cov => 255 - Math.round(cov * (255 - C) / 255);
// seed = page pixels dark enough to be a glyph's darkest pixel for this color
const SEED = C === 0 ? 160 : Math.min(240, C + 20);

// ---- candidates: ftclone+midlaw rasters, fontgen window geometry ----------
const PENX = Math.ceil(SIZE_PX) + 3, BASEY = Math.ceil(SIZE_PX * 1.6) + 3;
const W = PENX + Math.ceil(SIZE_PX * 2.4), H = BASEY + Math.ceil(SIZE_PX * 0.9);
const clone = new FTClone(FONT, W, H);
const mfont = new mupdf.Font('F', readFileSync(FONT));
const upm = clone.upm;

const cands = [];                      // {ch, cp, fx, w, h, dx, dy, syn, order, dr, dc, dv, nInk}
const advances = [];
for (const ch of CHARS) {
  const cp = ch.codePointAt(0);
  const gid = mfont.encodeCharacter(cp);
  advances.push(gid ? Math.round(mfont.advanceGlyph(gid, 0) * upm) * SIZE_PX / upm : 0);
  if (!gid) continue;
  for (const fx of [0, 16, 32, 48]) {
    const cov = clone.coverage(cp, EM64, EM64, PENX * 64 + fx, BASEY * 64);
    if (!cov) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    const full = new Uint8Array(W * H);
    for (let i = 0; i < full.length; i++) {
      full[i] = covLaw(cov[i]);
      if (full[i] < 255) {
        const c = i % W, r = (i / W) | 0;
        if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r;
      }
    }
    if (x1 < 0) continue;
    if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1)
      throw new Error(`'${ch}' fx${fx} touches the render window — enlarge W/H`);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const syn = new Uint8Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) syn[r * w + c] = full[(y0 + r) * W + x0 + c];
    // darkest pixel = placement anchor; compare order = darkest-first (early exit)
    let di = 0;
    for (let i = 1; i < syn.length; i++) if (syn[i] < syn[di]) di = i;
    const order = Int32Array.from(syn.keys()).sort((a, b) => syn[a] - syn[b]);
    let nInk = 0;
    for (const v of syn) if (v < 255) nInk++;
    cands.push({ ch, cp, fx, w, h, dx: x0 - PENX, dy: y0 - BASEY, syn, order,
      dr: (di / w) | 0, dc: di % w, dv: syn[di], nInk });
  }
  clone.cache.clear();
}
console.log(`${cands.length} candidates (${CHARS.length} chars x ≤4 phases), window ${W}x${H}, pen (${PENX},${BASEY})`);

// ---- scan every page of every doc -----------------------------------------
const readPgm = p => {
  const b = readFileSync(p);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(b.toString('latin1', 0, 40));
  return { w: +m[1], h: +m[2], px: b.subarray(m[0].length) };
};
// candidates by darkest byte, so a seed only tries plausible ones
const byDark = Array.from({ length: 256 }, () => []);
cands.forEach((cd, i) => byDark[cd.dv].push(i));

const accepts = [];                    // {cand, doc, pageNo, X, Y, sad, bytes}
let trials = 0;
for (const doc of DOCS) {
  const pageFiles = readdirSync(`${root}/pages/${doc}`).filter(f => /^page-\d+\.pgm$/.test(f)).sort();
  for (const pf of pageFiles) {
    const { w: pw, h: ph, px } = readPgm(`${root}/pages/${doc}/${pf}`);
    const pageAcc = [];
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1; x < pw - 1; x++) {
        const v = px[y * pw + x];
        if (v >= SEED) continue;
        const lo = Math.max(0, v - 6), hi = Math.min(255, v + 6);
        for (let dvv = lo; dvv <= hi; dvv++) {
          const list = byDark[dvv];
          for (let li = 0; li < list.length; li++) {
            const cd = cands[list[li]];
            const X = x - cd.dc, Y = y - cd.dr;
            if (X < 1 || Y < 1 || X + cd.w > pw - 1 || Y + cd.h > ph - 1) continue;
            trials++;
            // darkest-first window compare: per-pixel |Δ| ≤ 4, SAD-capped
            const cap = Math.max(45, cd.nInk >> 1);
            let sad = 0, ok = true;
            const { syn, order, w: cw, h: chh } = cd;
            for (let k = 0; k < order.length; k++) {
              const o = order[k];
              const d = px[(Y + ((o / cw) | 0)) * pw + X + (o % cw)] - syn[o];
              const ad = d < 0 ? -d : d;
              if (ad > 4 || (sad += ad) > cap) { ok = false; break; }
            }
            if (!ok) continue;
            // white perimeter (no neighbour contamination)
            for (let r = -1; r <= chh && ok; r++) {
              if (px[(Y + r) * pw + X - 1] < 200 || px[(Y + r) * pw + X + cw] < 200) ok = false;
            }
            for (let c = -1; c <= cw && ok; c++) {
              if (px[(Y - 1) * pw + X + c] < 200 || px[(Y + chh) * pw + X + c] < 200) ok = false;
            }
            if (!ok) continue;
            const bytes = Buffer.alloc(cw * chh);
            for (let r = 0; r < chh; r++)
              for (let c = 0; c < cw; c++) bytes[r * cw + c] = px[(Y + r) * pw + X + c];
            pageAcc.push({ cand: cd, doc, page: pf, X, Y, sad, bytes });
          }
        }
      }
    }
    // NMS: rank by ink − SAD (see header); drop accepts overlapping a kept
    // one by ≥70% in both axes (the '.' inside ':', phase-shifted doubles)
    pageAcc.sort((a, b) => (b.cand.nInk - b.sad) - (a.cand.nInk - a.sad) || a.sad - b.sad);
    const kept = [];
    for (const a of pageAcc) {
      let dead = false;
      for (const k of kept) {
        const ox = Math.min(a.X + a.cand.w, k.X + k.cand.w) - Math.max(a.X, k.X);
        const oy = Math.min(a.Y + a.cand.h, k.Y + k.cand.h) - Math.max(a.Y, k.Y);
        if (ox >= 0.7 * Math.min(a.cand.w, k.cand.w) &&
            oy >= 0.7 * Math.min(a.cand.h, k.cand.h)) { dead = true; break; }
      }
      if (!dead) kept.push(a);
    }
    accepts.push(...kept);
    process.stderr.write(`\r  ${doc}/${pf}: ${kept.length} instances (${accepts.length} total)   `);
  }
}
process.stderr.write('\n');
console.log(`${accepts.length} instances from ${trials} placements`);

// ---- per-slot certification: byte-identical instance groups ---------------
const slots = new Map();               // "cp|fx" -> accepts[]
for (const a of accepts) {
  const k = `${a.cand.cp}|${a.cand.fx}`;
  if (!slots.has(k)) slots.set(k, []);
  slots.get(k).push(a);
}
const chosen = new Map();              // "cp|fx" -> {bytes, n, weak}
const report = [];
for (const [k, arr] of slots) {
  const cd = arr[0].cand;
  // page representative = within-page modal raster (determinism per page:
  // a clear majority certifies; a tie or weak mode is contamination we
  // cannot arbitrate — that page is dropped from the consensus)
  const byPage = new Map();
  for (const a of arr) {
    const pk = `${a.doc}|${a.page}`;
    if (!byPage.has(pk)) byPage.set(pk, []);
    byPage.get(pk).push(a);
  }
  const reps = [], pages = [];
  let dropped = 0;
  for (const [pk, list] of byPage) {
    const groups = new Map();
    for (const a of list) {
      const sig = a.bytes.toString('latin1');
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(a);
    }
    const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
    const ok = groups.size === 1 ||
      (ranked[0].length >= 2 && ranked[0].length > ranked[1].length);
    if (!ok) { dropped++; continue; }
    reps.push(ranked[0][0].bytes);
    pages.push({ pk: pk.replace(/^.*(....)\|page-00(..)\.pgm$/, '$1/$2'),
      n: list.length, distinct: groups.size, sad: ranked[0][0].sad });
  }
  const rec = { ch: cd.ch, cp: cd.cp, fx: cd.fx, n: arr.length,
    pages, droppedPages: dropped };
  if (reps.length) {
    // consensus: per-pixel median over page reps; maxSpread = worst
    // cross-page disagreement (the tol the reader needs on this slot)
    const cons = Buffer.alloc(reps[0].length);
    let maxSpread = 0;
    const vals = new Uint8Array(reps.length);
    for (let i = 0; i < cons.length; i++) {
      for (let j = 0; j < reps.length; j++) vals[j] = reps[j][i];
      vals.sort();
      cons[i] = vals[reps.length >> 1];
      const sp = vals[reps.length - 1] - vals[0];
      if (sp > maxSpread) maxSpread = sp;
    }
    const weak = arr.length < 2;
    chosen.set(k, { bytes: cons, n: arr.length, weak });
    rec.maxSpread = maxSpread;
    rec.take = weak ? 'harvest-weak' : 'harvest';
  } else {
    rec.take = 'ALL-PAGES-DROPPED->synthetic';
  }
  report.push(rec);
}
report.sort((a, b) => a.cp - b.cp || a.fx - b.fx);
const nHarv = [...chosen.values()].filter(c => !c.weak).length;
const nWeak = [...chosen.values()].filter(c => c.weak).length;
const spreads = report.filter(r => r.maxSpread !== undefined).map(r => r.maxSpread);
console.log(`slots: ${chosen.size} harvested (${nHarv} multi-instance, ${nWeak} single), ` +
  `${report.filter(r => r.take.startsWith('ALL')).length} dropped, ` +
  `${cands.length - report.length} never seen -> synthetic; ` +
  `cross-page spread 0/1/2/>2: ${[0, 1, 2].map(s => spreads.filter(v => v === s).length).join('/')}` +
  `/${spreads.filter(v => v > 2).length}`);

// ---- npz writer (fontgen layout) ------------------------------------------
function npy(descr, shape, data) {
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let hdr = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  hdr += ' '.repeat((64 - (10 + hdr.length + 1) % 64) % 64) + '\n';
  const out = Buffer.alloc(10 + hdr.length + data.length);
  out.write('\x93NUMPY', 0, 'latin1'); out[6] = 1; out[7] = 0;
  out.writeUInt16LE(hdr.length, 8);
  out.write(hdr, 10, 'latin1');
  data.copy(out, 10 + hdr.length);
  return out;
}
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = b => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function writeZip(path, entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data] of entries) {
    const comp = deflateRawSync(data, { level: 9 });
    const nameB = Buffer.from(name, 'latin1');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, nameB]));
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, eocd]));
}

const byKey = new Map(cands.map(cd => [`${cd.cp}|${cd.fx}`, cd]));
const meta = {
  fontfile: FONT.replace(/\\/g, '/'), size_px: SIZE_PX, chars: CHARS,
  phases_x: [0, 0.25, 0.5, 0.75], phases_y: [0],
  pipeline: `harvested page-byte templates (${DOCS.join('+')}) + ftclone midlaw synthetic fallback, em64 ${EM64} fy0 (ocr/FINDINGS-calibri.md)`,
};
const advBuf = Buffer.alloc(advances.length * 8);
advances.forEach((a, i) => advBuf.writeDoubleLE(a, i * 8));
const entries = [
  ['meta.npy', npy('|u1', [Buffer.byteLength(JSON.stringify(meta))], Buffer.from(JSON.stringify(meta)))],
  ['adv.npy', npy('<f8', [advances.length], advBuf)],
];
let nSyn = 0;
for (const ch of CHARS) {
  const cp = ch.codePointAt(0);
  for (const fx of [0, 16, 32, 48]) {
    const key = `${cp}_${fx / 16}_0`;
    const cd = byKey.get(`${cp}|${fx}`);
    const pick = chosen.get(`${cp}|${fx}`);
    let w = 0, h = 0, dx = 0, dy = 0, raster = Buffer.alloc(0);
    if (cd) {
      ({ w, h, dx, dy } = cd);
      raster = pick ? Buffer.from(pick.bytes) : (nSyn++, Buffer.from(cd.syn));
    }
    entries.push([`g_${key}.npy`, npy('|u1', [h, w], raster)]);
    const o = Buffer.alloc(4);
    o.writeInt16LE(dx, 0); o.writeInt16LE(dy, 2);
    entries.push([`o_${key}.npy`, npy('<i2', [2], o)]);
  }
}
writeZip(OUT, entries);
console.log(`${OUT}: ${chosen.size} harvested + ${nSyn} synthetic slots, em64 ${EM64}`);
if (REPORT) { writeFileSync(REPORT, JSON.stringify({ meta: { docs: DOCS, font: FONT, em64: EM64 }, slots: report }, null, 1)); console.log(`wrote ${REPORT}`); }

// blind-read.mjs — self-calibrating byte-exact reader: NO layout constants.
// Where the main reader assumes the corpus grid (rows 40+18·r, baseline +11,
// startX 45, measureText spacing), this one measures everything from the page:
//
//   1. ink bands       : maximal runs of inked rows, split on blank rows;
//   2. baseline pin    : per band, try candidate baselines (integer AND ½-px
//                        y-phase) and keep the one whose leftmost glyphs
//                        byte-match;
//   3. left→right scan : at the leftmost unexplained ink column, try every
//                        (glyph, ¼-px x-phase) whose first ink column lands
//                        there; predicted = blend(explained-canvas, coverage)
//                        via the proven law dst=(dst·(256−e))>>8, e=cov+(cov>>7);
//                        byte-exact on the glyph's ink (pixels the NEXT glyph
//                        may darken are held pending and settled when it is
//                        blended in). Accept the candidate explaining the most
//                        ink; pens come out on the ¼-px lattice for free;
//   4. spaces          : measured pen gaps vs advances — space width is
//                        self-calibrated from the gap histogram, narrow styled
//                        spaces become measurements instead of model errors;
//   5. --verify        : re-render every line through real MuPDF at the
//                        recovered pens and byte-compare the whole band — a
//                        per-line 100% certificate (render_hypotheses.py).
//
// Multiple glyph sets may be given; the reader auto-picks per band (font
// detection). Sets come from ../ocr/tools/export_glyphs.py (fontgen rasters —
// zero corpus pixels).
//
//   node blind-read.mjs --pdf ../corpus/v3.pdf --page 2 --verify
//   node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt
//   node blind-read.mjs --raster <page.gray.gz> --glyphs glyphs_times16.json,glyphs_arial16.json
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ---------------- args ----------------
const o = { pdf: null, raster: null, page: 1, all: false, truth: null, out: null,
  json: null, glyphs: ['glyphs_times16.json'], verify: false, tol: 0,
  worker: 'C:/Users/yanni/Desktop/ocr/tools/render_hypotheses.py' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--raster') o.raster = resolve(process.cwd(), next());
  else if (a === '--page') o.page = parseInt(next(), 10);
  else if (a === '--all') o.all = true;
  else if (a === '--truth') o.truth = resolve(process.cwd(), next());
  else if (a === '--out') o.out = resolve(process.cwd(), next());
  else if (a === '--json') o.json = resolve(process.cwd(), next());
  else if (a === '--tol') o.tol = parseInt(next(), 10);
  else if (a === '--glyphs') o.glyphs = next().split(',');
  else if (a === '--verify') o.verify = true;
  else if (a === '--union') o.union = true;
  else if (a === '--worker') o.worker = next();
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}

// ---------------- raster access ----------------
function readGray(path) {
  const raw = gunzipSync(readFileSync(path));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  if (hdr[0] !== 0x31595247) throw new Error(`bad GRY1 magic: ${path}`);
  const mode = hdr[1], w = hdr[2], h = hdr[3];
  if (mode === 0) return null;
  if (mode === 1) return { w, h, gray: new Uint8Array(raw.buffer, raw.byteOffset + 16, w * h) };
  if (mode !== 2) throw new Error(`mode ${mode} unsupported`);
  // mode 2: u16 R+G+B sums (color page). Achromatic ink (R=G=B — plain black
  // text) has sum ≡ 0 (mod 3) at every pixel, so gray = sum/3 is exact there;
  // colored ink (hyperlink blue) is non-neutral at least on its AA edges.
  // Whiten every ink component connected to a non-neutral pixel — the reader
  // then sees only the plain text, byte-exactly.
  const sums = new Uint16Array(raw.buffer, raw.byteOffset + 16, w * h);
  const gray = new Uint8Array(w * h);
  const colored = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    gray[i] = sums[i] >= 765 ? 255 : (sums[i] / 3) | 0;
    if (sums[i] < 765 && sums[i] % 3) { colored[i] = 1; stack.push(i); }
  }
  while (stack.length) {                               // flood over connected ink
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (!colored[j] && sums[j] < 765) { colored[j] = 1; stack.push(j); }
      }
  }
  let removed = 0;
  for (let i = 0; i < w * h; i++) if (colored[i]) { gray[i] = 255; removed++; }
  if (removed) console.error(`  (color page: ${removed} colored-ink px removed)`);
  return { w, h, gray };
}
function cachePages(pdfPath) {
  const key = createHash('sha256').update(readFileSync(pdfPath)).digest('hex').slice(0, 16);
  const dir = join(REPO, 'bench', 'raster-cache', key);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  return { numPages: meta.numPages,
    page: pno => readGray(join(dir, `page-${String(pno).padStart(4, '0')}.gray.gz`)) };
}

// ---------------- glyph sets ----------------
// per (ch, phx, phy): raster bytes + dx/dy + ink pixel list + first-ink column
function loadSet(file) {
  const j = JSON.parse(readFileSync(resolve(__dirname, file), 'utf8'));
  const byPhy = new Map();                       // phy -> [{ch, adv, phx, w,h,dx,dy,bytes,ink,inkLeft}]
  let maxAsc = 0, maxDesc = 0;
  for (const [ch, rec] of Object.entries(j.chars)) {
    for (const [key, r] of Object.entries(rec.ph)) {
      if (!r.w) continue;
      const [phxS, phyS = '0'] = key.split('_');
      const phx = parseFloat(phxS), phy = parseFloat(phyS);
      const bytes = Buffer.from(r.b64, 'base64');
      const ink = [];
      let inkLeft = r.w;
      for (let c = 0; c < r.w; c++)
        for (let rr = 0; rr < r.h; rr++)
          if (bytes[rr * r.w + c] < 255) { ink.push(rr * r.w + c); if (c < inkLeft) inkLeft = c; }
      if (!byPhy.has(phy)) byPhy.set(phy, []);
      byPhy.get(phy).push({ ch, adv: rec.adv, phx, w: r.w, h: r.h, dx: r.dx, dy: r.dy,
        bytes, ink, inkLeft });
      maxAsc = Math.max(maxAsc, -r.dy);
      maxDesc = Math.max(maxDesc, r.dy + r.h);
    }
  }
  const stem = (j.font ?? '').replace(/_\d+.*$/, '');   // "times_16.npz" -> "times"
  return { name: basename(file).replace(/^glyphs_|\.json$/g, ''), sizePx: j.size_px,
    linear: !!j.linear,                                 // report.pdf producer blend
    fontFile: `C:/Windows/Fonts/${stem || 'times'}.ttf`, byPhy, maxAsc, maxDesc };
}

// --union: one merged candidate pool over all sets, so a single line may mix
// fonts (bold "From:" label + regular value). Per-glyph `lin` keeps each
// candidate on its own compositor law. Byte-exact matching keeps cross-font
// false hits out; per-band font detection (and --verify) don't apply.
function unionSets(sets) {
  const byPhy = new Map();
  let maxAsc = 0, maxDesc = 0;
  for (const s of sets) {
    maxAsc = Math.max(maxAsc, s.maxAsc); maxDesc = Math.max(maxDesc, s.maxDesc);
    for (const [phy, arr] of s.byPhy) {
      if (!byPhy.has(phy)) byPhy.set(phy, []);
      for (const g of arr) byPhy.get(phy).push({ ...g, lin: s.linear });
    }
  }
  return { name: sets.map(s => s.name).join('+'), sizePx: sets[0].sizePx,
    linear: sets.some(s => s.linear), fontFile: sets[0].fontFile, byPhy, maxAsc, maxDesc };
}

// blend-law tables: single-glyph gray g on white -> possible e = cov + (cov>>7)
const INV = (() => {
  const inv = Array.from({ length: 256 }, () => []);
  for (let cov = 0; cov <= 255; cov++) {
    const e = cov + (cov >> 7);
    if (!inv[(255 * (256 - e)) >> 8].includes(e)) inv[(255 * (256 - e)) >> 8].push(e);
  }
  return inv;
})();

// report.pdf producer (linear glyph sets): glyph raw alpha bytes composite
// multiplicatively in 255-space with floor — raw' = floor(raw_canvas * rb /
// 255) — and the PAGE byte adds +1 per contributing "light" glyph (raster
// byte 129..254; its raw byte is rb = gb - 1). The scanner keeps the page-
// space canvas plus a per-pixel shift count so the raw canvas is recoverable.
// Fitted with 0/499 mismatches on every double-overlap pixel of the clean
// report.pdf lines (ocr REPORT_RENDERER_HUNT, 2026-07-11); singles reduce to
// the proven g -> g+1 (g in 128..254) byte map.

// ---------------- non-text objects (rules, redaction boxes) ----------------
// Long near-solid horizontal ink runs cannot be glyphs. Thin groups (≤4 rows)
// are rules/underlines, tall groups are boxes. Their pixels (padded for AA
// edges) become a page-level don't-care mask: banding ignores them, the
// scanner neither fails on them nor hallucinates glyphs inside them, and the
// verify certificate excludes them. Underlined text therefore reads normally,
// with the underline reported as a separate object.
function detectObjects(page) {
  const { w, h, gray } = page;
  const rows = [];                                      // per-row long dark runs
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let s = -1, gap = 0;
    for (let x = 0; x <= w; x++) {
      const dark = x < w && gray[off + x] < 160;
      if (dark) { if (s < 0) s = x; gap = 0; }
      else if (s >= 0 && ++gap > 1) {
        if (x - gap + 1 - s >= 40) rows.push({ y, x0: s, x1: x - gap + 1 });
        s = -1; gap = 0;
      }
    }
  }
  const objects = [];
  for (const r of rows) {
    const o = objects.find(o => o.y1 === r.y &&
      Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.8 * Math.min(o.x1 - o.x0, r.x1 - r.x0));
    if (o) { o.y1 = r.y + 1; o.x0 = Math.min(o.x0, r.x0); o.x1 = Math.max(o.x1, r.x1); }
    else objects.push({ y0: r.y, y1: r.y + 1, x0: r.x0, x1: r.x1 });
  }
  // vertical rules (table/quote borders): long solid runs down a column
  const vcols = [];
  for (let x = 0; x < w; x++) {
    let s = -1, gap = 0;
    for (let y = 0; y <= h; y++) {
      const dark = y < h && gray[y * w + x] < 160;
      if (dark) { if (s < 0) s = y; gap = 0; }
      else if (s >= 0 && ++gap > 1) {
        if (y - gap + 1 - s >= 40) vcols.push({ x, y0: s, y1: y - gap + 1 });
        s = -1; gap = 0;
      }
    }
  }
  for (const c of vcols) {
    const o = objects.find(o => o.vr && o.x1 === c.x &&
      Math.min(o.y1, c.y1) - Math.max(o.y0, c.y0) > 0.8 * Math.min(o.y1 - o.y0, c.y1 - c.y0));
    if (o) { o.x1 = c.x + 1; o.y0 = Math.min(o.y0, c.y0); o.y1 = Math.max(o.y1, c.y1); }
    else objects.push({ vr: true, x0: c.x, x1: c.x + 1, y0: c.y0, y1: c.y1 });
  }
  // Box-extent correction. Stacked redactions of different widths merge into
  // one bbox above, and a glyph bridged into a row's run across a ≤1px AA gap
  // stretches a row a few px past the box — either way the padded mask
  // swallows real letters beside a box. Split each box into row segments of
  // near-constant raw extent, absorb short burst segments between agreeing
  // neighbours (a real box edge persists for many rows; a bridge lasts a few),
  // and take each segment's edge as the MODE of its rows — bridged rows shift
  // an edge for a minority of rows and lose the vote, while real AA wobble
  // stays within the ±2 mask padding.
  const segmented = [];
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.vr || o.y1 - o.y0 <= 4) continue;
    const ext = [];                                    // per-row [y, x0, x1]
    for (const r of rows)
      if (r.y >= o.y0 && r.y < o.y1 && r.x1 > o.x0 && r.x0 < o.x1) {
        const e = ext.length && ext[ext.length - 1][0] === r.y ? ext[ext.length - 1] : null;
        if (e) { e[1] = Math.min(e[1], r.x0); e[2] = Math.max(e[2], r.x1); }
        else ext.push([r.y, r.x0, r.x1]);
      }
    if (!ext.length) continue;
    const mode = (seg, k) => {                         // most frequent edge value
      const n = new Map();
      for (const e of seg.exts) n.set(e[k], (n.get(e[k]) ?? 0) + 1);
      let best = null;
      for (const [v, c] of n) if (!best || c > best[1]) best = [v, c];
      return best[0];
    };
    const segs = [];
    for (const [y, x0, x1] of ext) {
      const s = segs[segs.length - 1];
      if (s && y === s.y1 && Math.abs(x0 - s.last[0]) <= 2 && Math.abs(x1 - s.last[1]) <= 2) {
        s.y1 = y + 1; s.last = [x0, x1]; s.exts.push([x0, x1]);
      } else segs.push({ y0: y, y1: y + 1, last: [x0, x1], exts: [[x0, x1]] });
    }
    for (let m = 1; m < segs.length - 1; ) {           // absorb bridge bursts
      const [a, b, c] = [segs[m - 1], segs[m], segs[m + 1]];
      if (b.y1 - b.y0 < 5 &&
          Math.abs(mode(a, 0) - mode(c, 0)) <= 2 && Math.abs(mode(a, 1) - mode(c, 1)) <= 2) {
        a.y1 = c.y1; a.exts.push(...c.exts); a.last = c.last;
        segs.splice(m, 2);
        m = Math.max(1, m - 1);
      } else m++;
    }
    for (const s of segs)
      segmented.push({ y0: s.y0, y1: s.y1, x0: mode(s, 0), x1: mode(s, 1) });
    objects.splice(i, 1);
  }
  objects.push(...segmented);
  // a glyph descender touching a box top merges with the box's own dark column
  // into one long vertical run — drop vrule candidates that live inside boxes
  // (summing coverage over box segments: a stacked pair covers a rule jointly)
  const boxes = objects.filter(o => !o.vr && o.y1 - o.y0 > 4);
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (!o.vr) continue;
    let cov = 0;
    for (const b of boxes)
      if (o.x0 >= b.x0 - 2 && o.x1 <= b.x1 + 2)
        cov += Math.max(0, Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0));
    if (cov > 0.6 * (o.y1 - o.y0)) objects.splice(i, 1);
  }
  const mask = new Uint8Array(w * h);
  for (const o of objects) {
    o.type = o.vr ? 'vrule' : o.y1 - o.y0 <= 4 ? 'rule' : 'box';
    delete o.vr;
    for (let y = Math.max(0, o.y0 - 2); y < Math.min(h, o.y1 + 2); y++)
      for (let x = Math.max(0, o.x0 - 2); x < Math.min(w, o.x1 + 2); x++)
        mask[y * w + x] = 1;
  }
  return { mask, objects };
}

// ---------------- band + baseline detection ----------------
function findBands(page, mask) {
  const inked = new Uint8Array(page.h);
  for (let y = 0; y < page.h; y++) {
    const off = y * page.w;
    for (let x = 0; x < page.w; x++)
      if (page.gray[off + x] < 255 && !(mask && mask[off + x])) { inked[y] = 1; break; }
  }
  const bands = [];
  let start = -1;
  for (let y = 0; y <= page.h; y++) {
    const on = y < page.h && inked[y];
    if (on && start < 0) start = y;
    if (!on && start >= 0) { bands.push([start, y]); start = -1; }
  }
  return bands;
}

// try to read the first few glyphs of a band at a candidate (baseline, set, phy);
// returns matched-ink score. maxFails bounds the work on wrong hypotheses —
// without it a bad baseline absorbs the whole band column by column.
function probeBaseline(page, mask, set, phy, baseline, x0, x1) {
  const line = scanLine(page, mask, set, phy, baseline, x0, Math.min(x1, x0 + 160), 4, 2);
  return line.glyphs.reduce((s, g) => s + g.exact, 0) - line.fails.length * 20;
}

// ---------------- the scanner ----------------
// Reads one band left→right. Returns {glyphs:[{ch,pen,exact,pending}], fails:[col,...]}.
// maxGlyphs: stop early (baseline probing).
function scanLine(page, mask, set, phy, baseline, xFrom, xTo, maxGlyphs = Infinity, maxFails = Infinity) {
  const W = page.w, cands = set.byPhy.get(phy) ?? [], lin = set.linear;
  // explained-ink canvas over the band window (white = nothing explained yet;
  // don't-care object pixels are pre-absorbed so the scan flows through them)
  const y0 = Math.max(0, baseline - set.maxAsc), y1 = Math.min(page.h, baseline + set.maxDesc);
  const bw = xTo - xFrom, bh = y1 - y0;
  const canvas = new Uint8Array(bw * bh).fill(255);
  const shifts = lin ? new Uint8Array(bw * bh) : null;   // producer +1 count per pixel
  const pageAt = (x, y) => page.gray[y * W + x];
  const masked = (x, y) => mask && mask[y * W + x];
  const canAt = (x, y) => canvas[(y - y0) * bw + (x - xFrom)];
  const setCan = (x, y, v) => { canvas[(y - y0) * bw + (x - xFrom)] = v; };
  const shAt = (x, y) => (lin ? shifts[(y - y0) * bw + (x - xFrom)] : 0);
  const addSh = (x, y, s) => { if (lin) shifts[(y - y0) * bw + (x - xFrom)] += s; };
  if (mask)
    for (let y = y0; y < y1; y++)
      for (let x = xFrom; x < xTo; x++)
        if (mask[y * W + x]) setCan(x, y, pageAt(x, y));

  // --tol N relaxes byte-exactness to |Δ|≤N per glyph-ink pixel — for pages
  // from a NEAR-identical rasterizer (e.g. an older FreeType whose curve
  // corner coverage differs by a few gray levels). 0 = byte-exact (default).
  // The unexplained-ink scan stays STRICT: accepted glyphs absorb the page's
  // exact bytes, so any |page−canvas| > 0 is truly unexplained — skipping
  // within-tol pixels here would let faint leading AA columns slip past and
  // misplace the next glyph's anchor.
  const TOL = o.tol;
  const nextUnexplained = (fromX) => {
    for (let x = fromX; x < xTo; x++)
      for (let y = y0; y < y1; y++)
        if (pageAt(x, y) !== canAt(x, y)) return x;
    return -1;
  };

  const glyphs = [], fails = [];
  const accepted = new Set();                          // "ch@pen" — never re-accept
  let cursor = xFrom;
  while (glyphs.length < maxGlyphs) {
    const col = nextUnexplained(cursor);
    if (col < 0) break;
    // candidates whose first ink column lands on col (or col-1/-2: composite
    // columns can hide the true left edge when bytes saturate)
    let best = null;
    for (let back = 0; back <= 2; back++) {
      for (const g of cands) {
        const pi = col - back - g.dx - g.inkLeft;      // integer pen such that first ink col = col-back
        const gx = pi + g.dx, gy = baseline + g.dy;
        if (gx < xFrom || gx + g.w > xTo || gy < y0 || gy + g.h > y1) continue;
        if (accepted.has(`${g.ch}@${pi + g.phx}`)) continue;
        let exact = 0, pending = 0, skipped = 0, ok = true;
        for (const p of g.ink) {
          const rr = (p / g.w) | 0, cc = p % g.w;
          const x = gx + cc, y = gy + rr;
          if (masked(x, y)) { skipped++; continue; }   // object pixel: no evidence either way
          const gb = g.bytes[p], pv = pageAt(x, y), cv = canAt(x, y);
          // tol mode: a neighbour may have absorbed this pixel's composite
          // already (within-tol steal); a FAINT own-contribution proves
          // nothing either way — skip instead of predicting double ink
          if (TOL && cv !== 255 && gb >= 255 - 2 * TOL) { skipped++; continue; }
          // predicted values for this pixel over the e-ambiguity; composite
          // pixels (canvas already inked) get double tolerance — rasterizer
          // deviations of BOTH overlapping curves compound (f-hook ∩ i-dot)
          const t = cv !== 255 ? 2 * TOL : TOL;
          let hit = false, minPred = 256;
          if (g.lin ?? lin) {
            const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = shAt(x, y);
            minPred = (((cv - s0) * (gb - sh)) / 255 | 0) + s0 + sh;
            // composite pixels may read 1 lighter than the law: the producer's
            // junction arithmetic is 1-ambiguous there (3/925 fitted pairs,
            // always this sign) — single-glyph pixels stay byte-strict
            hit = Math.abs(minPred - pv) <= t || (cv !== 255 && minPred - pv === 1);
          } else {
            for (const e of INV[gb]) {
              const pred = (cv * (256 - e)) >> 8;
              if (pred < minPred) minPred = pred;
              if (Math.abs(pred - pv) <= t) { hit = true; break; }
            }
          }
          if (process.env.BR_PIX && +process.env.BR_PIX === col && !hit)
            console.log(`      pix '${g.ch}' pen ${pi + g.phx} @(${x},${y}) gb=${gb} cv=${cv} pv=${pv} minPred=${minPred}`);
          if (hit) exact++;
          else if (pv < minPred - t) pending++;        // darker: future glyph may composite
          else { ok = false; break; }
        }
        // pending is for kern overlap (a few columns) — a glyph "hiding" inside
        // solid ink shows up as mostly-pending and must not be accepted; a glyph
        // mostly inside an object mask has no evidence and is rejected too
        const considered = g.ink.length - skipped;
        if (!ok || considered < g.ink.length * 0.5 ||
            exact < considered * 0.5 || pending > considered * 0.35) continue;
        // must explain the anchor column itself
        if (col < gx || col >= gx + g.w) continue;
        const score = exact - pending * 0.25;
        if (!best || score > best.score) best = { g, pi, gx, gy, exact, pending, score };
      }
      if (best) break;
    }
    if (!best) {
      // rasterizer-variance dust: an older rasterizer may spread a curve a
      // pixel wider than our raster, and at glyph junctions (f-hook ∩ i-dot)
      // the deviations of both curves compound beyond any per-pixel tolerance.
      // A residue of ≤3 unexplained pixels, each either faint or adjacent to
      // already-explained ink, is absorbed silently; anything larger/isolated
      // and dark is real unexplained ink and stays a □ failure.
      if (TOL) {
        const px = [];
        for (let x = col; x < Math.min(col + 3, xTo); x++)
          for (let y = y0; y < y1; y++)
            if (pageAt(x, y) !== canAt(x, y)) px.push([x, y]);
        const okDust = px.length <= 3 && px.every(([x, y]) => {
          if (pageAt(x, y) >= 255 - 6 * TOL && Math.abs(pageAt(x, y) - canAt(x, y)) <= 6 * TOL) return true;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx >= xFrom && nx < xTo && ny >= y0 && ny < y1 &&
                  canAt(nx, ny) < 255 && pageAt(nx, ny) === canAt(nx, ny)) return true;
            }
          return false;
        });
        if (okDust) {
          for (const [x, y] of px) setCan(x, y, pageAt(x, y));
          cursor = col;
          continue;
        }
      }
      // give up on this ink cluster: absorb its columns up to the next white
      // gap, emit one □, and bail out entirely once the fail budget is spent
      if (process.env.BR_DEBUG && maxGlyphs === Infinity) {
        console.log(`    fail @col ${col} baseline ${baseline}`);
        for (let y = y0; y < y1; y++)
          if (pageAt(col, y) !== canAt(col, y))
            console.log(`      unexplained (${col},${y}) page=${pageAt(col, y)} canvas=${canAt(col, y)}`);
      }
      if (!fails.length || col > fails[fails.length - 1] + 4) fails.push(col);
      let x = col;
      for (; x < xTo; x++) {
        let anyInk = false;
        for (let y = y0; y < y1; y++) {
          // object pixels are don't-care: without this a fail beside a
          // redaction box absorbs every word sharing columns with the box
          if (pageAt(x, y) < 255 && !masked(x, y)) anyInk = true;
          setCan(x, y, pageAt(x, y));
        }
        if (!anyInk && x > col) break;
      }
      cursor = x;
      if (fails.length >= maxFails) break;
      continue;
    }
    // blend the accepted glyph into the canvas: exact pixels take the page
    // value; pending pixels take the glyph-over-canvas prediction so the next
    // glyph composites against it
    const { g, pi, gx, gy } = best;
    for (const p of g.ink) {
      const rr = (p / g.w) | 0, cc = p % g.w;
      const x = gx + cc, y = gy + rr;
      if (masked(x, y)) continue;                      // keep page bytes under objects
      const gb = g.bytes[p], pv = pageAt(x, y), cv = canAt(x, y);
      if (TOL && cv !== 255 && gb >= 255 - 2 * TOL) continue;  // faint skip (see above)
      let val = null;
      if (g.lin ?? lin) {
        const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = shAt(x, y);
        const pred = (((cv - s0) * (gb - sh)) / 255 | 0) + s0 + sh;
        const ok = Math.abs(pred - pv) <= (cv !== 255 ? 2 * TOL : TOL) ||
                   (cv !== 255 && pred - pv === 1);   // composite 1-lighter case
        val = ok ? pv : pred;
        addSh(x, y, sh);
      } else {
        for (const e of INV[gb]) {
          const pred = (cv * (256 - e)) >> 8;
          if (Math.abs(pred - pv) <= (cv !== 255 ? 2 * TOL : TOL)) { val = pv; break; }  // absorb page value
          if (val === null) val = pred;
        }
      }
      setCan(x, y, val);
    }
    if (process.env.BR_LINE && +process.env.BR_LINE === baseline && maxGlyphs === Infinity)
      console.log(`    accept '${g.ch}' pen ${pi + g.phx} exact ${best.exact} pend ${best.pending} (anchor ${col})`);
    glyphs.push({ ch: g.ch, pen: pi + g.phx, adv: g.adv, exact: best.exact, pending: best.pending });
    accepted.add(`${g.ch}@${pi + g.phx}`);
    cursor = col + 1;   // pending overlap columns right of col are revisited; the
  }                     // accepted-set guard prevents re-accepting the same glyph
  return { glyphs, fails };
}

// ---------------- spaces from measured gaps ----------------
function spaceCalib(lines) {
  // gaps between consecutive glyphs, minus advance: cluster the positive ones
  const gaps = [];
  for (const L of lines)
    for (let i = 1; i < L.glyphs.length; i++)
      gaps.push(L.glyphs[i].pen - L.glyphs[i - 1].pen - L.glyphs[i - 1].adv);
  const pos = gaps.filter(g => g > 1.2 && g < 12).sort((a, b) => a - b);
  if (!pos.length) return null;
  // smallest dense cluster = one space
  let best = null;
  for (let i = 0; i < pos.length; i++) {
    const c = pos.filter(g => Math.abs(g - pos[i]) < 0.6);
    if (c.length >= Math.max(3, pos.length * 0.05)) { best = c.reduce((s, x) => s + x, 0) / c.length; break; }
  }
  return best;
}
function withSpaces(L, spaceAdv) {
  let out = '', flags = 0;
  const boxes = L.boxes ?? [];
  for (let i = 0; i < L.glyphs.length; i++) {
    if (i) {
      const a = L.glyphs[i - 1].pen + L.glyphs[i - 1].adv, b = L.glyphs[i].pen;
      const gap = b - a;
      if (boxes.some(([b0, b1]) => b0 >= a - 2 && b1 <= b + 2)) {
        out += ' ';                                         // gap spans a non-text box:
      } else if (spaceAdv && gap > 0.55 * spaceAdv) {       // measured spaces meaningless
        const n = Math.max(1, Math.round(gap / spaceAdv));
        out += ' '.repeat(n);
        if (Math.abs(gap - n * spaceAdv) > 0.75) flags++;   // narrow/odd space
      }
    }
    const ch = L.glyphs[i].ch;
    out += ch === 'ﬁ' ? 'fi' : ch === 'ﬂ' ? 'fl' : ch;  // ligatures transcribe as letters
  }
  return { text: out, oddGaps: flags };
}

// ---------------- MuPDF verify worker ----------------
function startWorker(py) {
  const proc = spawn('python', [py], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: proc.stdout }).on('line', l => {
    if (!l.trim()) return;
    const r = JSON.parse(l);
    const p = pending.get(r.id);
    if (p) { pending.delete(r.id); p(Buffer.from(r.b64, 'base64')); }
  });
  return {
    render(glyphs, baseline, y0, y1, font) {
      const id = nextId++;
      return new Promise(res => { pending.set(id, res);
        proc.stdin.write(JSON.stringify({ id, glyphs, baseline, y0, y1, font }) + '\n'); });
    },
    close() { try { proc.stdin.write('{"cmd":"quit"}\n'); } catch {} try { proc.kill(); } catch {} },
  };
}

// ---------------- per-page driver ----------------
async function readPage(page, sets, worker) {
  const { mask, objects } = detectObjects(page);
  const bands = findBands(page, mask);
  const lines = [];
  for (const [top, bot] of bands) {
    // leftmost/rightmost non-object ink of the band
    let x0 = page.w, x1 = 0;
    for (let y = top; y < bot; y++) {
      const off = y * page.w;
      for (let x = 0; x < page.w; x++)
        if (page.gray[off + x] < 255 && !mask[off + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    // objects sharing rows with this band (reported per line; space gaps
    // spanning them are suppressed)
    const lineObjects = objects.filter(ob => ob.y0 < bot + 4 && ob.y1 > top - 4);
    // pin (set, phy, baseline): try candidates, keep best probe score
    // baseline = last ink row + 1 on descender-free lines, up to maxDesc higher
    // otherwise — try the whole range (and every set × y-phase)
    let pick = null;
    for (const set of sets)
      for (const phy of set.byPhy.keys())
        for (let yb = bot; yb >= bot - set.maxDesc && yb > top; yb--) {
          const score = probeBaseline(page, mask, set, phy, yb, Math.max(0, x0 - 2), Math.min(page.w, x1 + 20));
          if (score > 0 && (!pick || score > pick.score)) pick = { set, phy, yb, score };
        }
    if (!pick) { lines.push({ top, bot, glyphs: [], fails: [x0], set: null, boxes: [] }); continue; }
    const L = scanLine(page, mask, pick.set, pick.phy, pick.yb,
      Math.max(0, x0 - 2), Math.min(page.w, x1 + 4));
    L.top = top; L.bot = bot; L.baseline = pick.yb; L.set = pick.set; L.phy = pick.phy;
    L.boxes = lineObjects.map(ob => [ob.x0 - 2, ob.x1 + 2]);
    L.objects = lineObjects;
    // strike-through: a rule crossing the line's x-height voids the struck
    // span — text under the bar is deliberately not transcribed, so glyph
    // fragments and □s inside it are noise, not content (underlines sit
    // below the baseline and don't match)
    const strikes = lineObjects.filter(ob => ob.type === 'rule' &&
      ob.y0 >= pick.yb - 10 && ob.y1 <= pick.yb - 2);
    if (strikes.length) {
      L.glyphs = L.glyphs.filter(g => !strikes.some(sb => g.pen < sb.x1 + 2 && g.pen + g.adv > sb.x0 - 1));
      L.fails = L.fails.filter(c => !strikes.some(sb => c >= sb.x0 - 4 && c < sb.x1 + 4));
      L.struck = strikes.map(sb => [sb.x0, sb.x1]);
    }
    // verification certificate: byte-exact re-render of the whole band
    // (detected non-text boxes are reported objects, excluded from the compare)
    if (worker && L.glyphs.length && !L.fails.length) {
      const y0 = Math.max(0, pick.yb - pick.set.maxAsc), y1 = Math.min(page.h, pick.yb + pick.set.maxDesc);
      const band = await worker.render(L.glyphs.map(g => [g.ch, g.pen]),
        pick.yb + pick.phy, y0, y1, pick.set.fontFile);
      let ok = true;
      for (let y = y0; y < y1 && ok; y++)
        for (let x = 0; x < page.w; x++)
          if (band[(y - y0) * page.w + x] !== page.gray[y * page.w + x] && !mask[y * page.w + x]) { ok = false; break; }
      L.verified = ok;
    }
    lines.push(L);
  }
  return { lines, objects };
}

// ---------------- main ----------------
async function main() {
  let sets = o.glyphs.map(loadSet);
  if (o.union && sets.length > 1) sets = [unionSets(sets)];
  const worker = o.verify ? startWorker(o.worker) : null;
  const t0 = Date.now();
  try {
    let pages;                                        // [{pno, page}]
    if (o.raster) pages = [{ pno: 0, page: readGray(o.raster) }];
    else {
      if (!o.pdf) { console.error('need --pdf or --raster'); process.exit(1); }
      const cache = cachePages(o.pdf);
      const list = o.all ? Array.from({ length: cache.numPages }, (_, i) => i + 1) : [o.page];
      pages = list.map(pno => ({ pno, page: cache.page(pno) }));
    }
    const truth = o.truth ? readFileSync(o.truth, 'utf8').replace(/\r/g, '').split('\n') : null;

    let totLines = 0, totGlyphs = 0, totFails = 0, verified = 0, verTried = 0;
    let rowExact = 0, rowDiff = 0, spacedExact = 0;
    const diffs = [];
    const outLines = [];
    const jsonPages = [];
    for (const { pno, page } of pages) {
      if (!page) continue;
      const { lines, objects } = await readPage(page, sets, worker);
      const spaceAdv = spaceCalib(lines);
      const jsonLines = [];
      jsonPages.push({ pno, spaceAdv, objects, lines: jsonLines });
      for (const L of lines) {
        if (!L.set) { totFails++; outLines.push(''); jsonLines.push({ top: L.top, text: '', unread: true }); continue; }
        totLines++; totGlyphs += L.glyphs.length; totFails += L.fails.length;
        if (L.verified !== undefined) { verTried++; if (L.verified) verified++; }
        const sp = withSpaces(L, spaceAdv);
        outLines.push(sp.text);
        jsonLines.push({ baseline: L.baseline, phy: L.phy, font: L.set.name,
          text: sp.text, verified: L.verified ?? null, fails: L.fails.length,
          failCols: L.fails, boxes: L.boxes, oddGaps: sp.oddGaps,
          ...(L.struck ? { struck: L.struck } : {}),
          glyphs: L.glyphs.map(g => [g.ch, g.pen]) });
        if (truth) {
          // row index from baseline is unknown to the reader — compare against
          // the truth row whose letters match (letters-only first, then spaced)
          const letters = sp.text.replace(/ /g, '');
          const hit = truth.find(t => t.trim() && t.replace(/ /g, '') === letters);
          if (hit !== undefined) { rowExact++; if (hit.trimEnd() === sp.text.trimEnd()) spacedExact++; }
          else { rowDiff++; if (diffs.length < 12) diffs.push({ pno, base: L.baseline, got: sp.text.slice(0, 70) }); }
        }
      }
      process.stderr.write(`\r  page ${pno}: ${lines.length} bands`);
    }
    process.stderr.write('\n');
    console.log(`\n${totLines} lines, ${totGlyphs} glyphs, ${totFails} unreadable clusters (□), ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (verTried) console.log(`verify certificates: ${verified}/${verTried} lines byte-exact re-render`);
    if (truth) {
      console.log(`vs truth: ${rowExact} rows letter-exact (${spacedExact} also space-exact), ${rowDiff} rows differ`);
      for (const d of diffs) console.log(`  P${d.pno} y${d.base}: ${JSON.stringify(d.got)}`);
    }
    if (o.out) { writeFileSync(o.out, outLines.join('\n') + '\n'); console.log(`wrote ${o.out}`); }
    if (o.json) { writeFileSync(o.json, JSON.stringify({ pages: jsonPages }, null, 1)); console.log(`wrote ${o.json}`); }
  } finally { worker?.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });

// ocr-engine.js — shared, DOM-free matcher core for the byte-exact blind
// reader. THE single implementation of the scanning physics (ink bands,
// baseline/font pinning, the left→right composite-aware scan, non-text
// object detection, space calibration) — consumed by BOTH
// tools/blind-read.mjs (Node CLI bench/gate) and src/blindocr.js (the
// browser/Recto app engine) via the same UMD wrapper core.js uses. Before
// this file existed the two callers each carried their own copy of this
// code and every engine change had to be made twice; now it is made once,
// here, and both callers pick it up.
//
// Callers own everything platform-specific: raster/page acquisition (CLI:
// tools/blind-read.mjs readGray from GRY1 files; app: canvas ImageData +
// blindocr.js whitenColored), the glyph dictionary loader (CLI:
// tools/glyph-bundle.mjs Buffer reader; app: blindocr.js DataView reader),
// union-pool grouping policy, the escalating multi-pass ladder, and output
// shaping (CLI: plain text + truth diff; app: box-positioned entries for the
// UI). This file owns only the page -> {lines, objects} scan.
//
// In-app certificate: a line is CLEAN when the scan explained every
// non-object ink pixel of its band byte-exactly through the proven blend law
// (dst = (dst·(256−e))>>8, e = cov + (cov>>7)) — fails.length === 0 and
// residual === 0. (The bench's MuPDF re-render cross-check is the same
// composition law applied in reverse.)
(function (root) {
  'use strict';

  // TEMP instrumentation (assessment only — reverted after measuring)
  const PROF = { init: 0, next: 0, chain: 0, anchor: 0, blend: 0, fail: 0,
    calls: 0, probeCalls: 0, chainHit: 0, anchorHit: 0, groupWalk: 0, subWalk: 0, candWalk: 0, tryCalls: 0 };

  // --union pool: one merged candidate list over all sets, so a single line
  // may mix fonts (bold "From:" label + regular value). Per-glyph `lin` keeps
  // each candidate on its own compositor law; byte-exact matching keeps
  // cross-font false hits out. Per-band font detection doesn't apply.
  function unionSets(sets) {
    const byPhy = new Map();
    let maxAsc = 0, maxDesc = 0;
    for (const s of sets) {
      maxAsc = Math.max(maxAsc, s.maxAsc); maxDesc = Math.max(maxDesc, s.maxDesc);
      for (const [phy, arr] of s.byPhy) {
        if (!byPhy.has(phy)) byPhy.set(phy, []);
        for (const g of arr) byPhy.get(phy).push({ ...g, lin: s.linear, src: s.name });
      }
    }
    return { name: sets.map(s => s.name).join('+'), sizePx: sets[0].sizePx,
      linear: sets.some(s => s.linear), fontFile: sets[0].fontFile, byPhy, maxAsc, maxDesc };
  }

  // ---- palette quantization ----
  // Some producers palettize the final page (v4.pdf, email.pdf P1): the page
  // byte is the nearest AVAILABLE gray to the ideal render, ties toward
  // darker. The available set is read off the page itself (every actual page
  // byte is present by construction, palette grays are fixpoints). Scan
  // canvases stay in ORIGINAL space — the producer quantized once, at the end
  // — and every prediction-vs-page compare goes through this map.
  function quantMap(page) {
    const seen = new Uint8Array(256);
    for (const v of page.gray) seen[v] = 1;
    const avail = [];
    for (let v = 0; v < 256; v++) if (seen[v]) avail.push(v);
    const Q = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      let best = avail[0];
      for (const a of avail) {
        const d = Math.abs(a - v), bd = Math.abs(best - v);
        if (d < bd || (d === bd && a < best)) best = a;
      }
      Q[v] = best;
    }
    return Q;
  }

  // ---- non-text objects (rules, redaction boxes) ----
  // Long near-solid horizontal ink runs cannot be glyphs. Thin groups (≤4 rows)
  // are rules/underlines, tall groups are boxes. Their pixels (padded for AA
  // edges) become a page-level don't-care mask: banding ignores them, and the
  // scanner neither fails on them nor hallucinates glyphs inside them.
  function detectObjects(page) {
    const { w, h, gray } = page;
    // light rules (HTML blockquote quote bars, decorative separators): a long
    // strictly-contiguous run of NEAR-CONSTANT light gray (min ≥160 — darker is
    // the dark-run rule's job — and max−min ≤ 8) is a rule regardless of
    // darkness. Text can never fake it: blank inter-line rows/columns break
    // runs long before 40px (glyph stacks are ~15 rows) and glyph AA never
    // holds one value for 40px.
    const lightRuns = (n, m, at, out) => {              // scan m lines of length n
      for (let j = 0; j < m; j++) {
        let s = -1, mn = 0, mx = 0;
        const close = i => { if (s >= 0 && i - s >= 40) out(j, s, i); s = -1; };
        for (let i = 0; i <= n; i++) {
          const v = i < n ? at(j, i) : 255;
          if (v >= 255 || v < 160) { close(i); continue; }
          if (s >= 0 && Math.max(mx, v) - Math.min(mn, v) > 8) close(i);
          if (s < 0) { s = i; mn = mx = v; }
          else { mn = Math.min(mn, v); mx = Math.max(mx, v); }
        }
      }
    };
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
    lightRuns(w, h, (y, x) => gray[y * w + x], (y, s, e) => rows.push({ y, x0: s, x1: e }));
    rows.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const objects = [];
    for (const r of rows) {
      const o = objects.find(o => o.y1 === r.y &&
        Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.8 * Math.min(o.x1 - o.x0, r.x1 - r.x0));
      if (o) { o.y1 = r.y + 1; o.x0 = Math.min(o.x0, r.x0); o.x1 = Math.max(o.x1, r.x1); }
      else objects.push({ y0: r.y, y1: r.y + 1, x0: r.x0, x1: r.x1 });
    }
    // small solid boxes (inline redactions narrower than the 40px run rule):
    // a stack of ≥8 rows whose STRICTLY-contiguous dark runs share one x-extent
    // (±1) is a filled box — text can't fake it: letter interiors break the
    // contiguity, and no glyph stack holds one constant extent for 8 rows
    // (x-height spans ~7). Runs 10–39 px; ≥40 is the main rule's job.
    const shortRuns = [];
    for (let y = 0; y < h; y++) {
      const off = y * w;
      let s = -1;
      for (let x = 0; x <= w; x++) {
        const dark = x < w && gray[off + x] < 160;
        if (dark) { if (s < 0) s = x; }
        else if (s >= 0) {
          if (x - s >= 10 && x - s < 40) shortRuns.push({ y, x0: s, x1: x });
          s = -1;
        }
      }
    }
    const stacks = [];
    for (const r of shortRuns) {
      const g = stacks.find(g => g.y1 === r.y &&
        Math.abs(g.x0 - r.x0) <= 1 && Math.abs(g.x1 - r.x1) <= 1);
      if (g) g.y1 = r.y + 1;
      else stacks.push({ y0: r.y, y1: r.y + 1, x0: r.x0, x1: r.x1 });
    }
    for (const g of stacks)
      if (g.y1 - g.y0 >= 8) objects.push({ y0: g.y0, y1: g.y1, x0: g.x0, x1: g.x1 });
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
    lightRuns(h, w, (x, y) => gray[y * w + x], (x, s, e) => vcols.push({ x, y0: s, y1: e }));
    vcols.sort((a, b) => a.x - b.x || a.y0 - b.y0);
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
    // Mask = object extent, padded per SIDE only where the object itself put
    // ink there. Dark AA (<160) is already inside the detected extent; what can
    // lie just outside is the light AA line of a fractional edge — and that is
    // near-CONSTANT along the whole side (same coverage every row/column, glyph
    // ink never is). A side whose adjacent line is blank or carries varying
    // sparse ink gets NO padding: that ink is a glyph's evidence, not the
    // object's (a blanket ±2 pad swallowed real "," ":" "." ">" pressed against
    // redaction boxes — real, byte-clean text).
    const sideAA = (vals) => {
      const ink = vals.filter(v => v < 255);
      if (!ink.length || ink.length < 0.9 * vals.length) return false;
      ink.sort((a, b) => a - b);
      const mode = ink[ink.length >> 1];
      return ink.filter(v => Math.abs(v - mode) <= 3).length >= 0.6 * vals.length;
    };
    // BOXES get the same adaptive treatment in Y (text pressed above a black
    // letterhead banner is the comma-problem rotated 90°). RULES/VRULES keep
    // the blanket ±2 in Y: underlines live UNDER text and their over/under
    // rows are a legitimate glyph∩rule composite zone (link rows regressed
    // when rules went adaptive).
    const mask = new Uint8Array(w * h);
    for (const o of objects) {
      o.type = o.vr ? 'vrule' : o.y1 - o.y0 <= 4 ? 'rule' : 'box';
      delete o.vr;
      const col = x => { const v = []; for (let y = o.y0; y < o.y1; y++) v.push(gray[y * w + x]); return v; };
      const row = y => { const v = []; for (let x = o.x0; x < o.x1; x++) v.push(gray[y * w + x]); return v; };
      const x0 = o.x0 > 0 && sideAA(col(o.x0 - 1)) ? o.x0 - 1 : o.x0;
      const x1 = o.x1 < w && sideAA(col(o.x1)) ? o.x1 + 1 : o.x1;
      const y0 = o.type === 'box' ? (o.y0 > 0 && sideAA(row(o.y0 - 1)) ? o.y0 - 1 : o.y0)
        : Math.max(0, o.y0 - 2);
      const y1 = o.type === 'box' ? (o.y1 < h && sideAA(row(o.y1)) ? o.y1 + 1 : o.y1)
        : Math.min(h, o.y1 + 2);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          mask[y * w + x] = 1;
    }
    return { mask, objects };
  }

  // ---- ink bands ----
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

  // ---------------- anchor-column candidate index ----------------
  // Candidates grouped ("sorted") by the ink-row bit pattern of their FIRST
  // ink column, as a 64-bit mask over the band window's rows (bit =
  // dy+row+maxAsc). The scanner anchors every candidate with its first ink
  // column on the probe column, and a candidate is provably dead when the
  // page is white at a pixel it predicts as ink (fresh pred < 255: white page
  // rejects). So one AND per GROUP replaces the per-candidate pixel walk for
  // every group that needs ink where the page has none. Near-white
  // predictions (pred > 254−2·TOL) prove nothing from a white page and stay
  // out of the mask. Tie-break on the original candidate order (_i) keeps
  // acceptance independent of group iteration order.
  function anchorGroups(set, phy, quant, TOL) {
    const cands = set.byPhy.get(phy) ?? [];
    const ASC = set.maxAsc, span = ASC + set.maxDesc;
    if (span > 64) return null;                        // mask would overflow: plain path
    cands.forEach((g, i) => { g._i = i; });
    const colBits = (g, colRel) => {                   // required-ink row mask of one glyph column
      let m0 = 0, m1 = 0;
      for (let k = 0; k < g.inkC.length; k++) {
        if (g.inkC[k] !== g.inkLeft + colRel) continue;
        const pred = quant ? quant[g.inkB[k]] : g.inkB[k];   // fresh-canvas prediction (lin: pred = gb, shifts cancel)
        if (pred > 254 - 2 * TOL) continue;
        const bit = g.dy + g.inkR[k] + ASC;
        if (bit >= 0 && bit < span) { if (bit < 32) m0 |= 1 << bit; else m1 |= 1 << (bit - 32); }
      }
      return [m0, m1];
    };
    const groups = new Map();
    // chain index (advance chaining): the same per-candidate column masks,
    // bucketed by ¼-px x-phase and then by dx+inkLeft — at a KNOWN pen only
    // ¼ of the pool applies, and of those only the ≤3 dx+inkLeft buckets whose
    // first ink column can land on the anchor are ever walked (a fixed pen
    // puts each glyph's first ink column at pi + that offset).
    const byPhase = [[], [], [], []];
    for (const g of cands) {
      const [m0, m1] = colBits(g, 0), [n0, n1] = colBits(g, 1);
      let grp = groups.get(m0 + ',' + m1);
      if (!grp) groups.set(m0 + ',' + m1, grp = { m0, m1, subs: new Map() });
      let sub = grp.subs.get(n0 + ',' + n1);
      if (!sub) grp.subs.set(n0 + ',' + n1, sub = { n0, n1, members: [] });
      sub.members.push(g);
      byPhase[Math.round(g.phx * 4) & 3].push({ g, m0, m1, n0, n1, d: g.dx + g.inkLeft });
    }
    const chain = byPhase.map(arr => {
      if (!arr.length) return null;
      const dMin = Math.min(...arr.map(c => c.d)), dMax = Math.max(...arr.map(c => c.d));
      const buckets = Array.from({ length: dMax - dMin + 1 }, () => null);
      for (const c of arr) (buckets[c.d - dMin] ??= []).push(c);
      return { dMin, buckets };
    });
    const list = [...groups.values()];
    for (const grp of list) grp.subs = [...grp.subs.values()];
    return { groups: list, chain };
  }

  // chained-pen probes: the exact advance and its ¼-px snap neighbours. The
  // prediction error is bounded by the previous pen's snap (≤1/8 px) plus the
  // layout bias δ ∈ [0, 1/32 px] — under one quarter, so ±1 covers all of it
  // (all probes accumulate before judging; order does not matter)
  const CHAIN_PROBES = [0, -1, 1];

  // debug envs (Node/CLI only — inert in the browser, where `process` is
  // undefined): BR_DEBUG=1 (fail pixels), BR_LINE=<baseline> (accept trace),
  // BR_PIX=<col> (per-pixel rejection detail). BR_PIX also disables the
  // fresh-canvas fast path so per-pixel debug output stays complete.
  const HAS_ENV = typeof process !== 'undefined' && !!process.env;
  const DBG_PIX = HAS_ENV && !!process.env.BR_PIX;
  const DBG_LINE = HAS_ENV && process.env.BR_LINE ? +process.env.BR_LINE : null;
  const DBG_ON = HAS_ENV && !!process.env.BR_DEBUG;

  // ---------------- the scanner ----------------
  // Reads one band left→right. Returns {glyphs:[{ch,pen,exact,pending}],
  // fails:[col,...], frags:[col,...], residual, canvas, y0,y1,xFrom,xTo}.
  // maxGlyphs: stop early (baseline probing). TOL relaxes byte-exactness to
  // |Δ|≤TOL per glyph-ink pixel (2×TOL on composite pixels, where two curves'
  // rasterizer deviations compound) — for pages from a NEAR-identical
  // rasterizer (e.g. an older FreeType whose curve corner coverage differs by
  // a few gray levels). 0 = byte-exact (default). QUANT is a palette map (see
  // quantMap) or null. Linear sets (set.linear — the eDiscovery producer):
  // glyph raw alpha bytes composite multiplicatively in 255-space with floor,
  // and the PAGE byte adds +1 per contributing "light" pixel — light iff RAW
  // byte ∈ [128,254], which in linear-set bytes is gb ∈ [129,254] with raw =
  // gb−1. A per-pixel shift count keeps the raw canvas recoverable from page
  // space.
  function scanLine(page, mask, set, phy, baseline, xFrom, xTo, maxGlyphs = Infinity,
    maxFails = Infinity, TOL = 0, QUANT = null, halos = null, bandTop = null,
    explained = null, bandBot = null) {
    const _t0 = performance.now();
    PROF.calls++; if (maxGlyphs !== Infinity) PROF.probeCalls++;
    const inHalo = (x, y) => halos && halos.some(h => x >= h[0] && x < h[1] && y >= h[2] && y < h[3]);
    const q = QUANT ? v => QUANT[v] : v => v;           // palette law (see quantMap)
    const lin = set.linear;
    const W = page.w, cands = set.byPhy.get(phy) ?? [];
    // explained-ink canvas over the band window (white = nothing explained
    // yet; don't-care object pixels are pre-absorbed so the scan flows
    // through them)
    const y0 = Math.max(0, baseline - set.maxAsc), y1 = Math.min(page.h, baseline + set.maxDesc);
    const bw = xTo - xFrom, bh = y1 - y0;
    if (bw <= 0 || bh <= 0)
      return { glyphs: [], fails: [], frags: [], residual: 0, canvas: null, y0, y1, xFrom, xTo };
    const canvas = new Uint8Array(bw * bh).fill(255);
    const shifts = lin ? new Uint8Array(bw * bh) : null;   // producer +1 count per pixel
    // skip = window-local don't-care overlay: object mask pixels PLUS
    // absorbed-fail pixels (canvas=page alone poisons any LATER candidate
    // overlapping the blob — its pixels then compare against composite math —
    // so a word whose head fell into unexplainable residue could never read
    // from its intact tail). One combined array keeps the candidate hot loop
    // at a single load.
    const skip = new Uint8Array(bw * bh);
    const pageAt = (x, y) => page.gray[y * W + x];
    const masked = (x, y) => skip[(y - y0) * bw + (x - xFrom)];
    const canAt = (x, y) => canvas[(y - y0) * bw + (x - xFrom)];
    const shAt = (x, y) => (lin ? shifts[(y - y0) * bw + (x - xFrom)] : 0);
    const addSh = (x, y, s) => { if (lin) shifts[(y - y0) * bw + (x - xFrom)] += s; };
    // don't-care pre-absorb: object-mask pixels AND pixels another line's scan
    // already explained (a neighbouring line's descender/ascender ink inside
    // this window — at small line pitches adjacent lines' row ranges overlap,
    // so that ink is settled evidence of the OTHER line, not this one's)
    for (let y = y0; y < y1; y++)
      for (let x = xFrom; x < xTo; x++)
        if (mask[y * W + x] || (explained && explained[y * W + x])) {
          canvas[(y - y0) * bw + (x - xFrom)] = pageAt(x, y);
          skip[(y - y0) * bw + (x - xFrom)] = 1;
        }
    // per-column count of unexplained pixels (page ≠ q(canvas)), maintained on
    // every canvas write — nextUnexplained becomes an O(1)-amortized pointer
    // walk instead of rescanning the whole band window after every glyph
    // (the rescan was 80%+ of read time on dense pages). unexplained-ink
    // accounting starts at the BAND top, not the window top: the window
    // extends maxAsc above the baseline so tall candidates can be
    // shape-checked (their ink up there must be white on page), but ink ABOVE
    // the band belongs to the PREVIOUS line (its descenders) — accented
    // capitals grew maxAsc past the line pitch and the scan started failing
    // on the neighbours' ink. The window BOTTOM stays open: a '_'-only band
    // below is deliberately explained through (see readPage's explained map).
    const cTop = bandTop === null || bandTop === undefined ? y0 : Math.max(y0, bandTop);
    // cBot mirrors cTop for SPLIT bands (see readPage): ink at/below the split
    // boundary belongs to the NEXT segment's line — its scan judges it. The
    // bottom stays open (y1) for normal bands: a '_'-only band below is
    // deliberately read and explained through. Accepted glyphs still blend
    // and explain ink beyond cBot — only unexplained-ink JUDGING stops there.
    const cBot = bandBot === null || bandBot === undefined ? y1 : Math.min(y1, Math.max(bandBot, cTop));
    const unexpl = new Int32Array(bw);
    for (let x = xFrom; x < xTo; x++) {
      let n = 0;
      for (let y = cTop; y < cBot; y++)
        if (pageAt(x, y) !== q(canAt(x, y))) n++;
      unexpl[x - xFrom] = n;
    }
    PROF.init += performance.now() - _t0;
    const setCan = (x, y, v) => {
      const i = (y - y0) * bw + (x - xFrom);
      const pv = page.gray[y * W + x];
      const before = pv !== q(canvas[i]);
      canvas[i] = v;
      const after = pv !== q(v);
      if (y >= cTop && y < cBot && before !== after) unexpl[x - xFrom] += after ? 1 : -1;
    };
    const nextUnexplained = (fromX) => {
      for (let x = Math.max(fromX, xFrom); x < xTo; x++)
        if (unexpl[x - xFrom] > 0) return x;
      return -1;
    };

    // anchor-column group index (see anchorGroups above); cache per (set, phy) —
    // quant maps are per page, so the cache re-keys on the quant object.
    // BR_PIX disables the index entirely: every candidate gets tried at every
    // position (exhaustive, slow) so the per-pixel rejection trace is complete.
    let idx = null;
    if (!DBG_PIX) {
      let gc = set._grpCache;
      if (!gc || gc.quant !== QUANT || gc.tol !== TOL)
        gc = set._grpCache = { quant: QUANT, tol: TOL, byPhy: new Map() };
      idx = gc.byPhy.get(phy);
      if (idx === undefined) { idx = anchorGroups(set, phy, QUANT, TOL); gc.byPhy.set(phy, idx); }
    }
    const grpList = idx?.groups ??
      (cands.forEach((g, i) => { g._i = i; }),
        cands.length ? [{ m0: 0, m1: 0, subs: [{ n0: 0, n1: 0, members: cands }] }] : []);
    const chain = idx?.chain ?? null;      // per-phase index for advance chaining
    const ASC = set.maxAsc, baseTop = baseline - ASC;  // unclamped window top: mask bit = y - baseTop
    let pm0 = 0, pm1 = 0;                              // page-side mask of the last colMask(x)
    const colMask = (x) => {
      pm0 = 0; pm1 = 0;
      for (let y = y0; y < y1; y++)
        if (page.gray[y * W + x] < 255 || skip[(y - y0) * bw + (x - xFrom)]) {
          const bit = y - baseTop;
          if (bit < 32) pm0 |= 1 << bit; else if (bit < 64) pm1 |= 1 << (bit - 32);
        }
    };

    // one candidate trial: glyph g at integer pen pi must explain the page
    // bytes through the blend law, with the anchor column inside its bbox.
    // ONE implementation shared by the chained-pen probe and the anchor-column
    // scan, so acceptance physics can never diverge between the two paths.
    const tryCand = (g, pi, col) => {
      PROF.tryCalls++;
      const gx = pi + g.dx, gy = baseline + g.dy;
      if (gx < xFrom || gx + g.w > xTo || gy < y0 || gy + g.h > y1) return null;
      // must explain the anchor column itself (hoisted: cheap reject)
      if (col < gx || col >= gx + g.w) return null;
      let exact = 0, pending = 0, skipped = 0;
      const linG = g.lin ?? lin;
      const { inkC, inkR, inkB, inkA } = g, nInk = inkC.length;
      const rowBase = gy * W + gx, canBase = (gy - y0) * bw + (gx - xFrom);
      for (let k = 0; k < nInk; k++) {
        const cc = inkC[k], rr = inkR[k];
        const pOff = rowBase + rr * W + cc;
        if (skip[canBase + rr * bw + cc]) { skipped++; continue; }  // object/absorbed pixel: no evidence either way
        const gb = inkB[k], pv = page.gray[pOff], cv = canvas[canBase + rr * bw + cc];
        // fresh-canvas fast path (the overwhelmingly common case, non-linear
        // law): blending the glyph's alpha over white reproduces gb by
        // construction — pred === gb — so one compare suffices
        if (cv === 255 && !linG && !DBG_PIX) {
          const d = QUANT ? QUANT[gb] : gb;
          if (pv >= d - TOL && pv <= d + TOL) exact++;
          else if (pv < d - TOL) pending++;              // darker: future glyph may composite
          else return null;
          continue;
        }
        // tol mode: a neighbour may have absorbed this pixel's composite
        // already (within-tol steal); a FAINT own-contribution proves
        // nothing either way — skip instead of predicting double ink
        if (TOL && cv !== 255 && gb >= 255 - 2 * TOL) { skipped++; continue; }
        // ONE prediction from the stored true alpha (the old e-ambiguity loop
        // is gone: the lone byte collision, gb 0, predicts identically for
        // either coverage); composite pixels (canvas already inked) get double
        // tolerance — rasterizer deviations of BOTH overlapping curves
        // compound (f-hook ∩ i-dot)
        const t = cv !== 255 ? 2 * TOL : TOL;
        const a = inkA[k];
        let hit = false, minPred = 256;
        if (linG) {
          // linear law: a IS the producer's raw byte (= gb − sh)
          const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = lin ? shifts[canBase + rr * bw + cc] : 0;
          minPred = (((cv - s0) * a) / 255 | 0) + s0 + sh;
          // composite pixels may read 1 lighter than the law: the producer's
          // junction arithmetic is 1-ambiguous there (3/925 fitted pairs,
          // always this sign) — single-glyph pixels stay byte-strict
          hit = Math.abs(q(minPred) - pv) <= t || (cv !== 255 && q(minPred) - pv === 1);
        } else {
          const e = a + (a >> 7);
          minPred = (cv * (256 - e)) >> 8;
          hit = Math.abs(q(minPred) - pv) <= t;
        }
        if (DBG_PIX && HAS_ENV && +process.env.BR_PIX === col && !hit)
          console.log(`      pix '${g.ch}' pen ${pi + g.phx} @(${gx + cc},${gy + rr}) gb=${gb} cv=${cv} pv=${pv} minPred=${minPred}`);
        if (hit) exact++;
        else if (pv < q(minPred) - t) pending++;         // darker: future glyph may composite
        else return null;
      }
      // pending is for kern overlap (a few columns) — a glyph "hiding" inside
      // solid ink shows up as mostly-pending and must not be accepted; a glyph
      // mostly inside an object mask has no evidence and is rejected too
      const considered = nInk - skipped;
      if (considered < nInk * 0.5 ||
          exact < considered * 0.5 || pending > considered * 0.35) return null;
      if (accepted.has(`${g.ch}@${pi + g.phx}`)) return null;  // after the pixel work: rare
      return { g, pi, gx, gy, exact, pending, score: exact - pending * 0.25 };
    };

    const glyphs = [], fails = [], frags = [], records = [];
    let failGuard = -1;                     // right edge of the last failed blob
    const accepted = new Set();                          // "ch@pen" — never re-accept
    let cursor = xFrom;
    let chainPenQ = null;                   // expected next pen (¼-px units) after an accept
    const mk = new Int32Array(8);           // chain-probe column masks, cols col-2..col+1
    while (glyphs.length < maxGlyphs) {
      const _tn = performance.now();
      const col = nextUnexplained(cursor);
      PROF.next += performance.now() - _tn;
      if (col < 0) break;
      let best = null;
      // advance chaining: within a word the next pen is the previous pen +
      // advance snapped to the ¼-px lattice (proven physics: pens snap to ¼ px
      // and sit δ ∈ [0, 1/32 px] below ideal), so probe that pen, then ±1–2
      // ¼-px for snap boundaries, against the pen's phase bucket before paying
      // for the full anchor-column scan. A background run is a natural resync
      // point: a chained candidate whose first ink column misses the anchor
      // col simply doesn't apply (styled rows justify SPACES down to
      // 2.4–2.8 px — the space advance is never trusted). Anchor priority
      // col > col−1 > col−2 replicates the scan's back-loop order.
      if (chainPenQ !== null && chain) {
        const _tc = performance.now();
        for (let i = 0; i < 4; i++) {                    // page masks, cols col-2..col+1
          const x = col - 2 + i;
          if (x < xFrom || x >= xTo) { mk[2 * i] = -1; mk[2 * i + 1] = -1; }
          else { colMask(x); mk[2 * i] = pm0; mk[2 * i + 1] = pm1; }
        }
        // ALL five probe pens accumulate before judging — a subset glyph (','
        // is the bottom of ';') that byte-passes at one probed pen must still
        // lose the score comparison to the true glyph at a neighbouring probed
        // pen, exactly as it loses inside one anchor pass of the full scan
        const slot = [null, null, null];                 // best per anchor distance col−f
        for (const d of CHAIN_PROBES) {
          const penQ = chainPenQ + d;
          if (penQ < 0) continue;
          const ph = chain[penQ & 3];
          if (!ph) continue;
          const pi = penQ >> 2;
          // f = pi + (dx+inkLeft) must land on col-2..col: walk those buckets only
          for (let dd = Math.max(col - pi - 2, ph.dMin); dd <= col - pi; dd++) {
            const bucket = ph.buckets[dd - ph.dMin];
            if (!bucket) continue;
            const f = pi + dd;                           // first ink col at this pen
            if (f < xFrom) continue;
            const ai = 2 * (f - col + 2);
            const a0 = mk[ai], a1 = mk[ai + 1], b0 = mk[ai + 2], b1 = mk[ai + 3];
            const s = col - f;
            for (const c of bucket) {
              if ((c.m0 & ~a0) | (c.m1 & ~a1)) continue; // needs ink where page is white
              if ((c.n0 & ~b0) | (c.n1 & ~b1)) continue;
              const r = tryCand(c.g, pi, col);
              if (!r) continue;
              if (!slot[s] || r.score > slot[s].score ||
                  (r.score === slot[s].score && c.g._i < slot[s].g._i)) slot[s] = r;
            }
          }
        }
        best = slot[0] ?? slot[1] ?? slot[2];
        PROF.chain += performance.now() - _tc;
        if (best) PROF.chainHit++;
      }
      // candidates whose first ink column lands on col (or col-1/-2: composite
      // columns can hide the true left edge when bytes saturate)
      if (!best) {
      const _ta = performance.now();
      for (let back = 0; back <= 2; back++) {
        if (col - back < xFrom) break;                 // every candidate's bbox starts left of the window
        colMask(col - back);                           // page ink+skip rows at the anchor column
        const a0 = pm0, a1 = pm1;
        let b0 = -1, b1 = -1;                          // second column; all-ones when outside the window
        if (col - back + 1 < xTo) { colMask(col - back + 1); b0 = pm0; b1 = pm1; }
        for (const grp of grpList) {
        PROF.groupWalk++;
        if ((grp.m0 & ~a0) | (grp.m1 & ~a1)) continue;     // group needs ink where the page is white
        for (const sub of grp.subs) {
        PROF.subWalk++;
        if ((sub.n0 & ~b0) | (sub.n1 & ~b1)) continue;
        for (const g of sub.members) {
        PROF.candWalk++;
          const r = tryCand(g, col - back - g.dx - g.inkLeft, col);  // pen puts first ink col at col-back
          if (!r) continue;
          // tie-break on original candidate order: acceptance must not depend
          // on the group iteration order (plain loop = first max wins)
          if (!best || r.score > best.score || (r.score === best.score && r.g._i < best.g._i))
            best = r;
        }
        }
        }
        if (best) break;
      }
      PROF.anchor += performance.now() - _ta;
      if (best) PROF.anchorHit++;
      }
      if (!best) {
        const _tf = performance.now();
        // rasterizer-variance dust: an older rasterizer may spread a curve a
        // pixel wider than our raster, and at glyph junctions (f-hook ∩ i-dot)
        // the deviations of both curves compound beyond any per-pixel tolerance.
        // A residue of ≤3 unexplained pixels, each either faint or adjacent to
        // already-explained ink, is absorbed silently; anything larger/isolated
        // and dark is real unexplained ink and stays a □ failure.
        if (TOL) {
          const px = [];
          for (let x = col; x < Math.min(col + 3, xTo); x++)
            for (let y = cTop; y < cBot; y++)
              if (pageAt(x, y) !== q(canAt(x, y))) px.push([x, y]);
          const okDust = px.length <= 3 && px.every(([x, y]) => {
            if (pageAt(x, y) >= 255 - 6 * TOL && Math.abs(pageAt(x, y) - q(canAt(x, y))) <= 6 * TOL) return true;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx >= xFrom && nx < xTo && ny >= y0 && ny < y1 &&
                    canAt(nx, ny) < 255 && pageAt(nx, ny) === q(canAt(nx, ny))) return true;
              }
            return false;
          });
          if (okDust) {
            for (const [x, y] of px) setCan(x, y, pageAt(x, y));
            cursor = col;
            PROF.fail += performance.now() - _tf;
            continue;
          }
        }
        // give up on this ink cluster: absorb its columns up to the next white
        // gap, emit one □, and bail out entirely once the fail budget is spent
        chainPenQ = null;                        // unexplained ink breaks the pen chain
        if (DBG_ON && maxGlyphs === Infinity) {
          console.log(`    fail @col ${col} baseline ${baseline}`);
          for (let y = cTop; y < cBot; y++)
            if (pageAt(col, y) !== canAt(col, y))
              console.log(`      unexplained (${col},${y}) page=${pageAt(col, y)} canvas=${canAt(col, y)}`);
        }
        // Flood the connected components of unexplained ink through the fail
        // column (a column-range absorb swallows readable glyphs that merely
        // share columns with the blob — a byte-clean comma right of a box-edge
        // fragment was eaten that way), but ABSORB only their pixels at
        // x ≤ col+2 into the dead overlay: letters further right in the same
        // kern-connected blob may be intact glyphs ("you" after a
        // box-composited head) and get their own tries. One □ per blob: fails
        // inside the last blob's extent are not re-reported.
        let compRight = col;
        const stack = [];
        for (let y = cTop; y < cBot; y++)
          if (pageAt(col, y) !== q(canAt(col, y)) && !masked(col, y)) stack.push(col << 16 | y);
        const seen = new Set();
        while (stack.length) {
          const k = stack.pop();
          if (seen.has(k)) continue;
          seen.add(k);
          const px = k >> 16, py = k & 0xffff;
          if (px > compRight) compRight = px;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < xFrom || nx >= xTo || ny < cTop || ny >= cBot || seen.has(nx << 16 | ny)) continue;
            if (pageAt(nx, ny) < 255 && !masked(nx, ny) && pageAt(nx, ny) !== q(canAt(nx, ny)))
              stack.push(nx << 16 | ny);
          }
        }
        for (const k of seen) {
          const px = k >> 16, py = k & 0xffff;
          if (px <= col + 2) {
            setCan(px, py, pageAt(px, py));
            skip[(py - y0) * bw + (px - xFrom)] = 1;
          }
        }
        // fail/frag classification is DEFERRED to line end: at fail time the
        // flood cannot know which connected ink a LATER try will read (a
        // box remnant kerned into "TELL ME" measures 22px here, but its
        // truly-dead remains span 8px) — record the component, judge the
        // dead survivors afterwards. Recorded regardless of halos: the
        // page-end retro-check (readPage) also needs the pixels, to retract
        // a "fail" whose dead ink a LATER line explains (its neighbour's
        // ascender tip row-glued to this band's bottom).
        if (col > failGuard) records.push({ col, comp: seen });
        failGuard = Math.max(failGuard, compRight);
        cursor = col;
        PROF.fail += performance.now() - _tf;
        if (fails.length + records.length >= maxFails) break;
        continue;
      }
      // blend the accepted glyph into the canvas: exact pixels take the page
      // value; pending pixels take the glyph-over-canvas prediction so the next
      // glyph composites against it
      const _tb = performance.now();
      const { g, pi, gx, gy } = best;
      for (const p of g.ink) {
        const rr = (p / g.w) | 0, cc = p % g.w;
        const x = gx + cc, y = gy + rr;
        if (masked(x, y)) continue;                      // keep page bytes under objects
        const gb = g.bytes[p], ga = g.alpha[p], pv = pageAt(x, y), cv = canAt(x, y);
        if (TOL && cv !== 255 && gb >= 255 - 2 * TOL) continue;  // faint skip (see above)
        const t = cv !== 255 ? 2 * TOL : TOL;
        let val;
        if (g.lin ?? lin) {
          const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = shAt(x, y);
          const pred = (((cv - s0) * ga) / 255 | 0) + s0 + sh;   // ga = raw byte (gb − sh)
          const ok = Math.abs(q(pred) - pv) <= t ||
                     (cv !== 255 && q(pred) - pv === 1);   // composite 1-lighter case
          val = ok ? (QUANT ? pred : pv) : pred;        // quant: canvas stays original-space
          addSh(x, y, sh);
        } else {
          const e = ga + (ga >> 7);                     // single prediction (see tryCand)
          const pred = (cv * (256 - e)) >> 8;
          val = Math.abs(q(pred) - pv) <= t
            ? (QUANT ? pred : pv) : pred;               // absorb page value on a hit
        }
        setCan(x, y, val);
      }
      if (DBG_LINE !== null && DBG_LINE === baseline && maxGlyphs === Infinity)
        console.log(`    accept '${g.ch}' pen ${pi + g.phx} exact ${best.exact} pend ${best.pending} (anchor ${col})`);
      glyphs.push({ ch: g.ch, pen: pi + g.phx, adv: g.adv, exact: best.exact, pending: best.pending,
        ...(g.src ? { src: g.src } : {}) });
      accepted.add(`${g.ch}@${pi + g.phx}`);
      chainPenQ = Math.round((pi + g.phx + g.adv) * 4);  // expected next pen on the ¼-px lattice
      PROF.blend += performance.now() - _tb;
      cursor = col + 1;   // pending overlap columns right of col are revisited; the
    }                     // accepted-set guard prevents re-accepting the same glyph
    // Deferred fail/frag classification (final scans only — probes never pass
    // halos): judge each recorded component by its DEAD survivors (pixels a
    // later try explained don't count). A survivor set that TOUCHES a box halo
    // and is NARROW (< 13px — under two glyph widths) is a fragment of the
    // box's own REDACTED content (ascender tips above the top edge, a mostly
    // swallowed '>', a two-letter remnant) — a box fragment, not a text □:
    // that ink is destroyed by the document, not unread by the reader. A
    // remnant's letters are DISCONNECTED components and only the first touches
    // the box — touch chains through the previous fragment when the gap is
    // under a space width.
    let lastFragRight = -1;
    const failPix = new Map();                     // fail col -> dead pixels (x<<16|y, page coords)
    for (const r of records) {
      let minX = Infinity, maxX = -1, touch = false;
      const dead = [];
      for (const k of r.comp) {
        const px = k >> 16, py = k & 0xffff;
        if (!skip[(py - y0) * bw + (px - xFrom)]) continue;
        dead.push(k);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (!touch && inHalo(px, py)) touch = true;
      }
      if (maxX < 0) continue;                            // fully read by later tries
      const frag = maxX - minX < 13 &&
        (touch || (lastFragRight >= 0 && minX - lastFragRight <= 4));
      if (frag) {
        lastFragRight = Math.max(lastFragRight, maxX);
        if (!frags.length || r.col > frags[frags.length - 1] + 4) frags.push(r.col);
      } else if (!fails.length || r.col > fails[fails.length - 1] + 4) {
        fails.push(r.col);
        failPix.set(r.col, dead);
      } else {
        failPix.get(fails[fails.length - 1])?.push(...dead);  // same □ blob, merged
      }
    }
    // coverage certificate: any non-object band pixel the composition law
    // could not reproduce byte-exactly? unexpl[] already carries the running
    // count (masked cells are pre-seeded to canvas=page, so they never
    // register), so the residual is just its sum — no second full-window scan.
    let residual = 0;
    for (let x = 0; x < bw; x++) residual += unexpl[x];
    return { glyphs, fails, frags, failPix, residual, canvas, y0, y1, xFrom, xTo };
  }

  // try to read the first few glyphs of a band at a candidate (baseline, set, phy);
  // returns matched-ink score. maxFails bounds the work on wrong hypotheses —
  // without it a bad baseline absorbs the whole band column by column.
  function probeBaseline(page, mask, set, phy, baseline, x0, x1, TOL, quant, bandTop, explained, bandBot) {
    const line = scanLine(page, mask, set, phy, baseline, x0, Math.min(x1, x0 + 160), 4, 2, TOL, quant, null, bandTop, explained, bandBot);
    return line.glyphs.reduce((s, g) => s + g.exact, 0) - line.fails.length * 20;
  }

  // ---- spaces from measured gaps ----
  function spaceCalib(lines) {
    // gaps between consecutive glyphs, minus advance: cluster the positive ones
    const gaps = [];
    for (const L of lines)
      for (let i = 1; i < L.glyphs.length; i++)
        gaps.push(L.glyphs[i].pen - L.glyphs[i - 1].pen - L.glyphs[i - 1].adv);
    const pos = gaps.filter(g => g > 1.2 && g < 12).sort((a, b) => a - b);
    if (!pos.length) return null;
    // smallest dense cluster = one space
    for (let i = 0; i < pos.length; i++) {
      const c = pos.filter(g => Math.abs(g - pos[i]) < 0.6);
      if (c.length >= Math.max(3, pos.length * 0.05)) return c.reduce((s, x) => s + x, 0) / c.length;
    }
    return null;
  }

  // ---- per-page driver ----
  // page: {w, h, gray} (gray may be Uint8Array or Float32Array — only ever
  // holds integral 0..255 values by the time it reaches here; callers handle
  // colored-ink whitening upstream). sets: candidate glyph sets to try per
  // band — callers own any union-pool grouping policy and pass the final
  // list here. opts: { tol, quant, carry, progress }.
  //   tol: relaxes byte-exactness (see scanLine).
  //   quant: true to build+apply a palette map from this page (see quantMap).
  //   carry: caller-owned cross-page state for sequential whole-document
  //     reads — { last: {set,phy} of the previous band, picks: Map<baseline,
  //     {set,phy,below}> of certified picks }. Missing sub-fields are
  //     lazily initialized; a fresh {} works.
  //   progress(done, total): optional. When given, the scan yields to the
  //     event loop every few bands so a UI stays responsive; omitted (the
  //     Node/CLI case) skips the yield entirely so nothing pays for it.
  // Returns { lines, objects }. Each kept line carries: top, bot, baseline,
  // phy, set, font, glyphs, fails, frags, residual, clean, boxes, objects,
  // struck? — output shaping (spaces, text, box-position entries) is left to
  // the caller via the shared spaceCalib helper.
  async function readPage(page, sets, opts) {
    const tol = opts?.tol || 0;
    const carry = opts?.carry;
    const quant = opts?.quant ? quantMap(page) : null;
    const q = quant ? v => quant[v] : v => v;
    const { mask, objects } = detectObjects(page);
    // box halos (rect ±2): an unexplained cluster that TOUCHES a halo and is
    // NARROW (< 13px — under two glyph widths) is a fragment of the box's own
    // redacted content (ascender tips above the top edge, the visible tail of
    // a half-swallowed glyph, a two-letter remnant), not unread text: the
    // redactor's box clips its own content at arbitrary offsets, while a real
    // word beside a box is a connected cluster of two-plus glyphs (≥14px) and
    // stays an honest fail. Thin top/bottom slices of a segmented box come
    // out typed 'rule' — they are still the box for halo purposes.
    const isBoxSlice = o => o.type === 'rule' && objects.some(b => b.type === 'box' &&
      o.y1 >= b.y0 - 2 && o.y0 <= b.y1 + 2 && Math.min(o.x1, b.x1) > Math.max(o.x0, b.x0));
    const halos = objects.filter(o => o.type === 'box' || isBoxSlice(o))
      .map(o => [o.x0 - 2, o.x1 + 2, o.y0 - 3, o.y1 + 3]);
    const bands = findBands(page, mask);
    const lines = [];
    // ink already explained by an earlier line's scan window: a line without
    // descenders but with '_' glyphs leaves the '_' strokes (rows baseline+2..3)
    // as their own blank-row-separated band, though the line's scan (which spans
    // baseline+maxDesc) read and reported them — such a band is not a □
    const explained = new Uint8Array(page.w * page.h);
    // (set, phy) of the previous band — carried ACROSS pages: a document's
    // font rarely changes at a page break, and the fast path verifies anyway
    let n = 0, last = carry?.last ?? null;
    // Work list, not a plain loop: when a band's picked baseline cannot reach
    // the band's top rows (pitch < maxAsc+maxDesc interleaves adjacent lines'
    // ink rows into ONE band — routine at small ems, e.g. the 12.36px Outside
    // In Courier), the band holds MORE than one text line. Such a band is
    // SPLIT at the line's scan-window top: the rows above are queued as a
    // band of their own and read FIRST — the upper line lands in transcript
    // order and its ink is in `explained` before the lower line's scan
    // judges the shared rows.
    const work = bands.map(([top, bot]) => ({ top, bot, pick: null }));
    for (let wi = 0; wi < work.length; wi++) {
      const { top, bot } = work[wi];
      // split-created upper segments clamp unexplained-ink judging at the
      // split boundary (their bot): ink there is the NEXT segment's to judge
      const clampBot = work[wi].clamp ? bot : null;
      if (opts?.progress && ++n % 6 === 0) {
        opts.progress(n, work.length);
        await new Promise(r => setTimeout(r, 0));
      }
      // leftmost/rightmost non-object ink of the band
      let x0 = page.w, x1 = 0, fresh = false;
      const colInk = new Uint8Array(page.w);
      for (let y = top; y < bot; y++) {
        const off = y * page.w;
        for (let x = 0; x < page.w; x++)
          if (page.gray[off + x] < 255 && !mask[off + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            colInk[x] = 1;
            if (!explained[off + x]) fresh = true;
          }
      }
      if (x1 >= x0 && !fresh) continue;                  // fully explained by a line above
      // probe anchor = start of the band's DENSEST unmasked-ink cluster (gaps
      // ≤8px bridge): the probes below window only [start, start+160], and a
      // glyph fragment protruding from a redaction box at the band's left edge
      // must not aim that window into the box span (it reads nothing there and
      // the whole band goes unread)
      let xp = x0;
      {
        let bestN = -1, s = -1, nn = 0, gap = 0;
        for (let x = x0; x <= x1 + 9; x++) {
          if (x <= x1 && colInk[x]) { if (s < 0) { s = x; nn = 0; } nn++; gap = 0; }
          else if (s >= 0 && ++gap > 8) {
            if (nn > bestN) { bestN = nn; xp = s; }
            s = -1;
          }
        }
      }
      // objects sharing rows with this band (reported per line; space gaps
      // spanning them are suppressed)
      const lineObjects = objects.filter(ob => ob.y0 < bot + 4 && ob.y1 > top - 4);
      // fast path (mirrors the app): most documents use ONE (font, y-phase)
      // throughout — try the previous band's winner first and accept it when
      // its probe fully reads; fall back to the full sweep otherwise
      let pick = work[wi].pick;          // pre-pinned by a band split below
      // cross-page layout hint: repeating documents lay page n out on page
      // n−1's BASELINE grid (band tops/bottoms shift with ascender/descender
      // content, baselines don't), so earlier pages' picks whose baseline
      // falls in this band's range are each tried as a single probe.
      // Accepted only when the probe fully reads — a stale hint costs one
      // probe and certification never rests on the assumption (a cached
      // measurement, not a layout constant: every acceptance is still
      // byte-proven on THIS page).
      if (carry?.picks)
        for (const [yb, hint] of carry.picks) {
          if (pick) break;
          // non-below hints must be bottom-anchored like the probe sweeps
          // (yb > bot − maxDesc): a mid-band hint would pin a line in the
          // MIDDLE of a stacked band and orphan everything below it
          if (hint.below ? (yb <= bot || yb > bot + hint.set.maxAsc)
                         : (yb <= top || yb > bot || yb < bot - hint.set.maxDesc)) continue;
          const probe = scanLine(page, mask, hint.set, hint.phy, yb,
            Math.max(0, xp - 2), Math.min(page.w, Math.max(0, xp - 2) + 160), 4, 0, tol, quant, null, top, explained, clampBot);
          if (probe.glyphs.length >= 3 && probe.fails.length === 0)
            pick = { set: hint.set, phy: hint.phy, yb, below: hint.below,
              score: probe.glyphs.reduce((s, g) => s + g.exact, 0) };
        }
      if (!pick && last) {
        for (let yb = bot; yb >= bot - last.set.maxDesc && yb > top && !pick; yb--) {
          const probe = scanLine(page, mask, last.set, last.phy, yb,
            Math.max(0, xp - 2), Math.min(page.w, Math.max(0, xp - 2) + 160), 4, 0, tol, quant, null, top, explained, clampBot);
          if (probe.glyphs.length >= 3 && probe.fails.length === 0)
            pick = { set: last.set, phy: last.phy, yb,
              score: probe.glyphs.reduce((s, g) => s + g.exact, 0) };
        }
      }
      // pin (set, phy, baseline): try candidates, keep best probe score
      // baseline = last ink row + 1 on descender-free lines, up to maxDesc higher
      // otherwise — try the whole range (and every set × y-phase)
      if (!pick)
      for (const set of sets)
        for (const phy of set.byPhy.keys())
          for (let yb = bot; yb >= bot - set.maxDesc && yb > top; yb--) {
            const score = probeBaseline(page, mask, set, phy, yb, Math.max(0, xp - 2), Math.min(page.w, x1 + 20), tol, quant, top, explained, clampBot);
            if (score > 0 && (!pick || score > pick.score)) pick = { set, phy, yb, score };
          }
      // glyphs whose ink sits entirely above the baseline (a row of '-' or '*':
      // separators, dividers) put the true baseline BELOW the band bottom —
      // outside the range above. Only failed bands pay for the second sweep.
      if (!pick)
        for (const set of sets)
          for (const phy of set.byPhy.keys())
            for (let yb = bot + 1; yb <= bot + set.maxAsc && yb <= page.h; yb++) {
              const score = probeBaseline(page, mask, set, phy, yb, Math.max(0, xp - 2), Math.min(page.w, x1 + 20), tol, quant, top, explained, clampBot);
              if (score > 0 && (!pick || score > pick.score)) pick = { set, phy, yb, score, below: true };
            }
      if (pick) last = { set: pick.set, phy: pick.phy };
      const pushUnread = () => {
        // a band whose every ink pixel sits inside box halos is redaction
        // spill (ascender tips above a box top), not an unread text line
        let fragOnly = halos.length > 0 && x1 >= x0;
        for (let y = top; y < bot && fragOnly; y++) {
          const off = y * page.w;
          for (let x = x0; x <= x1 && fragOnly; x++)
            if (page.gray[off + x] < 255 && !mask[off + x] &&
                !halos.some(h => x >= h[0] && x < h[1] && y >= h[2] && y < h[3])) fragOnly = false;
        }
        lines.push({ top, bot, baseline: null, glyphs: [],
          fails: fragOnly || x1 < x0 ? [] : [x0], fragOnly,
          residual: 0, boxes: lineObjects.map(ob => [ob.x0 - 2, ob.x1 + 2]), objects: lineObjects, set: null });
      };
      if (!pick) { pushUnread(); continue; }
      // stacked band: fresh ink remains ABOVE this line's scan window — that
      // is another text line the window can never reach. Split: queue
      // [top, window-top) as its own band first, then this line (its pick is
      // kept). The re-queued lower item has top == window-top, so a band
      // splits each level at most once even when the upper segment fails.
      {
        const winTop = pick.yb - pick.set.maxAsc;
        if (winTop > top) {
          let stacked = false;
          for (let y = top; y < winTop && !stacked; y++) {
            const off = y * page.w;
            for (let x = 0; x < page.w; x++)
              if (page.gray[off + x] < 255 && !mask[off + x] && !explained[off + x]) { stacked = true; break; }
          }
          if (stacked) {
            work.splice(wi, 1, { top, bot: winTop, pick: null, clamp: true }, { top: winTop, bot, pick });
            wi--;
            continue;
          }
        }
        // symmetric guard BELOW the window: should a pick ever land mid-band
        // (a stale hint, a future pick source), the rows below yb + maxDesc
        // are later lines' — queue them after this one, never drop them
        const winBot = pick.yb + pick.set.maxDesc;
        if (winBot < bot) {
          let below = false;
          for (let y = winBot; y < bot && !below; y++) {
            const off = y * page.w;
            for (let x = 0; x < page.w; x++)
              if (page.gray[off + x] < 255 && !mask[off + x] && !explained[off + x]) { below = true; break; }
          }
          if (below) {
            work.splice(wi, 1, { top, bot: winBot, pick }, { top: winBot, bot, pick: null });
            wi--;
            continue;
          }
        }
      }
      const L = scanLine(page, mask, pick.set, pick.phy, pick.yb,
        Math.max(0, x0 - 2), Math.min(page.w, x1 + 4), Infinity, Infinity, tol, quant, halos, top, explained, clampBot);
      // a "line" that read NOTHING has no certified baseline — it is an unread
      // band (a dot-only band above a real line probes into that line's glyphs
      // through the +20px window, picks a shifted-but-equivalent baseline, then
      // reads zero glyphs in its own narrow span; the explained-by-below filter
      // must get the chance to drop it once the real line reads the ink).
      if (!L.glyphs.length) { pushUnread(); continue; }
      // A BELOW-band pick whose explained ink lies mostly BELOW the band is
      // the same phantom wearing glyphs: an 'i'-dot band pins the line below
      // through the window and reads that line's 'i'. Real below-band picks
      // ('-'/'*' separator rows, a lone '>' quote line — glyphs entirely above
      // their baseline) explain ink INSIDE their band.
      if (pick.below) {
        let inBand = 0, below = 0;
        const lw = L.xTo - L.xFrom;
        for (let y = L.y0; y < L.y1; y++)
          for (let x = L.xFrom; x < L.xTo; x++) {
            const v = L.canvas[(y - L.y0) * lw + (x - L.xFrom)];
            if (v < 255 && page.gray[y * page.w + x] === q(v) && !mask[y * page.w + x])
              (y < bot ? inBand++ : below++);
          }
        if (below > inBand) { pushUnread(); continue; }
      }
      // record explained ink — EXCEPT a fail blob's dead pixels: the flood
      // absorbed them into the canvas (canvas = page there), but they are the
      // □'s unexplained ink, not explained evidence
      const deadSet = new Set();
      if (L.failPix) for (const dead of L.failPix.values()) for (const k of dead) deadSet.add(k);
      for (let y = L.y0; y < L.y1; y++)
        for (let x = L.xFrom; x < L.xTo; x++)
          if (page.gray[y * page.w + x] < 255 &&
              page.gray[y * page.w + x] === q(L.canvas[(y - L.y0) * (L.xTo - L.xFrom) + (x - L.xFrom)]) &&
              !deadSet.has(x << 16 | y))
            explained[y * page.w + x] = 1;
      L.top = top; L.bot = bot; L.baseline = pick.yb; L.phy = pick.phy; L.set = pick.set;
      // a union pool has no per-band font identity — recover it per LINE by
      // majority vote over the byte-certified glyphs' source sets (a Times
      // heading in a Courier email must not display as the union's first name)
      {
        const votes = new Map();
        for (const g of L.glyphs) if (g.src) votes.set(g.src, (votes.get(g.src) ?? 0) + 1);
        L.font = votes.size
          ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]
          : pick.set.name;
      }
      L.boxes = lineObjects.map(ob => [ob.x0 - 2, ob.x1 + 2]);
      L.objects = lineObjects;
      // strike-through: a rule crossing the line's x-height voids the struck
      // span — text under the bar is deliberately not transcribed, so glyph
      // fragments and □s inside it are noise, not content (underlines sit
      // below the baseline and don't match)
      const strikes = lineObjects.filter(ob => ob.type === 'rule' &&
        ob.y0 >= pick.yb - 10 && ob.y1 <= pick.yb - 2 &&
        // a thin top/bottom edge segment of a redaction box is not a strike
        !objects.some(b => b.type === 'box' && ob.y1 >= b.y0 - 2 && ob.y0 <= b.y1 + 2 &&
          Math.min(ob.x1, b.x1) > Math.max(ob.x0, b.x0)));
      if (strikes.length) {
        L.glyphs = L.glyphs.filter(g => !strikes.some(sb => g.pen < sb.x1 + 2 && g.pen + g.adv > sb.x0 - 1));
        L.fails = L.fails.filter(c => !strikes.some(sb => c >= sb.x0 - 4 && c < sb.x1 + 4));
        L.struck = strikes.map(sb => [sb.x0, sb.x1]);
      }
      L.clean = L.fails.length === 0 && L.residual === 0;
      // remember this baseline's certified pick for the next page's hint
      if (carry) (carry.picks ??= new Map()).set(pick.yb, { set: pick.set, phy: pick.phy, below: pick.below });
      lines.push(L);
    }
    if (carry) carry.last = last;
    // retro-check recorded fails: a fail whose every dead pixel was explained
    // by ANOTHER line (a neighbour line's ascender tip or descender tail
    // row-glued into this band) is not unread text — retract it. Own absorbed
    // pixels never enter `explained`, so the check cannot self-satisfy.
    for (const L of lines) {
      if (!L.set || !L.fails.length || !L.failPix) continue;
      const keep = L.fails.filter(c => {
        const dead = L.failPix.get(c);
        return !dead || !dead.length ||
          dead.some(k => !explained[(k & 0xffff) * page.w + (k >> 16)] && !mask[(k & 0xffff) * page.w + (k >> 16)]);
      });
      if (keep.length !== L.fails.length) {
        L.fails = keep;
        L.clean = L.fails.length === 0 && L.residual === 0;
      }
    }
    // an unread band may be explained by a line BELOW it (an 'i' dot separated
    // from its stem by a blank row precedes its own line's band): re-check
    // against the final explained map before calling it a □
    return { lines: lines.filter(L => {
      if (L.set) return true;
      for (let y = L.top; y < L.bot; y++) {
        const off = y * page.w;
        for (let x = 0; x < page.w; x++)
          if (page.gray[off + x] < 255 && !mask[off + x] && !explained[off + x]) return true;
      }
      return false;
    }), objects };
  }

  const api = { unionSets, quantMap, detectObjects, findBands, anchorGroups,
    CHAIN_PROBES, scanLine, probeBaseline, spaceCalib, readPage, _prof: PROF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OCREngine = api;
})(typeof self !== 'undefined' ? self : this);

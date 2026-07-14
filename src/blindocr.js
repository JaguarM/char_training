// blindocr.js — self-calibrating byte-exact OCR core for the app (DOM-free,
// browser port of tools/blind-read.mjs). No layout constants: ink bands,
// per-band baseline/y-phase/font pinning, a left→right composite-aware scan
// against fontgen glyph rasters, non-text object detection (redaction boxes,
// rules/underlines), and spaces measured from pen gaps.
//
// In-app certificate: a line is CLEAN when the scan explained every non-object
// ink pixel of its band byte-exactly through the proven blend law
// (dst = (dst·(256−e))>>8, e = cov + (cov>>7)) — fails = 0 and residual = 0.
// (The bench's MuPDF re-render cross-check lives in tools/blind-read.mjs
// --verify; this is the same composition law applied in reverse.)
//
// Glyph sets come from assets/glyphs/glyphs_*.json (export_glyphs.py — pure synthetic
// fontgen rasters, 4 x-phases × 2 y-phases). Load with BlindOCR.loadSets().
(function (root) {
  'use strict';

  const SNAP = x => Math.round(x * 4) / 4;

  // blend-law inverse: single-glyph gray on white -> possible e = cov + (cov>>7)
  const INV = (() => {
    const inv = Array.from({ length: 256 }, () => []);
    for (let cov = 0; cov <= 255; cov++) {
      const e = cov + (cov >> 7);
      const g = (255 * (256 - e)) >> 8;
      if (!inv[g].includes(e)) inv[g].push(e);
    }
    return inv;
  })();

  // ---- glyph sets ----
  function b64ToBytes(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function parseSet(json, name) {
    const byPhy = new Map();
    let maxAsc = 0, maxDesc = 0;
    for (const [ch, rec] of Object.entries(json.chars)) {
      for (const [key, r] of Object.entries(rec.ph)) {
        if (!r.w) continue;
        const [phxS, phyS = '0'] = key.split('_');
        const phx = parseFloat(phxS), phy = parseFloat(phyS);
        const bytes = b64ToBytes(r.b64);
        const ink = [];
        let inkLeft = r.w;
        for (let c = 0; c < r.w; c++)
          for (let rr = 0; rr < r.h; rr++)
            if (bytes[rr * r.w + c] < 255) { ink.push(rr * r.w + c); if (c < inkLeft) inkLeft = c; }
        // hot-loop precomputation: per ink pixel its column, row and raster
        // byte (the candidate trial loop runs millions of times per page)
        const inkC = new Int16Array(ink.length), inkR = new Int16Array(ink.length),
          inkB = new Uint8Array(ink.length);
        for (let k = 0; k < ink.length; k++) {
          inkC[k] = ink[k] % r.w; inkR[k] = (ink[k] / r.w) | 0; inkB[k] = bytes[ink[k]];
        }
        if (!byPhy.has(phy)) byPhy.set(phy, []);
        byPhy.get(phy).push({ ch, adv: rec.adv, phx, w: r.w, h: r.h, dx: r.dx, dy: r.dy,
          bytes, ink, inkC, inkR, inkB, inkLeft });
        maxAsc = Math.max(maxAsc, -r.dy);
        maxDesc = Math.max(maxDesc, r.dy + r.h);
      }
    }
    return { name, sizePx: json.size_px, linear: !!json.linear, byPhy, maxAsc, maxDesc };
  }

  let _sets = null;
  async function loadSets(urls) {
    if (_sets) return _sets;
    const out = [];
    for (const u of urls ?? ['/assets/glyphs/glyphs_times16.json', '/assets/glyphs/glyphs_timesbd16.json',
      '/assets/glyphs/glyphs_timesi16.json', '/assets/glyphs/glyphs_tnr8_16.json',
      '/assets/glyphs/glyphs_arial16.json', '/assets/glyphs/glyphs_georgia16.json',
      '/assets/glyphs/glyphs_cour13.json',                    // courier_1/2 body font
      // linear-compositor variants (eDiscovery producer — see blind-read.mjs);
      // the per-band auto-pick chooses whichever compositor matches the page
      '/assets/glyphs/glyphs_timeslin16.json', '/assets/glyphs/glyphs_timesbdlin16.json',
      '/assets/glyphs/glyphs_timesilin16.json', '/assets/glyphs/glyphs_tnr8lin16.json',
      '/assets/glyphs/glyphs_tnr8lin10.json']) {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) continue;
        out.push(parseSet(await r.json(), u.replace(/^.*glyphs_|\.json$/g, '')));
      } catch { /* set not exported locally — skip */ }
    }
    _sets = out;
    return out;
  }

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
        for (const g of arr) byPhy.get(phy).push({ ...g, lin: s.linear });
      }
    }
    return { name: sets.map(s => s.name).join('+'), sizePx: sets[0].sizePx,
      linear: sets.some(s => s.linear), byPhy, maxAsc, maxDesc };
  }

  // ---- colored-ink removal (color pages) ----
  // Plain black text is achromatic (R=G=B). Colored ink (hyperlink blue) can
  // never byte-match gray glyph rasters, so every ink component connected to a
  // non-neutral pixel is whitened; the reader then sees only the plain text,
  // byte-exactly (bench blind-read.mjs readGray does the same to mode-2
  // rasters). Non-neutral: R≠G≠B when RGBA is supplied (app canvas — exact),
  // else a non-integral gray value ((R+G+B)/3 with the sum not divisible by 3
  // — the bench's sum%3 signal; misses neutral-sum colored pixels the same
  // way). Returns the page untouched when nothing is colored.
  function whitenColored(page, rgba) {
    const { w, h } = page, n = w * h, g = page.gray;
    const colored = new Uint8Array(n), stack = [];
    let jitter = null;
    if (rgba) {
      // channel spread ≥ 4 = real color; the flood below spreads only
      // through pixels whose channels differ at all (colored AA fringes),
      // never through neutral ink — a redaction box touching a blue link
      // underline survives while the underline vanishes. Spread 1-3 away
      // from color is producer JPEG jitter, NOT color: its true gray is
      // round((R+G+B)/3) (±1 single-channel jitter rounds back exactly;
      // heavier jitter lands within tol 1).
      const spread = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (g[i] >= 255) continue;
        const r = rgba[i * 4], gr = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        const mx = r > gr ? (r > b ? r : b) : (gr > b ? gr : b);
        const mn = r < gr ? (r < b ? r : b) : (gr < b ? gr : b);
        spread[i] = mx - mn;
        if (spread[i] >= 4) { colored[i] = 1; stack.push(i); }
      }
      if (!stack.length && !spread.some(v => v)) return page;
      const gray = Float32Array.from(g);
      while (stack.length) {                           // flood through colored px only
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const j = ny * w + nx;
            if (!colored[j] && spread[j]) { colored[j] = 1; stack.push(j); }
          }
      }
      let removed = 0;
      for (let i = 0; i < n; i++) {
        if (colored[i]) { gray[i] = 255; removed++; }
        else if (spread[i]) gray[i] = Math.round(gray[i]);   // jitter → neutral
      }
      return { w, h, gray, colorRemoved: removed };
    }
    // no RGBA (cached page): fractional gray = non-neutral (sum-only law)
    for (let i = 0; i < n; i++) {
      if (g[i] >= 255) continue;
      if (g[i] !== Math.floor(g[i])) { colored[i] = 1; stack.push(i); }
    }
    if (!stack.length) return page;
    const gray = Float32Array.from(g);
    while (stack.length) {                             // flood over connected ink
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!colored[j] && gray[j] < 255) { colored[j] = 1; stack.push(j); }
        }
    }
    let removed = 0;
    for (let i = 0; i < n; i++) if (colored[i]) { gray[i] = 255; removed++; }
    return { w, h, gray, colorRemoved: removed };
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
  function detectObjects(page) {
    const { w, h, gray } = page;
    // light rules (HTML blockquote quote bars, decorative separators): a long
    // strictly-contiguous run of NEAR-CONSTANT light gray (min ≥160 — darker is
    // the dark-run rule's job — and max−min ≤ 8) is a rule regardless of
    // darkness. Text can never fake it: blank inter-line rows/columns break
    // runs long before 40px (glyph stacks are ~15 rows) and glyph AA never
    // holds one value for 40px. email.pdf's quote bar (x=56, gray 204, 982
    // rows) and v4's separator (y=440, gray 237) match; underline/box-edge AA
    // rows merge into their dark rule object like any other run.
    const lightRuns = (n, m, at, out) => {            // scan m lines of length n
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
    const rows = [];
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
    const boxObjs = objects.filter(o => !o.vr && o.y1 - o.y0 > 4);
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (!o.vr) continue;
      let cov = 0;
      for (const b of boxObjs)
        if (o.x0 >= b.x0 - 2 && o.x1 <= b.x1 + 2)
          cov += Math.max(0, Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0));
      if (cov > 0.6 * (o.y1 - o.y0)) objects.splice(i, 1);
    }
    // Mask X sides adaptively: dark AA (<160) is already inside the detected
    // extent; a fractional edge's LIGHT AA line is near-constant along the
    // whole side (mode ≥160 over ≥90% coverage — glyph composites can darken
    // a minority of rows). A side whose adjacent column is blank or carries
    // sparse varying ink gets NO padding — that ink is glyph evidence, not
    // the object's (a blanket ±2 pad swallowed real "," ":" "." ">" pressed
    // against redaction boxes). Y keeps the blanket ±2: rules live UNDER
    // text (underlines) and their over/under rows are a legitimate
    // glyph∩rule composite zone.
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
    // rows are a legitimate glyph∩rule composite zone.
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
        if (page.gray[off + x] < 255 && !mask[off + x]) { inked[y] = 1; break; }
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

  // ---- the scanner (see tools/blind-read.mjs for the full derivation) ----
  // TOL relaxes byte-exactness to |Δ|≤TOL per glyph-ink pixel (2×TOL on
  // composite pixels, where two curves' rasterizer deviations compound) — for
  // pages from a NEAR-identical rasterizer (e.g. an older FreeType). 0 = exact.
  // Linear sets (set.linear — the eDiscovery producer): glyph raw alpha bytes
  // composite multiplicatively in 255-space with floor, and the PAGE byte adds
  // +1 per contributing "light" pixel — light iff RAW MuPDF byte ∈ [128,254],
  // which in linear-set bytes is gb ∈ [129,254] with raw = gb−1 (gb 255 =
  // raw 254 is erased to white by the +1 and drops out of the ink mask).
  // A per-pixel shift count keeps the raw canvas recoverable from page space.
  function scanLine(page, mask, set, phy, baseline, xFrom, xTo, maxGlyphs, maxFails, TOL, QUANT, halos, bandTop) {
    if (maxGlyphs === undefined) maxGlyphs = Infinity;
    if (maxFails === undefined) maxFails = Infinity;
    TOL = TOL || 0;
    const inHalo = (x, y) => halos && halos.some(h => x >= h[0] && x < h[1] && y >= h[2] && y < h[3]);
    const q = QUANT ? v => QUANT[v] : v => v;         // palette law (see quantMap)
    const lin = set.linear;
    const W = page.w, cands = set.byPhy.get(phy) ?? [];
    const y0 = Math.max(0, baseline - set.maxAsc), y1 = Math.min(page.h, baseline + set.maxDesc);
    const bw = xTo - xFrom, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return { glyphs: [], fails: [], residual: 0, canvas: null, y0, y1, xFrom, xTo };
    const canvas = new Float32Array(bw * bh).fill(255);
    // skip = window-local don't-care overlay: object mask pixels PLUS
    // absorbed-fail pixels (see the bench comment — a word whose head fell
    // into unexplainable residue must still read from its intact tail)
    const skip = new Uint8Array(bw * bh);
    const pageAt = (x, y) => page.gray[y * W + x];
    const masked = (x, y) => skip[(y - y0) * bw + (x - xFrom)];
    const canAt = (x, y) => canvas[(y - y0) * bw + (x - xFrom)];
    const shifts = lin ? new Uint8Array(bw * bh) : null;   // producer +1 count per pixel
    const shAt = (x, y) => (lin ? shifts[(y - y0) * bw + (x - xFrom)] : 0);
    const addSh = (x, y, s) => { if (lin) shifts[(y - y0) * bw + (x - xFrom)] += s; };
    for (let y = y0; y < y1; y++)
      for (let x = xFrom; x < xTo; x++)
        if (mask[y * W + x]) {
          canvas[(y - y0) * bw + (x - xFrom)] = pageAt(x, y);
          skip[(y - y0) * bw + (x - xFrom)] = 1;
        }
    // per-column count of unexplained pixels (page ≠ q(canvas)), maintained on
    // every canvas write — nextUnexplained becomes a pointer walk instead of
    // rescanning the band window after every glyph (was 80%+ of read time)
    // unexplained-ink accounting starts at the BAND top, not the window top:
    // ink above the band belongs to the PREVIOUS line (its descenders) —
    // accented capitals grew maxAsc past the line pitch. Window bottom stays
    // open (a '_'-only band below is deliberately explained through).
    const cTop = bandTop === undefined || bandTop === null ? y0 : Math.max(y0, bandTop);
    const unexpl = new Int32Array(bw);
    for (let x = xFrom; x < xTo; x++) {
      let n = 0;
      for (let y = cTop; y < y1; y++)
        if (pageAt(x, y) !== q(canAt(x, y))) n++;
      unexpl[x - xFrom] = n;
    }
    const setCan = (x, y, v) => {
      const i = (y - y0) * bw + (x - xFrom);
      const pv = page.gray[y * W + x];
      const before = pv !== q(canvas[i]);
      canvas[i] = v;
      const after = pv !== q(v);
      if (y >= cTop && before !== after) unexpl[x - xFrom] += after ? 1 : -1;
    };

    const nextUnexplained = (fromX) => {
      for (let x = Math.max(fromX, xFrom); x < xTo; x++)
        if (unexpl[x - xFrom] > 0) return x;
      return -1;
    };

    const glyphs = [], fails = [], frags = [], records = [];
    let failGuard = -1;                   // right edge of the last failed blob
    const accepted = new Set();
    let cursor = xFrom;
    while (glyphs.length < maxGlyphs) {
      const col = nextUnexplained(cursor);
      if (col < 0) break;
      let best = null;
      for (let back = 0; back <= 2 && !best; back++) {
        for (const g of cands) {
          const pi = col - back - g.dx - g.inkLeft;
          const gx = pi + g.dx, gy = baseline + g.dy;
          if (gx < xFrom || gx + g.w > xTo || gy < y0 || gy + g.h > y1) continue;
          // must explain the anchor column itself (hoisted: cheap reject)
          if (col < gx || col >= gx + g.w) continue;
          let exact = 0, pending = 0, skipped = 0, ok = true;
          const linG = g.lin ?? lin;
          const inkC = g.inkC, inkR = g.inkR, inkB = g.inkB, nInk = inkC.length;
          const rowBase = gy * W + gx, canBase = (gy - y0) * bw + (gx - xFrom);
          for (let k = 0; k < nInk; k++) {
            const cc = inkC[k], rr = inkR[k];
            const pOff = rowBase + rr * W + cc;
            if (skip[canBase + rr * bw + cc]) { skipped++; continue; }
            const gb = inkB[k], pv = page.gray[pOff], cv = canvas[canBase + rr * bw + cc];
            // fresh-canvas fast path (the overwhelmingly common case, non-
            // linear law): every e in INV[gb] reproduces gb from white by
            // construction — pred === gb — one compare replaces the e-loop
            if (cv === 255 && !linG) {
              const d = QUANT ? QUANT[gb] : gb;
              if (pv >= d - TOL && pv <= d + TOL) exact++;
              else if (pv < d - TOL) pending++;
              else { ok = false; break; }
              continue;
            }
            // tol mode: a neighbour may have absorbed this composite pixel
            // already; a faint own-contribution proves nothing — skip it
            if (TOL && cv !== 255 && gb >= 255 - 2 * TOL) { skipped++; continue; }
            const t = cv !== 255 ? 2 * TOL : TOL;
            let hit = false, minPred = 256;
            if (linG) {
              const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = lin ? shifts[canBase + rr * bw + cc] : 0;
              minPred = (((cv - s0) * (gb - sh)) / 255 | 0) + s0 + sh;
              // composite pixels may read 1 lighter than the law: the producer's
              // junction arithmetic is 1-ambiguous there (3/925 fitted pairs,
              // always this sign) — single-glyph pixels stay byte-strict
              hit = Math.abs(q(minPred) - pv) <= t || (cv !== 255 && q(minPred) - pv === 1);
            } else {
              for (const e of INV[gb]) {
                const pred = (cv * (256 - e)) >> 8;
                if (pred < minPred) minPred = pred;
                if (Math.abs(q(pred) - pv) <= t) { hit = true; break; }
              }
            }
            if (hit) exact++;
            else if (pv < q(minPred) - t) pending++;
            else { ok = false; break; }
          }
          const considered = nInk - skipped;
          if (!ok || considered < nInk * 0.5 ||
              exact < considered * 0.5 || pending > considered * 0.35) continue;
          if (accepted.has(g.ch + '@' + (pi + g.phx))) continue;  // after pixel work: rare
          const score = exact - pending * 0.25;
          if (!best || score > best.score) best = { g, pi, gx, gy, exact, pending, score };
        }
      }
      if (!best) {
        // junction/rasterizer dust (tol mode): ≤3 unexplained pixels, each
        // faint or adjacent to explained ink → absorb silently, no failure
        if (TOL) {
          const px = [];
          for (let x = col; x < Math.min(col + 3, xTo); x++)
            for (let y = y0; y < y1; y++)
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
            continue;
          }
        }
        // Flood the connected components of unexplained ink through the fail
        // column (a column-range absorb swallows readable glyphs that merely
        // share columns with the blob — a byte-clean comma right of a
        // box-edge fragment was eaten that way); absorb only x ≤ col+2 into
        // the skip overlay so intact kern-connected tail letters get their
        // own tries. One □ per blob. Fail/frag classification is DEFERRED to
        // line end (see below) — at fail time the flood cannot know which
        // connected ink a LATER try will read.
        let compRight = col;
        const stack = [];
        for (let y = cTop; y < y1; y++)
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
            if (nx < xFrom || nx >= xTo || ny < cTop || ny >= y1 || seen.has(nx << 16 | ny)) continue;
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
        if (halos) {
          if (col > failGuard) records.push({ col, comp: seen });
        } else if (col > failGuard && (!fails.length || col > fails[fails.length - 1] + 4)) {
          fails.push(col);
        }
        failGuard = Math.max(failGuard, compRight);
        cursor = col;
        if (fails.length + records.length >= maxFails) break;
        continue;
      }
      const { g, pi, gx, gy } = best;
      for (const p of g.ink) {
        const rr = (p / g.w) | 0, cc = p % g.w;
        const x = gx + cc, y = gy + rr;
        if (masked(x, y)) continue;
        const gb = g.bytes[p], pv = pageAt(x, y), cv = canAt(x, y);
        if (TOL && cv !== 255 && gb >= 255 - 2 * TOL) continue;   // faint skip (see above)
        const t = cv !== 255 ? 2 * TOL : TOL;
        let val = null;
        if (g.lin ?? lin) {
          const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = shAt(x, y);
          const pred = (((cv - s0) * (gb - sh)) / 255 | 0) + s0 + sh;
          const ok = Math.abs(q(pred) - pv) <= t ||
                     (cv !== 255 && q(pred) - pv === 1);          // composite 1-lighter case
          val = ok ? (QUANT ? pred : pv) : pred;   // quant: canvas stays original-space
          addSh(x, y, sh);
        } else {
          for (const e of INV[gb]) {
            const pred = (cv * (256 - e)) >> 8;
            if (Math.abs(q(pred) - pv) <= t) { val = QUANT ? pred : pv; break; }  // absorb page value
            if (val === null) val = pred;
          }
        }
        setCan(x, y, val);
      }
      glyphs.push({ ch: g.ch, pen: pi + g.phx, adv: g.adv, exact: best.exact, pending: best.pending });
      accepted.add(g.ch + '@' + (pi + g.phx));
      cursor = col + 1;
    }
    // Deferred fail/frag classification (final scans only — probes never
    // pass halos): judge each recorded component by its DEAD survivors
    // (pixels a later try explained don't count). A survivor set that
    // TOUCHES a box halo and is NARROW (< 13px — under two glyph widths) is
    // a fragment of the box's own REDACTED content — a box fragment, not a
    // text □. Touch chains through the previous fragment when the gap is
    // under a space width (a remnant's letters are disconnected components).
    let lastFragRight = -1;
    for (const r of records) {
      let minX = Infinity, maxX = -1, touch = false;
      for (const k of r.comp) {
        const px = k >> 16, py = k & 0xffff;
        if (!skip[(py - y0) * bw + (px - xFrom)]) continue;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (!touch && inHalo(px, py)) touch = true;
      }
      if (maxX < 0) continue;                          // fully read by later tries
      const frag = maxX - minX < 13 &&
        (touch || (lastFragRight >= 0 && minX - lastFragRight <= 4));
      if (frag) {
        lastFragRight = Math.max(lastFragRight, maxX);
        if (!frags.length || r.col > frags[frags.length - 1] + 4) frags.push(r.col);
      } else if (!fails.length || r.col > fails[fails.length - 1] + 4) fails.push(r.col);
    }
    // coverage certificate: any non-object band pixel the composition law
    // could not reproduce byte-exactly? (counted from the band top — ink
    // above it belongs to the previous line)
    let residual = 0;
    for (let y = cTop; y < y1; y++)
      for (let x = xFrom; x < xTo; x++)
        if (!masked(x, y) && pageAt(x, y) !== q(canAt(x, y))) residual++;
    return { glyphs, fails, frags, residual, canvas, y0, y1, xFrom, xTo };
  }

  function probeBaseline(page, mask, set, phy, baseline, x0, x1, tol, quant, bandTop) {
    const line = scanLine(page, mask, set, phy, baseline, x0, Math.min(x1, x0 + 160), 4, 2, tol, quant, null, bandTop);
    return line.glyphs.reduce((s, g) => s + g.exact, 0) - line.fails.length * 20;
  }

  // ---- spaces from measured gaps ----
  function spaceCalib(lines) {
    const gaps = [];
    for (const L of lines)
      for (let i = 1; i < L.glyphs.length; i++)
        gaps.push(L.glyphs[i].pen - L.glyphs[i - 1].pen - L.glyphs[i - 1].adv);
    const pos = gaps.filter(g => g > 1.2 && g < 12).sort((a, b) => a - b);
    if (!pos.length) return null;
    for (let i = 0; i < pos.length; i++) {
      const c = pos.filter(g => Math.abs(g - pos[i]) < 0.6);
      if (c.length >= Math.max(3, pos.length * 0.05)) return c.reduce((s, x) => s + x, 0) / c.length;
    }
    return null;
  }

  // entries: glyphs plus □ stand-ins for unreadable clusters, in pen order.
  // Returns per-entry text offsets so the app can build boxes at measured pens.
  function lineEntries(L, spaceAdv) {
    const entries = L.glyphs.map(g => ({ ch: g.ch, pen: g.pen, adv: g.adv, score: 1 }));
    for (const col of L.fails) entries.push({ ch: '□', pen: col, adv: 8, score: 0 });
    entries.sort((a, b) => a.pen - b.pen);
    const boxes = L.boxes ?? [];
    let text = '';
    for (let i = 0; i < entries.length; i++) {
      if (i) {
        const a = entries[i - 1].pen + entries[i - 1].adv, b = entries[i].pen;
        const gap = b - a;
        if (boxes.some(bx => bx[0] >= a - 2 && bx[1] <= b + 2)) text += ' ';
        else if (spaceAdv && gap > 0.55 * spaceAdv) text += ' '.repeat(Math.max(1, Math.round(gap / spaceAdv)));
      }
      entries[i].i = text.length;
      const ch = entries[i].ch;
      text += ch === 'ﬁ' ? 'fi' : ch === 'ﬂ' ? 'fl' : ch;  // ligatures transcribe as letters
    }
    return { entries, text };
  }

  // ---- per-page driver ----
  // page: {w, h, gray} (the engine's own buffer — Float32 with integral values
  // on native gray pages; run color pages through whitenColored first).
  // opts: {tol, quant, union, progress}. progress(done, total) is called
  // between bands; the read yields to the event loop so the UI stays alive.
  async function readPage(page, sets, opts) {
    const tol = opts?.tol || 0;
    // union pools group by PIXEL SIZE, not into one global pool: fonts mixed
    // within a line (bold label + regular value) share their size, while a
    // global pool lets a foreign-size font byte-match glyph fragments and
    // steal pixels (a times sliver ate courier 'e's — measured on courier_1)
    if (opts?.union && sets.length > 1) {
      const bySize = new Map();
      for (const s of sets) {
        if (!bySize.has(s.sizePx)) bySize.set(s.sizePx, []);
        bySize.get(s.sizePx).push(s);
      }
      sets = [...bySize.values()].map(g => g.length > 1 ? unionSets(g) : g[0]);
    }
    const quant = opts?.quant ? quantMap(page) : null;
    const q = quant ? v => quant[v] : v => v;
    const { mask, objects } = detectObjects(page);
    // box halos (rect ±2 cols / ±3 rows): an unexplained cluster that
    // TOUCHES a halo and is NARROW (< 13px) is a fragment of the box's own
    // redacted content, not unread text (see scanLine's deferred
    // classification). Thin top/bottom slices of a segmented box come out
    // typed 'rule' — still the box for halo purposes.
    const isBoxSlice = o => o.type === 'rule' && objects.some(b => b.type === 'box' &&
      o.y1 >= b.y0 - 2 && o.y0 <= b.y1 + 2 && Math.min(o.x1, b.x1) > Math.max(o.x0, b.x0));
    const halos = objects.filter(o => o.type === 'box' || isBoxSlice(o))
      .map(o => [o.x0 - 2, o.x1 + 2, o.y0 - 3, o.y1 + 3]);
    const bands = findBands(page, mask);
    const lines = [];
    // ink already explained by an earlier line's scan window: a line without
    // descenders but with '_' glyphs leaves the '_' strokes (rows baseline+2..3)
    // as their own blank-row-separated band, though the line's scan (which
    // spans baseline+maxDesc) read and reported them — such a band is not a □
    const explained = new Uint8Array(page.w * page.h);
    let n = 0, last = null;                 // previous band's winning (set, phy)
    for (const [top, bot] of bands) {
      if (++n % 6 === 0) {
        opts?.progress?.(n, bands.length);
        await new Promise(r => setTimeout(r, 0));
      }
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
      if (x1 >= x0 && !fresh) continue;                // fully explained by a line above
      // probe anchor = start of the band's DENSEST unmasked-ink cluster (gaps
      // ≤8px bridge): the probes below window only [start, start+160], and a
      // glyph fragment protruding from a redaction box at the band's left
      // edge must not aim that window into the box span
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
      const lineObjects = objects.filter(ob => ob.y0 < bot + 4 && ob.y1 > top - 4);
      // fast path: most documents use ONE (font, y-phase) throughout — try the
      // previous band's winner first and accept it when its probe fully reads;
      // fall back to the full sweep otherwise (font/style changes, headings)
      let pick = null;
      if (last) {
        for (let yb = bot; yb >= bot - last.set.maxDesc && yb > top && !pick; yb--) {
          const probe = scanLine(page, mask, last.set, last.phy, yb,
            Math.max(0, xp - 2), Math.min(page.w, Math.max(0, xp - 2) + 160), 4, 0, tol, quant, null, top);
          if (probe.glyphs.length >= 3 && probe.fails.length === 0)
            pick = { set: last.set, phy: last.phy, yb,
              score: probe.glyphs.reduce((s, g) => s + g.exact, 0) };
        }
      }
      if (!pick)
        for (const set of sets)
          for (const phy of set.byPhy.keys())
            for (let yb = bot; yb >= bot - set.maxDesc && yb > top; yb--) {
              const score = probeBaseline(page, mask, set, phy, yb, Math.max(0, xp - 2), Math.min(page.w, x1 + 20), tol, quant, top);
              if (score > 0 && (!pick || score > pick.score)) pick = { set, phy, yb, score };
            }
      // glyphs whose ink sits entirely above the baseline (a row of '-' or '*':
      // separators, dividers) put the true baseline BELOW the band bottom —
      // outside the range above. Only failed bands pay for the second sweep.
      if (!pick)
        for (const set of sets)
          for (const phy of set.byPhy.keys())
            for (let yb = bot + 1; yb <= bot + set.maxAsc && yb <= page.h; yb++) {
              const score = probeBaseline(page, mask, set, phy, yb, Math.max(0, xp - 2), Math.min(page.w, x1 + 20), tol, quant, top);
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
      const L = scanLine(page, mask, pick.set, pick.phy, pick.yb,
        Math.max(0, x0 - 2), Math.min(page.w, x1 + 4), Infinity, Infinity, tol, quant, halos, top);
      // a "line" that read NOTHING has no certified baseline — it is an
      // unread band (a dot-only band above a real line probes into that
      // line's glyphs through the +20px window, picks a shifted-but-
      // equivalent baseline, then reads zero glyphs in its own narrow span;
      // the explained-by-below filter must get the chance to drop it once
      // the real line reads the ink)
      if (!L.glyphs.length) { pushUnread(); continue; }
      // A BELOW-band pick whose explained ink lies mostly BELOW the band is
      // a phantom wearing glyphs (an 'i'-dot band pins the line below through
      // the window and reads that line's 'i'); real below-band picks
      // ('-'/'*' separators, a lone '>') explain ink INSIDE their band.
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
      for (let y = L.y0; y < L.y1; y++)                // record explained ink
        for (let x = L.xFrom; x < L.xTo; x++)
          if (page.gray[y * page.w + x] < 255 &&
              page.gray[y * page.w + x] === q(L.canvas[(y - L.y0) * (L.xTo - L.xFrom) + (x - L.xFrom)]))
            explained[y * page.w + x] = 1;
      L.top = top; L.bot = bot; L.baseline = pick.yb; L.phy = pick.phy;
      L.set = pick.set; L.font = pick.set.name;
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
      lines.push(L);
    }
    // an unread band may be explained by a line BELOW it (an 'i' dot separated
    // from its stem by a blank row precedes its own line's band): re-check
    // against the final explained map before calling it a □
    const kept = lines.filter(L => {
      if (L.set) return true;
      for (let y = L.top; y < L.bot; y++) {
        const off = y * page.w;
        for (let x = 0; x < page.w; x++)
          if (page.gray[off + x] < 255 && !mask[off + x] && !explained[off + x]) return true;
      }
      return false;
    });
    const spaceAdv = spaceCalib(kept);
    for (const L of kept) {
      const { entries, text } = lineEntries(L, spaceAdv);
      L.entries = entries; L.text = text;
    }
    return { lines: kept, objects, spaceAdv };
  }

  // ---- escalating auto-read (shared by the app and any embedder) ----
  // All BYTE-EXACT machinery first: plain per-band pick (both compositor
  // models are in the set list), palette quantization (v4/email-P1-family
  // producers palettize the final page), same-size mixed-font union pools
  // (bold label + regular value on ONE line) — and only then per-pixel
  // tolerances for producers with sub-model rounding stragglers, ±10 last
  // for near-identical renderers we haven't modelled. Keeps the fewest-
  // failures read at the earliest (weakest-machinery) pass; certificates
  // are labelled accordingly, never silently weakened.
  const blindPasses = [
    { tol: 0 }, { tol: 0, quant: true },
    { tol: 0, union: true }, { tol: 0, quant: true, union: true },
    { tol: 1 }, { tol: 2 }, { tol: 10 },
  ];

  function passLabel(pass) {
    return (pass.tol ? ` (±${pass.tol})` : '') + (pass.quant ? ' (palette)' : '') +
      (pass.union ? ' (mixed-font)' : '');
  }

  // Run the ladder on one page: { res, pass } — the fewest-failures read at
  // the earliest pass. opts: { passHint, progress(pass, done, total) }. A
  // document's producer doesn't change page to page — pass the previous
  // page's winning pass back in as passHint to try it first.
  async function readPageAuto(page, sets, opts) {
    const key = p => `${p.tol}|${p.quant ? 1 : 0}|${p.union ? 1 : 0}`;
    const hint = opts?.passHint;
    const passes = hint ? [hint, ...blindPasses.filter(p => key(p) !== key(hint))] : blindPasses;
    let best = null;
    for (const pass of passes) {
      const r = await readPage(page, sets, { tol: pass.tol,
        quant: pass.quant, union: pass.union,
        progress: opts?.progress && ((d, t) => opts.progress(pass, d, t)) });
      const fails = r.lines.reduce((s, L) => s + L.fails.length, 0) +
        r.lines.filter(L => !L.set && !L.fragOnly).length;
      const rank = blindPasses.findIndex(p => key(p) === key(pass));
      if (!best || fails < best.fails || (fails === best.fails && rank < best.rank))
        best = { res: r, pass, fails, rank };
      if (best.fails === 0) break;                     // fully read — stop here
      const glyphs = r.lines.reduce((s, L) => s + L.glyphs.length, 0);
      if (pass.tol >= 2 && glyphs >= fails * 8) break; // good enough — stop escalating
    }
    return { res: best.res, pass: best.pass };
  }

  const api = { loadSets, parseSet, readPage, readPageAuto, blindPasses, passLabel,
    detectObjects, findBands, scanLine, whitenColored, quantMap, unionSets };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlindOCR = api;
})(typeof self !== 'undefined' ? self : this);

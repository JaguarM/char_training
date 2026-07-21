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
    // All five run detectors (long dark row runs, light row rules, short dark
    // runs, dark vertical runs, light vertical rules) share ONE row-major pass:
    // each page byte is read once, in memory order, and drives the row-local
    // state machines plus per-column state arrays. (They used to be five
    // separate full-page scans — two of them column-major with a stride-w
    // access pattern, and the light-rule scans went through a per-pixel
    // accessor closure that was megamorphic across the two orientations;
    // together over a quarter of a whole-document read.) Detection semantics
    // and push/sort ordering are unchanged: dark and light runs can never tie
    // on a start pixel (disjoint gray classes), so the sorts below see the
    // same order as the old append-then-sort structure.
    const rows = [];                                      // long dark runs + light rules, per row
    const shortRuns = [];                                 // strict 10–39px dark runs (boxes)
    const vcols = [];                                     // vertical dark runs + light rules
    const vdS = new Int32Array(w).fill(-1), vdGap = new Int32Array(w);
    const vlS = new Int32Array(w).fill(-1), vlMn = new Int32Array(w), vlMx = new Int32Array(w);
    // ---- white-word fast path ----
    // A white pixel's effect on every machine is fixed: the row machines are
    // all quiescent (-1) after at most two whites (dark bridges one gap; light
    // and short close on the first), and a white pixel changes a COLUMN
    // machine only if that column has an open run. So: view the page 4 bytes
    // at a time; when a word is 0xFFFFFFFF and the row machines are idle, the
    // only work left is closing open column runs — tracked in a bitset, so
    // idle columns (margins: most of the page) cost one bit test. Runs close
    // at the same (x,y) as the per-pixel code, so rows/shortRuns/vcols come
    // out identical (a shortRun can only ever close per-pixel: sS open means
    // the word wasn't all-white, and the first white after it is per-pixel).
    const len = w * h;
    let wsrc = gray;
    if (gray.byteOffset & 3) { wsrc = new Uint8Array((len + 3) & ~3); wsrc.set(gray); }
    const words = new Uint32Array(wsrc.buffer, wsrc.byteOffset, len >> 2);
    const colAct = new Uint32Array((w + 31) >> 5);        // superset of columns with open runs
    // raw ink runs (gray<255, no mask knowledge yet), harvested by THIS scan
    // so the dust pass below never rereads the page. Flat typed arrays, grown
    // by doubling: [aX0,aX1] inclusive, row aY, run min byte aMin.
    let aCap = 4096, nRaw = 0;
    let aX0 = new Int32Array(aCap), aX1 = new Int32Array(aCap),
      aY = new Int32Array(aCap), aMin = new Int32Array(aCap);
    const aGrow = () => { aCap *= 2;
      const g2 = (a) => { const b = new Int32Array(aCap); b.set(a); return b; };
      aX0 = g2(aX0); aX1 = g2(aX1); aY = g2(aY); aMin = g2(aMin); };
    const whiteCol = (x, y) => {                          // one white pixel, column machines only
      if (vdS[x] >= 0 && ++vdGap[x] > 1) {
        if (y - vdGap[x] + 1 - vdS[x] >= 40) vcols.push({ x, y0: vdS[x], y1: y - vdGap[x] + 1 });
        vdS[x] = -1; vdGap[x] = 0;
      }
      if (vlS[x] >= 0) {
        if (y - vlS[x] >= 40) vcols.push({ x, y0: vlS[x], y1: y });
        vlS[x] = -1;
      }
      if (vdS[x] < 0 && vlS[x] < 0) colAct[x >> 5] &= ~(1 << (x & 31));
    };
    for (let y = 0; y <= h; y++) {                        // y == h: column sentinel row
      const off = y * w, rowLive = y < h;
      let dS = -1, dGap = 0;                              // dark row run (≤1px gaps bridged)
      let lS = -1, lMn = 0, lMx = 0;                      // light near-constant row run
      let sS = -1;                                        // short dark run (strict)
      let aO = -1, aMn = 255;                             // raw ink run (any v<255)
      for (let x = 0; x <= w; x++) {                      // x == w: row sentinel column
        if (rowLive && dS < 0 && lS < 0 && sS < 0 && ((off + x) & 3) === 0) {
          while (x + 4 <= w && words[(off + x) >> 2] === 0xFFFFFFFF) {
            if (colAct[x >> 5] | (colAct[(x + 3) >> 5])) {
              for (let k = 0; k < 4; k++) {
                const xx = x + k;
                if (colAct[xx >> 5] & (1 << (xx & 31))) whiteCol(xx, y);
              }
            }
            x += 4;
          }
        }
        const v = rowLive && x < w ? gray[off + x] : 255;
        if (rowLive) {
          // raw ink run (closes on the FIRST white — before the fast path can
          // engage, so a skipped span never hides an open run)
          if (v < 255) { if (aO < 0) { aO = x; aMn = v; } else if (v < aMn) aMn = v; }
          else if (aO >= 0) {
            if (nRaw === aCap) aGrow();
            aX0[nRaw] = aO; aX1[nRaw] = x - 1; aY[nRaw] = y; aMin[nRaw] = aMn; nRaw++;
            aO = -1;
          }
          const dark = x < w && v < 160;
          if (dark) { if (dS < 0) dS = x; dGap = 0; }
          else if (dS >= 0 && ++dGap > 1) {
            if (x - dGap + 1 - dS >= 40) rows.push({ y, x0: dS, x1: x - dGap + 1 });
            dS = -1; dGap = 0;
          }
          if (v >= 255 || v < 160) {
            if (lS >= 0 && x - lS >= 40) rows.push({ y, x0: lS, x1: x });
            lS = -1;
          } else {
            if (lS >= 0 && Math.max(lMx, v) - Math.min(lMn, v) > 8) {
              if (x - lS >= 40) rows.push({ y, x0: lS, x1: x });
              lS = -1;
            }
            if (lS < 0) { lS = x; lMn = lMx = v; }
            else { lMn = Math.min(lMn, v); lMx = Math.max(lMx, v); }
          }
          if (dark) { if (sS < 0) sS = x; }
          else if (sS >= 0) {
            if (x - sS >= 10 && x - sS < 40) shortRuns.push({ y, x0: sS, x1: x });
            sS = -1;
          }
        }
        if (x < w) {                                      // column state machines
          if (v < 255) colAct[x >> 5] |= 1 << (x & 31);   // may open a run: track for fast path
          const vdark = rowLive && v < 160;
          if (vdark) { if (vdS[x] < 0) vdS[x] = y; vdGap[x] = 0; }
          else if (vdS[x] >= 0 && ++vdGap[x] > 1) {
            if (y - vdGap[x] + 1 - vdS[x] >= 40) vcols.push({ x, y0: vdS[x], y1: y - vdGap[x] + 1 });
            vdS[x] = -1; vdGap[x] = 0;
          }
          if (v >= 255 || v < 160) {
            if (vlS[x] >= 0 && y - vlS[x] >= 40) vcols.push({ x, y0: vlS[x], y1: y });
            vlS[x] = -1;
          } else {
            if (vlS[x] >= 0 && Math.max(vlMx[x], v) - Math.min(vlMn[x], v) > 8) {
              if (y - vlS[x] >= 40) vcols.push({ x, y0: vlS[x], y1: y });
              vlS[x] = -1;
            }
            if (vlS[x] < 0) { vlS[x] = y; vlMn[x] = vlMx[x] = v; }
            else { vlMn[x] = Math.min(vlMn[x], v); vlMx[x] = Math.max(vlMx[x], v); }
          }
        }
      }
    }
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
    // (x-height spans ~7). Runs 10–39 px (collected in the fused pass above);
    // ≥40 is the main rule's job.
    const stacks = [];
    for (const r of shortRuns) {
      const g = stacks.find(g => g.y1 === r.y &&
        Math.abs(g.x0 - r.x0) <= 1 && Math.abs(g.x1 - r.x1) <= 1);
      if (g) g.y1 = r.y + 1;
      else stacks.push({ y0: r.y, y1: r.y + 1, x0: r.x0, x1: r.x1 });
    }
    for (const g of stacks)
      if (g.y1 - g.y0 >= 8) objects.push({ y0: g.y0, y1: g.y1, x0: g.x0, x1: g.x1 });
    // vertical rules (table/quote borders): long solid runs down a column —
    // collected in the fused pass above; the sort restores column-major order
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
        // a text line kerned tight against a box bridges EVERY x-height row
        // (8+, over the short-burst cap) — but a bridge burst is always a
        // strict SUPERSET of its neighbours' extent (the box plus the glyph
        // spans), while genuinely wider stacked boxes protrude on their own
        // rows only. A one-sided overhang burst absorbs at any height.
        const overhang = b.y1 - b.y0 < 5 ||
          (mode(b, 0) === mode(a, 0) && mode(b, 1) > mode(a, 1) + 4);
        if (overhang &&
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
    // Graphic residue (whitened-color pages): a colored emblem or rule whose
    // neutral-gray pixels survive whitening leaves (a) DUST — scattered ≤4×4
    // speck components far from any real glyph — and (b) GHOSTS — components
    // whose every byte is ≥244, too faint to be any glyph's core (a glyph
    // component always carries dark core pixels; its faint AA is connected to
    // that core). Both are masked below, after the object mask is built, so
    // they neither form ink bands nor extend a band's bottom past the true
    // baseline (seal dust under a letterhead line pushed the baseline sweep
    // out of range — the whole line went unread). Real punctuation is small
    // too, but never isolated: a '.', ':' or i-dot sits within a few px of a
    // big component, so dust requires no big (>12px, dark-core) component
    // AND no detected object within 8px — a sentence period beside a
    // redaction box has only masked box pixels for neighbours and would
    // otherwise read as isolated (the email/courier gate docs read exactly
    // such periods). Dash/asterisk separator rows stay readable: a '-' is
    // ≥5px wide, over the ≤4px dust cap.
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
    const rowIvs = new Array(h);           // per-row masked x-intervals [x0,x1) — lets the
                                           // dust pass split raw runs without reading mask bytes
    const mRows = new Uint8Array(h);       // per-row "mask has cells here" flag —
    for (const o of objects) {             // lets scanLine's window init skip rows
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
      for (let y = y0; y < y1; y++) {
        mRows[y] = 1;
        (rowIvs[y] ??= []).push([x0, x1]);
        for (let x = x0; x < x1; x++)
          mask[y * w + x] = 1;
      }
    }
    // ---- dust & ghost masking (see comment above the mask builder) ----
    {
      // Connected components (8-conn, over gray<255 && !mask) via row runs +
      // union-find — replaces the per-pixel DFS flood (9 neighbour checks per
      // ink pixel, formerly the single most expensive loop in this function).
      // Semantics are identical: same components, same n/minv/bbox, and every
      // downstream consumer (transitive keep, swarm grouping) is a
      // fixpoint/partition — component order provably cannot change the
      // outcome. Runs come from the fused scan's raw harvest, split where the
      // object mask covers them (rowIvs mirrors the mask bytes exactly — the
      // mask has no other writers before this point), so this pass reads NO
      // page bytes except to recompute the min byte of a piece the mask
      // truncated (the cut part may have held the min).
      const bigs = [], smalls = [];
      let cap = 4096, nRuns = 0;
      let rX0 = new Int32Array(cap), rX1 = new Int32Array(cap), rY = new Int32Array(cap),
        rPar = new Int32Array(cap), rMin = new Int32Array(cap);
      const grow = () => { cap *= 2;
        const g2 = (a) => { const b = new Int32Array(cap); b.set(a); return b; };
        rX0 = g2(rX0); rX1 = g2(rX1); rY = g2(rY); rPar = g2(rPar); rMin = g2(rMin); };
      const find = (a) => { let r = a; while (rPar[r] !== r) r = rPar[r];
        while (rPar[a] !== r) { const nx = rPar[a]; rPar[a] = r; a = nx; } return r; };
      let ps = 0, pe = 0, cs = 0, curY = -2;              // prev-row run window
      const emit = (x0, x1, y, minv) => {
        if (nRuns === cap) grow();
        const id = nRuns++;
        if (y !== curY) {
          if (y === curY + 1) { ps = cs; pe = id; } else { ps = pe = id; }
          cs = id; curY = y;
        }
        rX0[id] = x0; rX1[id] = x1; rY[id] = y; rPar[id] = id; rMin[id] = minv;
        for (let p = ps; p < pe; p++) {                   // 8-conn merge with prev row
          if (rX1[p] < x0 - 1) { if (p === ps) ps++; continue; }
          if (rX0[p] > x1 + 1) break;
          const ra = find(id), rb = find(p);
          if (ra !== rb) rPar[ra] = rb;
        }
      };
      const piece = (x0, x1, i) => {
        let mv;
        if (x0 === aX0[i] && x1 === aX1[i]) mv = aMin[i];
        else { mv = 255; const b = aY[i] * w;
          for (let xx = x0; xx <= x1; xx++) { const v = gray[b + xx]; if (v < mv) mv = v; } }
        emit(x0, x1, aY[i], mv);
      };
      for (let i = 0; i < nRaw; i++) {
        const y = aY[i], ivs = rowIvs[y];
        if (!ivs) { emit(aX0[i], aX1[i], y, aMin[i]); continue; }
        if (!ivs.sorted) { ivs.sort((p, q) => p[0] - q[0]); ivs.sorted = true; }
        let cur = aX0[i]; const end = aX1[i];
        for (const [m0, m1] of ivs) {
          if (m1 <= cur) continue;
          if (m0 > end) break;
          if (m0 > cur) piece(cur, m0 - 1, i);
          if (m1 > cur) cur = m1;
          if (cur > end) break;
        }
        if (cur <= end) piece(cur, end, i);
      }
      // accumulate per-root n/minv/bbox (root-indexed typed arrays)
      const cN = new Int32Array(nRuns), cMin = new Int32Array(nRuns),
        cX0 = new Int32Array(nRuns), cX1 = new Int32Array(nRuns),
        cY0 = new Int32Array(nRuns), cY1 = new Int32Array(nRuns);
      for (let i = 0; i < nRuns; i++) {
        const r = find(i);
        if (!cN[r]) { cMin[r] = 255; cX0[r] = w; cX1[r] = 0; cY0[r] = h; cY1[r] = 0; }
        cN[r] += rX1[i] - rX0[i] + 1;
        if (rMin[i] < cMin[r]) cMin[r] = rMin[i];
        if (rX0[i] < cX0[r]) cX0[r] = rX0[i]; if (rX1[i] > cX1[r]) cX1[r] = rX1[i];
        if (rY[i] < cY0[r]) cY0[r] = rY[i]; if (rY[i] > cY1[r]) cY1[r] = rY[i];
      }
      // classify roots in first-run (raster) order; cls 1 = mask its pixels
      const cls = new Uint8Array(nRuns);
      for (let i = 0; i < nRuns; i++) {
        const r = find(i);
        if (!cN[r] || cls[r]) continue;                   // visited via earlier run
        cls[r] = 2;                                       // classified, keep
        if (cMin[r] >= 244) cls[r] = 1;                   // ghost
        else if (cN[r] > 12) bigs.push([cX0[r], cX1[r], cY0[r], cY1[r]]);
        else if (cX1[r] - cX0[r] < 4 && cY1[r] - cY0[r] < 4)
          smalls.push({ x0: cX0[r], x1: cX1[r], y0: cY0[r], y1: cY1[r], minv: cMin[r], r });
      }
      // All neighbourhood questions below ("is this speck near text / near a
      // sibling speck?") are answered from a 16px bucket grid instead of
      // walking every big blob per speck (smalls × bigs × restart rounds —
      // the dominant remaining cost on residue-heavy pages). The keep set is
      // a monotone closure and the swarm groups are a partition, so the
      // verdicts are identical to the old restart-loop by construction.
      // Pages with no smalls skip every allocation here.
      if (smalls.length) {
        for (const o of objects) bigs.push([o.x0, o.x1, o.y0, o.y1]);
        const gw = (w >> 4) + 2, gh = (h >> 4) + 2;
        const cellsOf = (x0, x1, y0, y1, f) => {
          const cx0 = Math.max(0, x0 >> 4), cx1 = Math.min(gw - 1, x1 >> 4);
          const cy0 = Math.max(0, y0 >> 4), cy1 = Math.min(gh - 1, y1 >> 4);
          for (let cy = cy0; cy <= cy1; cy++)
            for (let cx = cx0; cx <= cx1; cx++) f(cy * gw + cx);
        };
        // transitive keep: an ellipsis dot 10px from the word but 4px from
        // its sibling dot is text — each kept small extends the neighbourhood
        // (grid seed from the bigs, then BFS speck-to-speck)
        const bigGrid = new Array(gw * gh), smGrid = new Array(gw * gh);
        for (const b of bigs)
          cellsOf(b[0] - 8, b[1] + 8, b[2] - 8, b[3] + 8, c => (bigGrid[c] ??= []).push(b));
        for (const s of smalls)
          cellsOf(s.x0, s.x1, s.y0, s.y1, c => (smGrid[c] ??= []).push(s));
        const queue = [];
        for (const s of smalls) {
          let hit = false;
          cellsOf(s.x0, s.x1, s.y0, s.y1, c => {
            if (hit || !bigGrid[c]) return;
            for (const [bx0, bx1, by0, by1] of bigGrid[c])
              if (s.x0 <= bx1 + 8 && s.x1 >= bx0 - 8 && s.y0 <= by1 + 8 && s.y1 >= by0 - 8) {
                hit = true; return;
              }
          });
          if (hit) { s.keep = true; queue.push(s); }
        }
        while (queue.length) {
          const q = queue.pop();
          cellsOf(q.x0 - 8, q.x1 + 8, q.y0 - 8, q.y1 + 8, c => {
            const lst = smGrid[c]; if (!lst) return;
            for (const t of lst)
              if (!t.keep && t.x0 <= q.x1 + 8 && t.x1 >= q.x0 - 8 &&
                  t.y0 <= q.y1 + 8 && t.y1 >= q.y0 - 8) { t.keep = true; queue.push(t); }
          });
        }
        // isolated smalls: faint ones are residue outright; DARK ones are real
        // punctuation unless they come in a swarm (emblem residue is dozens of
        // specks chained ≤12px apart — a sentence period stranded after a
        // whitened hyperlink is alone and stays readable)
        const iso = smalls.filter(s => !s.keep && s.minv < 160);
        const isoGrid = new Array(gw * gh);
        for (const s of iso) { s.grp = null;
          cellsOf(s.x0, s.x1, s.y0, s.y1, c => (isoGrid[c] ??= []).push(s)); }
        const groups2 = [];
        for (const s of iso) {
          if (s.grp) continue;
          const g2 = [s]; s.grp = g2;
          for (let gi = 0; gi < g2.length; gi++) {
            const q = g2[gi];
            cellsOf(q.x0 - 12, q.x1 + 12, q.y0 - 12, q.y1 + 12, c => {
              const lst = isoGrid[c]; if (!lst) return;
              for (const t of lst)
                if (!t.grp && q.x0 <= t.x1 + 12 && q.x1 >= t.x0 - 12 &&
                    q.y0 <= t.y1 + 12 && q.y1 >= t.y0 - 12) { t.grp = g2; g2.push(t); }
            });
          }
          groups2.push(g2);
        }
        for (const g2 of groups2)
          if (g2.length < 4) for (const s of g2) s.keep = true;
      }
      for (const s of smalls)
        if (!s.keep) cls[s.r] = 1;
      // one masking sweep: ghosts + unkept smalls, run-wise
      for (let i = 0; i < nRuns; i++) {
        if (cls[find(i)] !== 1) continue;
        const b = rY[i] * w; mRows[rY[i]] = 1;
        for (let xx = rX0[i]; xx <= rX1[i]; xx++) mask[b + xx] = 1;
      }
    }
    mask._rows = mRows;
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
  // ---- discriminating-first ink order ----
  // tryCand walks a candidate's ink arrays in order and hard-rejects at the
  // first pixel the page cannot support; its verdict is order-invariant
  // (reject iff ANY pixel hard-fails, counts are sums), so the walk order is
  // free to choose. Build order (column-major, left→right) is pessimal: the
  // scanner anchors every candidate by its first ink column, so the left edge
  // nearly always matches and wrong candidates die late (~9 px). Reorder by
  // pool-census rarity — pixels whose (row, col, byte-bucket) prediction is
  // shared by the fewest pool mates first — and rejects die in ~3 px. Applied
  // once per pool (guarded), in the aligned frame row = dy+r, col = c−inkLeft.
  function rareOrder(cands) {
    const census = new Map();
    const key = (g, k) =>
      ((g.dy + g.inkR[k] + 64) << 12) | ((g.inkC[k] - g.inkLeft) << 3) | (g.inkB[k] >> 5);
    for (const g of cands) for (let k = 0; k < g.inkC.length; k++)
      census.set(key(g, k), (census.get(key(g, k)) || 0) + 1);
    for (const g of cands) {
      const n = g.inkC.length;
      if (g._rare || n < 2) { g._rare = 1; continue; }
      g._rare = 1;
      const idx = Array.from({ length: n }, (_, k) => k);
      const sc = idx.map(k => census.get(key(g, k)));
      idx.sort((a, b) => sc[a] - sc[b] || g.inkB[a] - g.inkB[b] || a - b);
      const pick = (arr) => arr.constructor.from(idx, k => arr[k]);
      g.inkC = pick(g.inkC); g.inkR = pick(g.inkR); g.inkB = pick(g.inkB); g.inkA = pick(g.inkA);
    }
  }

  function anchorGroups(set, phy, quant, TOL) {
    const cands = set.byPhy.get(phy) ?? [];
    const ASC = set.maxAsc, span = ASC + set.maxDesc;
    if (!cands._rare) { rareOrder(cands); cands._rare = true; }
    if (span > 64) return null;                        // mask would overflow: plain path
    cands.forEach((g, i) => { g._i = i; });
    // Per glyph column, TWO row masks. Ink mask (m): rows whose fresh-canvas
    // prediction is provably non-white — one AND rejects the candidate when it
    // needs ink where the page is white. Dark mask (d): rows whose prediction
    // stays under the dark threshold for EVERY canvas state — the composite
    // law (cv·(256−e))>>8 is monotone in cv, so any composite predicts ≤ the
    // fresh-canvas byte, and quantMap is monotone — so q(pred)+t < 160 holds
    // whenever q(gb)+2·TOL < 160, and a page byte ≥ 160 (and not skip) at that
    // row makes tryCand reject for sure. Linear-law candidates keep d = 0:
    // their shift accumulation breaks the ≤-gb bound (no filter, no risk).
    const colBits = (g, colRel) => {                   // [inkM0, inkM1, darkM0, darkM1]
      let m0 = 0, m1 = 0, d0 = 0, d1 = 0;
      const linG = g.lin ?? set.linear;
      for (let k = 0; k < g.inkC.length; k++) {
        if (g.inkC[k] !== g.inkLeft + colRel) continue;
        const pred = quant ? quant[g.inkB[k]] : g.inkB[k];   // fresh-canvas prediction (lin: pred = gb, shifts cancel)
        if (pred > 254 - 2 * TOL) continue;
        const bit = g.dy + g.inkR[k] + ASC;
        if (bit >= 0 && bit < span) {
          if (bit < 32) m0 |= 1 << bit; else m1 |= 1 << (bit - 32);
          if (!linG && pred < 160 - 2 * TOL) {
            if (bit < 32) d0 |= 1 << bit; else d1 |= 1 << (bit - 32);
          }
        }
      }
      return [m0, m1, d0, d1];
    };
    const groups = new Map();
    // chain index (advance chaining): the same per-candidate column masks,
    // bucketed by ¼-px x-phase and then by dx+inkLeft — at a KNOWN pen only
    // ¼ of the pool applies, and of those only the ≤3 dx+inkLeft buckets whose
    // first ink column can land on the anchor are ever walked (a fixed pen
    // puts each glyph's first ink column at pi + that offset).
    const byPhase = [[], [], [], []];
    for (const g of cands) {
      const [m0, m1, d00, d01] = colBits(g, 0), [n0, n1, d10, d11] = colBits(g, 1);
      // dark masks ride on the candidate record (per-phy records, restamped
      // whenever this index rebuilds for a new quant/tol config) — grouping
      // stays on the ink masks alone, so the dark check is per member
      g._d00 = d00; g._d01 = d01; g._d10 = d10; g._d11 = d11;
      let grp = groups.get(m0 + ',' + m1);
      if (!grp) groups.set(m0 + ',' + m1, grp = { m0, m1, subs: new Map() });
      let sub = grp.subs.get(n0 + ',' + n1);
      if (!sub) grp.subs.set(n0 + ',' + n1, sub = { n0, n1, members: [] });
      sub.members.push(g);
      byPhase[Math.round(g.phx * 4) & 3].push({ g, m0, m1, n0, n1, d00, d01, d10, d11, d: g.dx + g.inkLeft });
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
    // unexplained-ink accounting starts at the BAND top, not the window top:
    // the window extends maxAsc above the baseline so tall candidates can be
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
    // Fused init: don't-care pre-absorb (object-mask pixels AND pixels another
    // line's scan already explained — a neighbouring line's descender/ascender
    // ink inside this window; at small line pitches adjacent lines' row ranges
    // overlap, so that ink is settled evidence of the OTHER line, not this
    // one's) + the per-column count of unexplained pixels (page ≠ q(canvas)),
    // maintained on every later canvas write — nextUnexplained becomes an
    // O(1)-amortized pointer walk instead of rescanning the whole band window
    // after every glyph (the rescan was 80%+ of read time on dense pages).
    // One row-major pass; rows the per-row flags prove carry no mask/explained
    // cells (the common case — probes on virgin bands) reduce to a bare
    // ink-count against q(255). Absorbed cells hold canvas = page and page
    // bytes are palette FIXPOINTS (quantMap's available set is read off the
    // page itself), so they can only count as unexplained under a foreign
    // QUANT — kept exact via the explicit QUANT[pv] check.
    const unexpl = new Int32Array(bw);
    {
      const g = page.gray, mRows = mask._rows, eRows = explained ? explained._rows : null;
      const q255 = QUANT ? QUANT[255] : 255;
      for (let y = y0; y < y1; y++) {
        const po = y * W, co = (y - y0) * bw - xFrom;
        const judged = y >= cTop && y < cBot;
        const hasM = mRows ? mRows[y] !== 0 : true;      // no flags → assume present
        const hasE = explained !== null && explained !== undefined && (eRows ? eRows[y] !== 0 : true);
        if (hasM || hasE) {
          for (let x = xFrom; x < xTo; x++) {
            if ((hasM && mask[po + x]) || (hasE && explained[po + x])) {
              const pv = g[po + x];
              canvas[co + x] = pv;
              skip[co + x] = 1;
              if (judged && QUANT && pv !== QUANT[pv]) unexpl[x - xFrom]++;
            } else if (judged && g[po + x] !== q255) unexpl[x - xFrom]++;
          }
        } else if (judged) {
          for (let x = xFrom; x < xTo; x++)
            if (g[po + x] !== q255) unexpl[x - xFrom]++;
        }
      }
    }
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
    let pm0 = 0, pm1 = 0, pq0 = 0, pq1 = 0;            // page-side ink + dark masks of the last colMask(x)
    const colMask = (x) => {
      pm0 = 0; pm1 = 0; pq0 = 0; pq1 = 0;
      for (let y = y0; y < y1; y++) {
        const v = page.gray[y * W + x], sk = skip[(y - y0) * bw + (x - xFrom)];
        if (v < 255 || sk) {
          const bit = y - baseTop;
          if (bit < 32) {
            pm0 |= 1 << bit;
            if (v < 160 || sk) pq0 |= 1 << bit;        // skip rows prove nothing → stay "dark-ok"
          } else if (bit < 64) {
            pm1 |= 1 << (bit - 32);
            if (v < 160 || sk) pq1 |= 1 << (bit - 32);
          }
        }
      }
    };

    // one candidate trial: glyph g at integer pen pi must explain the page
    // bytes through the blend law, with the anchor column inside its bbox.
    // ONE implementation shared by the chained-pen probe and the anchor-column
    // scan, so acceptance physics can never diverge between the two paths.
    const tryCand = (g, pi, col) => {
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
    let flVis = null, flGen = 0;            // flood visited map (lazy, generation-stamped)
    const accepted = new Set();                          // "ch@pen" — never re-accept
    let cursor = xFrom;
    let chainPenQ = null;                   // expected next pen (¼-px units) after an accept
    const mk = new Int32Array(16);          // chain-probe column masks, cols col-2..col+1
                                            // (4 ints per column: ink m0/m1, dark q0/q1)
    while (glyphs.length < maxGlyphs) {
      const col = nextUnexplained(cursor);
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
        for (let i = 0; i < 4; i++) {                    // page masks, cols col-2..col+1
          const x = col - 2 + i;
          if (x < xFrom || x >= xTo) { mk[4 * i] = -1; mk[4 * i + 1] = -1; mk[4 * i + 2] = -1; mk[4 * i + 3] = -1; }
          else { colMask(x); mk[4 * i] = pm0; mk[4 * i + 1] = pm1; mk[4 * i + 2] = pq0; mk[4 * i + 3] = pq1; }
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
            const ai = 4 * (f - col + 2);
            const a0 = mk[ai], a1 = mk[ai + 1], aq0 = mk[ai + 2], aq1 = mk[ai + 3];
            const b0 = mk[ai + 4], b1 = mk[ai + 5], bq0 = mk[ai + 6], bq1 = mk[ai + 7];
            const s = col - f;
            for (const c of bucket) {
              if ((c.m0 & ~a0) | (c.m1 & ~a1)) continue; // needs ink where page is white
              if ((c.n0 & ~b0) | (c.n1 & ~b1)) continue;
              if ((c.d00 & ~aq0) | (c.d01 & ~aq1) | (c.d10 & ~bq0) | (c.d11 & ~bq1)) continue;
              const r = tryCand(c.g, pi, col);
              if (!r) continue;
              if (!slot[s] || r.score > slot[s].score ||
                  (r.score === slot[s].score && c.g._i < slot[s].g._i)) slot[s] = r;
            }
          }
        }
        best = slot[0] ?? slot[1] ?? slot[2];
      }
      // candidates whose first ink column lands on col (or col-1/-2: composite
      // columns can hide the true left edge when bytes saturate)
      if (!best)
      for (let back = 0; back <= 2; back++) {
        if (col - back < xFrom) break;                 // every candidate's bbox starts left of the window
        colMask(col - back);                           // page ink+dark+skip rows at the anchor column
        const a0 = pm0, a1 = pm1, aq0 = pq0, aq1 = pq1;
        let b0 = -1, b1 = -1, bq0 = -1, bq1 = -1;      // second column; all-ones when outside the window
        if (col - back + 1 < xTo) { colMask(col - back + 1); b0 = pm0; b1 = pm1; bq0 = pq0; bq1 = pq1; }
        for (const grp of grpList) {
        if ((grp.m0 & ~a0) | (grp.m1 & ~a1)) continue;     // group needs ink where the page is white
        for (const sub of grp.subs) {
        if ((sub.n0 & ~b0) | (sub.n1 & ~b1)) continue;
        for (const g of sub.members) {
          // dark prefilter (see anchorGroups): needs dark where the page never is
          if ((g._d00 & ~aq0) | (g._d01 & ~aq1) | (g._d10 & ~bq0) | (g._d11 & ~bq1)) continue;
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
        // (the visited map is a reusable generation-stamped Int32Array over the
        // window — the old per-fail Set of packed keys dominated wrong-hypothesis
        // scans, where every ink column of a long unmatched blob fails in turn
        // and re-floods the component's survivors)
        let compRight = col;
        if (flVis === null) flVis = new Int32Array(bw * bh);
        flGen++;
        const comp = [], stack = [];
        for (let y = cTop; y < cBot; y++)
          if (pageAt(col, y) !== q(canAt(col, y)) && !masked(col, y)) stack.push(col << 16 | y);
        while (stack.length) {
          const k = stack.pop();
          const px = k >> 16, py = k & 0xffff;
          const ci = (py - y0) * bw + (px - xFrom);
          if (flVis[ci] === flGen) continue;
          flVis[ci] = flGen;
          comp.push(k);
          if (px > compRight) compRight = px;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < xFrom || nx >= xTo || ny < cTop || ny >= cBot ||
                flVis[(ny - y0) * bw + (nx - xFrom)] === flGen) continue;
            if (pageAt(nx, ny) < 255 && !masked(nx, ny) && pageAt(nx, ny) !== q(canAt(nx, ny)))
              stack.push(nx << 16 | ny);
          }
        }
        for (const k of comp) {
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
        if (col > failGuard) records.push({ col, comp });
        failGuard = Math.max(failGuard, compRight);
        cursor = col;
        if (fails.length + records.length >= maxFails) break;
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
    // Page-level detection (objects, bands, palette map) is pure in the page
    // pixels — memoized on the page object so the app's escalating multi-pass
    // ladder (up to 7 readPage calls on the SAME page when nothing reads) pays
    // for it once. Keyed on the gray buffer's identity: a caller that
    // re-rasterizes or whitens anew gets a fresh compute.
    let det = page._det;
    if (!det || det.gray !== page.gray) {
      const d = detectObjects(page);
      det = page._det = { gray: page.gray, mask: d.mask, objects: d.objects,
        bands: findBands(page, d.mask), quant: null };
    }
    // opts.quant: true derives the map from the page histogram (quantMap); a
    // 256-entry LUT is applied as-is — for producers whose true palette is
    // known (the bench reads it from the PDF's /Indexed colorspace).
    const quant = opts?.quant
      ? (opts.quant.length === 256 ? opts.quant : (det.quant ??= quantMap(page)))
      : null;
    const q = quant ? v => quant[v] : v => v;
    const { mask, objects } = det;
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
    const bands = det.bands;
    const lines = [];
    // ink already explained by an earlier line's scan window: a line without
    // descenders but with '_' glyphs leaves the '_' strokes (rows baseline+2..3)
    // as their own blank-row-separated band, though the line's scan (which spans
    // baseline+maxDesc) read and reported them — such a band is not a □
    const explained = new Uint8Array(page.w * page.h);
    explained._rows = new Uint8Array(page.h);  // per-row flags for scanLine's fused init
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
      // non-glyph ink BELOW the text (an unmasked box-corner fringe, a stray
      // remnant row) stretches the band bottom past baseline+maxDesc and the
      // sweep above never reaches the true baseline (P2 y416 "Jean Luc
      // Brunel" between redactions). Second chance, deeper floor — only
      // bands the primary sweep failed pay for it, so existing picks are
      // untouched.
      if (!pick)
        for (const set of sets)
          for (const phy of set.byPhy.keys())
            for (let yb = bot - set.maxDesc - 1; yb >= bot - set.maxDesc - 3 && yb > top; yb--) {
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
        let inkN = 0, runMax = 0, iy0 = bot, iy1 = top;
        for (let y = top; y < bot; y++) {
          const off = y * page.w;
          let run = 0;
          for (let x = x0; x <= x1; x++) {
            if (page.gray[off + x] < 255 && !mask[off + x]) {
              inkN++;
              if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
              if (++run > runMax) runMax = run;
              if (fragOnly &&
                  !halos.some(h => x >= h[0] && x < h[1] && y >= h[2] && y < h[3])) fragOnly = false;
            } else run = 0;
          }
        }
        // graphic residue too sparse for the dust mask's swarm rule (a couple
        // of 1-2px specks stranded in an otherwise empty band — whitened
        // emblem leftovers): a handful of short-run pixels SPARSE over the
        // band's ink bbox is noise, not a □. Density keeps honest failures
        // honest — a compact unreadable blob fills its bbox and stays a □.
        const dustOnly = inkN > 0 && inkN <= 12 && runMax <= 4 &&
          (inkN <= 2 || (x1 - x0 + 1) * (iy1 - iy0 + 1) >= 20 * inkN);
        if (dustOnly) return;                    // not content: emit nothing
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
              !deadSet.has(x << 16 | y)) {
            explained[y * page.w + x] = 1;
            explained._rows[y] = 1;
          }
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
    CHAIN_PROBES, scanLine, probeBaseline, spaceCalib, readPage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OCREngine = api;
})(typeof self !== 'undefined' ? self : this);

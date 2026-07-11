// blindocr.js — self-calibrating byte-exact OCR core for the app (DOM-free,
// browser port of bench/blind-read.mjs). No layout constants: ink bands,
// per-band baseline/y-phase/font pinning, a left→right composite-aware scan
// against fontgen glyph rasters, non-text object detection (redaction boxes,
// rules/underlines), and spaces measured from pen gaps.
//
// In-app certificate: a line is CLEAN when the scan explained every non-object
// ink pixel of its band byte-exactly through the proven blend law
// (dst = (dst·(256−e))>>8, e = cov + (cov>>7)) — fails = 0 and residual = 0.
// (The bench's MuPDF re-render cross-check lives in bench/blind-read.mjs
// --verify; this is the same composition law applied in reverse.)
//
// Glyph sets come from bench/glyphs_*.json (export_glyphs.py — pure synthetic
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
        if (!byPhy.has(phy)) byPhy.set(phy, []);
        byPhy.get(phy).push({ ch, adv: rec.adv, phx, w: r.w, h: r.h, dx: r.dx, dy: r.dy,
          bytes, ink, inkLeft });
        maxAsc = Math.max(maxAsc, -r.dy);
        maxDesc = Math.max(maxDesc, r.dy + r.h);
      }
    }
    return { name, sizePx: json.size_px, byPhy, maxAsc, maxDesc };
  }

  let _sets = null;
  async function loadSets(urls) {
    if (_sets) return _sets;
    const out = [];
    for (const u of urls ?? ['bench/glyphs_times16.json', 'bench/glyphs_arial16.json', 'bench/glyphs_georgia16.json']) {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) continue;
        out.push(parseSet(await r.json(), u.replace(/^.*glyphs_|\.json$/g, '')));
      } catch { /* set not exported locally — skip */ }
    }
    _sets = out;
    return out;
  }

  // ---- non-text objects (rules, redaction boxes) ----
  function detectObjects(page) {
    const { w, h, gray } = page;
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
    const objects = [];
    for (const r of rows) {
      const o = objects.find(o => o.y1 === r.y &&
        Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.8 * Math.min(o.x1 - o.x0, r.x1 - r.x0));
      if (o) { o.y1 = r.y + 1; o.x0 = Math.min(o.x0, r.x0); o.x1 = Math.max(o.x1, r.x1); }
      else objects.push({ y0: r.y, y1: r.y + 1, x0: r.x0, x1: r.x1 });
    }
    const mask = new Uint8Array(w * h);
    for (const o of objects) {
      o.type = o.y1 - o.y0 <= 4 ? 'rule' : 'box';
      for (let y = Math.max(0, o.y0 - 2); y < Math.min(h, o.y1 + 2); y++)
        for (let x = Math.max(0, o.x0 - 2); x < Math.min(w, o.x1 + 2); x++)
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

  // ---- the scanner (see bench/blind-read.mjs for the full derivation) ----
  function scanLine(page, mask, set, phy, baseline, xFrom, xTo, maxGlyphs, maxFails) {
    if (maxGlyphs === undefined) maxGlyphs = Infinity;
    if (maxFails === undefined) maxFails = Infinity;
    const W = page.w, cands = set.byPhy.get(phy) ?? [];
    const y0 = Math.max(0, baseline - set.maxAsc), y1 = Math.min(page.h, baseline + set.maxDesc);
    const bw = xTo - xFrom, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return { glyphs: [], fails: [], residual: 0 };
    const canvas = new Float32Array(bw * bh).fill(255);
    const pageAt = (x, y) => page.gray[y * W + x];
    const masked = (x, y) => mask[y * W + x];
    const canAt = (x, y) => canvas[(y - y0) * bw + (x - xFrom)];
    const setCan = (x, y, v) => { canvas[(y - y0) * bw + (x - xFrom)] = v; };
    for (let y = y0; y < y1; y++)
      for (let x = xFrom; x < xTo; x++)
        if (mask[y * W + x]) setCan(x, y, pageAt(x, y));

    const nextUnexplained = (fromX) => {
      for (let x = fromX; x < xTo; x++)
        for (let y = y0; y < y1; y++)
          if (pageAt(x, y) !== canAt(x, y)) return x;
      return -1;
    };

    const glyphs = [], fails = [];
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
          if (accepted.has(g.ch + '@' + (pi + g.phx))) continue;
          let exact = 0, pending = 0, skipped = 0, ok = true;
          for (const p of g.ink) {
            const rr = (p / g.w) | 0, cc = p % g.w;
            const x = gx + cc, y = gy + rr;
            if (masked(x, y)) { skipped++; continue; }
            const gb = g.bytes[p], pv = pageAt(x, y), cv = canAt(x, y);
            let hit = false, minPred = 256;
            for (const e of INV[gb]) {
              const pred = (cv * (256 - e)) >> 8;
              if (pred < minPred) minPred = pred;
              if (pred === pv) { hit = true; break; }
            }
            if (hit) exact++;
            else if (pv < minPred) pending++;
            else { ok = false; break; }
          }
          const considered = g.ink.length - skipped;
          if (!ok || considered < g.ink.length * 0.5 ||
              exact < considered * 0.5 || pending > considered * 0.35) continue;
          if (col < gx || col >= gx + g.w) continue;
          const score = exact - pending * 0.25;
          if (!best || score > best.score) best = { g, pi, gx, gy, exact, pending, score };
        }
      }
      if (!best) {
        if (!fails.length || col > fails[fails.length - 1] + 4) fails.push(col);
        let x = col;
        for (; x < xTo; x++) {
          let anyInk = false;
          for (let y = y0; y < y1; y++) {
            if (pageAt(x, y) < 255) anyInk = true;
            setCan(x, y, pageAt(x, y));
          }
          if (!anyInk && x > col) break;
        }
        cursor = x;
        if (fails.length >= maxFails) break;
        continue;
      }
      const { g, pi, gx, gy } = best;
      for (const p of g.ink) {
        const rr = (p / g.w) | 0, cc = p % g.w;
        const x = gx + cc, y = gy + rr;
        if (masked(x, y)) continue;
        const gb = g.bytes[p], pv = pageAt(x, y), cv = canAt(x, y);
        let val = null;
        for (const e of INV[gb]) {
          const pred = (cv * (256 - e)) >> 8;
          if (pred === pv) { val = pv; break; }
          if (val === null) val = pred;
        }
        setCan(x, y, val);
      }
      glyphs.push({ ch: g.ch, pen: pi + g.phx, adv: g.adv, exact: best.exact, pending: best.pending });
      accepted.add(g.ch + '@' + (pi + g.phx));
      cursor = col + 1;
    }
    // coverage certificate: any non-object band pixel the composition law
    // could not reproduce byte-exactly?
    let residual = 0;
    for (let y = y0; y < y1; y++)
      for (let x = xFrom; x < xTo; x++)
        if (!masked(x, y) && pageAt(x, y) !== canAt(x, y)) residual++;
    return { glyphs, fails, residual };
  }

  function probeBaseline(page, mask, set, phy, baseline, x0, x1) {
    const line = scanLine(page, mask, set, phy, baseline, x0, Math.min(x1, x0 + 160), 4, 2);
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
      text += entries[i].ch;
    }
    return { entries, text };
  }

  // ---- per-page driver ----
  // page: {w, h, gray} (the engine's own buffer — Float32 with integral values
  // on native gray pages). opts.progress(done, total) is called between bands;
  // the read yields to the event loop every few bands so the UI stays alive.
  async function readPage(page, sets, opts) {
    const { mask, objects } = detectObjects(page);
    const bands = findBands(page, mask);
    const lines = [];
    let n = 0;
    for (const [top, bot] of bands) {
      if (++n % 6 === 0) {
        opts?.progress?.(n, bands.length);
        await new Promise(r => setTimeout(r, 0));
      }
      let x0 = page.w, x1 = 0;
      for (let y = top; y < bot; y++) {
        const off = y * page.w;
        for (let x = 0; x < page.w; x++)
          if (page.gray[off + x] < 255 && !mask[off + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      }
      const lineObjects = objects.filter(ob => ob.y0 < bot + 4 && ob.y1 > top - 4);
      let pick = null;
      for (const set of sets)
        for (const phy of set.byPhy.keys())
          for (let yb = bot; yb >= bot - set.maxDesc && yb > top; yb--) {
            const score = probeBaseline(page, mask, set, phy, yb, Math.max(0, x0 - 2), Math.min(page.w, x1 + 20));
            if (score > 0 && (!pick || score > pick.score)) pick = { set, phy, yb, score };
          }
      if (!pick) {
        lines.push({ top, bot, baseline: null, glyphs: [], fails: x1 >= x0 ? [x0] : [],
          residual: 0, boxes: lineObjects.map(ob => [ob.x0 - 2, ob.x1 + 2]), objects: lineObjects, set: null });
        continue;
      }
      const L = scanLine(page, mask, pick.set, pick.phy, pick.yb,
        Math.max(0, x0 - 2), Math.min(page.w, x1 + 4));
      L.top = top; L.bot = bot; L.baseline = pick.yb; L.phy = pick.phy;
      L.set = pick.set; L.font = pick.set.name;
      L.boxes = lineObjects.map(ob => [ob.x0 - 2, ob.x1 + 2]);
      L.objects = lineObjects;
      L.clean = L.fails.length === 0 && L.residual === 0;
      lines.push(L);
    }
    const spaceAdv = spaceCalib(lines);
    for (const L of lines) {
      const { entries, text } = lineEntries(L, spaceAdv);
      L.entries = entries; L.text = text;
    }
    return { lines, objects, spaceAdv };
  }

  const api = { loadSets, parseSet, readPage, detectObjects, findBands, scanLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlindOCR = api;
})(typeof self !== 'undefined' ? self : this);

// ocr.js — glyph templates + pixel primitives. `TemplateEngine` loads the
// natural-size templates, holds the whole page as one grayscale buffer, and serves
// exact-size crops (cropPixels) and blank-cell tests (isBlank). The glyph-picking
// loop (matchAt) lives on CanvasViewer in training.js; the line reading lives in
// reader.js.
//
// Loaded after core.js, before reader.js and training.js. Relies on these core.js
// globals: stemToChar, TEMPLATE_LEFT_CROP, gray, isBlankPixels. Defines the
// `TemplateEngine` global that CanvasViewer (training.js) instantiates, plus the
// `CanvasViewerTemplates` loading mixin.


// ---------------------------------------------------------------------------
// TemplateEngine — natural-size glyph templates + exact-size page crops/blank tests
// ---------------------------------------------------------------------------
class TemplateEngine {
  constructor() {
    this.templates = []; // [{char, filename, w, h, pixels: Float32Array(w*h), metric}]
    this.metrics = null;         // parsed template_metrics.json (or null)
    this.metricsFontSpec = null; // fontSpec the metrics were measured under
    this._sizes = new Map();
    this._c = document.createElement('canvas');
    this._ctx = this._c.getContext('2d', { willReadFrequently: true });
    this._page = null;    // { w, h, gray: Float32Array(w*h) } — whole-page grayscale
    this._pageImg = null; // the img the buffer was built from (identity key)
  }

  _extractGray(img, char, filename) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, w, h);
    return { char, filename, w, h, pixels: gray(ctx.getImageData(0, 0, w, h).data, w * h) };
  }

  _loadGray(url, char, filename) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(this._extractGray(img, char, filename));
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async loadFromHTTP(manifest) {
    const tasks = manifest.map(({ filename, char }) => this._loadGray(`/templates/${filename}`, char, filename));
    const metrics = fetch('/templates/template_metrics.json')
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    const count = await this._setTemplates(tasks);
    this.applyMetrics(await metrics);
    return count;
  }

  async loadFromDir(dirHandle) {
    const tasks = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.png') || name.includes('unmatched')) continue;
      const char = stemToChar(name.slice(0, -4));
      if (!char || char.length !== 1) continue;
      tasks.push(handle.getFile().then(async f => {
        const bmp = await createImageBitmap(f);
        return this._extractGray(bmp, char, name);
      }).catch(() => null));
    }
    const metrics = dirHandle.getFileHandle('template_metrics.json')
      .then(h => h.getFile()).then(f => f.text()).then(JSON.parse).catch(() => null);
    const count = await this._setTemplates(tasks);
    this.applyMetrics(await metrics);
    return count;
  }

  // Attach the measured per-template metrics (bench/measure-metrics.mjs output) to the
  // loaded templates, keyed by filename: each template gains `metric` =
  // { advanceWidth, anchor, anchorRange, … } or null. The reader only trusts them
  // when the metrics' fontSpec matches the live Config (see reader.js _metric), so
  // stale metrics degrade to the unguided reader, never to wrong placement.
  applyMetrics(json) {
    this.metrics = json || null;
    this.metricsFontSpec = json?.fontSpec ?? null;
    const rows = new Map((json?.templates ?? []).map(r => [r.filename, r]));
    for (const t of this.templates) t.metric = rows.get(t.filename) ?? null;
  }

  // Await all load tasks, drop failures, and index by size. Grouping crops by
  // distinct w×h keeps full-page OCR fast. Within a group each template is also
  // indexed by pixel hash — exact (`map`) and poke-tolerant (`pokeMap`, hash skipping
  // col 0 of row 0) — so matchAt finds candidates by one Map lookup per crop instead
  // of comparing against every template of the size (pixelsEqual was ~half of OCR).
  async _setTemplates(tasks) {
    this.templates = (await Promise.all(tasks)).filter(Boolean);
    this._sizes = new Map();
    for (const t of this.templates) {
      const k = t.w + 'x' + t.h;
      let g = this._sizes.get(k);
      if (!g) {
        g = { w: t.w, h: t.h, list: [], map: new Map(), pokeMap: new Map(),
          mapCM: new Map(), pokeMapCM: new Map(), stainMapCM: new Map() };
        this._sizes.set(k, g);
      }
      g.list.push(t);
      const h = hashPixels(t.pixels, 0);
      (g.map.get(h) ?? g.map.set(h, []).get(h)).push(t);
      const hp = hashPixels(t.pixels, 1);
      (g.pokeMap.get(hp) ?? g.pokeMap.set(hp, []).get(hp)).push(t);
      // Stain-tolerant index (matchAt pass 3): hash skipping the bottom 3 rows and,
      // for w ≥ 4, the 2×2 top-left corner — see hashPixelsCMStain in core.js.
      // A template whose ink lives entirely inside the stain rows ('_') must not
      // join the index: a bare box edge would stain-match it out of thin air.
      let inkAboveStain = false;
      for (let i = 0, n = (t.h - 3) * t.w; i < n && !inkAboveStain; i++)
        if (t.pixels[i] < 255) inkAboveStain = true;
      if (inkAboveStain) {
        const hs = hashPixelsCMStain(t.pixels, t.w, t.h, t.w >= 4);
        (g.stainMapCM.get(hs) ?? g.stainMapCM.set(hs, []).get(hs)).push(t);
      }
      // Column-major indexes for matchAt's incremental probe hashing: one hash
      // chain per template HEIGHT covers every width as a checkpoint, so a probe
      // hashes maxW×h pixels once instead of w×h per size group. Same buckets in
      // spirit as map/pokeMap — equal pixels hash equal in any fixed order, and
      // full pixel equality still confirms every candidate — just keyed in the
      // order an incremental column sweep produces.
      const hc = hashPixelsCM(t.pixels, t.w, t.h, 0);
      (g.mapCM.get(hc) ?? g.mapCM.set(hc, []).get(hc)).push(t);
      const hcp = hashPixelsCM(t.pixels, t.w, t.h, 1);
      (g.pokeMapCM.get(hcp) ?? g.pokeMapCM.set(hcp, []).get(hcp)).push(t);
    }
    // One chain plan per distinct height: the widths present (any order — matchAt
    // indexes checkpoints by width) and reusable checkpoint slots hE/hP, where
    // index w holds the chain hash after sweeping the window's first w columns.
    this._chainPlans = new Map();
    for (const g of this._sizes.values()) {
      let plan = this._chainPlans.get(g.h);
      if (!plan) { plan = { h: g.h, maxW: 0 }; this._chainPlans.set(g.h, plan); }
      plan.maxW = Math.max(plan.maxW, g.w);
    }
    for (const plan of this._chainPlans.values()) {
      plan.hE = new Int32Array(plan.maxW + 1);
      plan.hP = new Int32Array(plan.maxW + 1);
      plan.hSB = new Int32Array(plan.maxW + 1); // stain: skip bottom row
      plan.hSC = new Int32Array(plan.maxW + 1); // stain: skip bottom row + 2×2 corner
    }
    return this.templates.length;
  }

  // Read the whole source into one grayscale Float32Array, once per page. Every
  // crop then indexes into this buffer instead of a per-probe drawImage+
  // getImageData — the canvas readback that dominated OCR. Cached by img identity
  // (a new page is a new canvas), so it rebuilds automatically when the page
  // changes. A 1:1 blit of the full image is byte-identical to blitting any
  // sub-rectangle of it, so crops stay pixel-exact (see cropPixels).
  _pageFor(img) {
    if (this._pageImg === img && this._page) return this._page;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (this._c.width !== w) this._c.width = w;
    if (this._c.height !== h) this._c.height = h;
    this._ctx.imageSmoothingEnabled = false;
    this._ctx.clearRect(0, 0, w, h);
    this._ctx.drawImage(img, 0, 0, w, h);
    this._page = { w, h, gray: gray(this._ctx.getImageData(0, 0, w, h).data, w * h) };
    this._pageImg = img;
    return this._page;
  }

  // RGBA of the current page if it came through a real canvas draw — null for
  // seeded cache pages ({width,height} stand-ins never touch the canvas). The
  // blind reader uses it to spot colored ink exactly (R≠G≠B per pixel); see
  // BlindOCR.whitenColored.
  pageRGBA(img) {
    if (!img || (img.getContext === undefined && img.naturalWidth === undefined)) return null;
    const page = this._pageFor(img);
    if (this._c.width !== page.w || this._c.height !== page.h) return null;
    try { return this._ctx.getImageData(0, 0, page.w, page.h).data; } catch { return null; }
  }

  // Grayscale crop of the source at native (w×h) — no resampling, so a
  // previously-cut glyph re-read at the same place is pixel-identical. Indexes
  // the whole-page buffer (_pageFor) rather than reading the canvas per crop.
  // Source pixel (round(sx)+col, round(sy)+row); the Math.round mirrors the old
  // drawImage rounding so this stays byte-identical. Pixels outside the page read
  // as 0 — the old path cleared the crop canvas first, so off-page columns/rows
  // came back transparent (gray 0) too.
  cropPixels(img, sx, sy, w, h) {
    const page = this._pageFor(img);
    const PW = page.w, PH = page.h, g = page.gray;
    const x0 = Math.round(sx), y0 = Math.round(sy);
    const out = new Float32Array(w * h);
    // Fast path: the crop sits entirely inside the page (the common case).
    if (x0 >= 0 && y0 >= 0 && x0 + w <= PW && y0 + h <= PH) {
      for (let row = 0; row < h; row++) {
        let src = (y0 + row) * PW + x0, dst = row * w;
        for (let col = 0; col < w; col++) out[dst + col] = g[src + col];
      }
      return out;
    }
    // Edge path: leave off-page pixels at 0.
    for (let row = 0; row < h; row++) {
      const syR = y0 + row;
      if (syR < 0 || syR >= PH) continue;
      const base = syR * PW, dst = row * w;
      for (let col = 0; col < w; col++) {
        const sxC = x0 + col;
        if (sxC >= 0 && sxC < PW) out[dst + col] = g[base + sxC];
      }
    }
    return out;
  }

  // Glyph identification (matchAt) — the loop that picks which template wins at a
  // position — now lives on CanvasViewer in training.js, where it's easy to rework.
  // The engine keeps the data it needs (templates grouped by size in _sizes) and
  // the crop/blank primitives below.

  isBlank(img, sx, sy, w, h) {
    // In-page windows take the strided test straight off the page buffer — same
    // floats, same mean/L2 accumulation order as isBlankPixels on a cropPixels
    // copy, so the same decision, without the per-column allocation + copy
    // (_nextInk calls this once per white column walked).
    const page = this._pageFor(img);
    const x0 = Math.round(sx + TEMPLATE_LEFT_CROP), y0 = Math.round(sy);
    if (x0 >= 0 && y0 >= 0 && x0 + w <= page.w && y0 + h <= page.h)
      return isBlankStrided(page.gray, page.w, x0, y0, w, h);
    const px = this.cropPixels(img, sx + TEMPLATE_LEFT_CROP, sy, w, h);
    return isBlankPixels(px);
  }
}


// ---------------------------------------------------------------------------
// CanvasViewerTemplates — template-loading glue, mixed onto CanvasViewer.prototype
// by the Object.assign at the bottom of training.js. These run as CanvasViewer
// methods (`this` is the viewer): they drive `this.engine` and report into
// `this.infoEl`. The reading layer that consumes the loaded templates is in
// reader.js (CanvasViewerReader).
// ---------------------------------------------------------------------------
const CanvasViewerTemplates = {
  // Fetch the served template manifest and load it. Returns the number loaded
  // (0 when not served over HTTP or the manifest is empty); throws are the
  // caller's to swallow.
  async _loadTemplatesFromHTTP() {
    const res = await fetch('/api/templates');
    if (!res.ok) return 0;
    const manifest = await res.json();
    if (!manifest.length) return 0;
    return this.engine.loadFromHTTP(manifest);
  },

  async autoLoadTemplatesFromHTTP() {
    try {
      const count = await this._loadTemplatesFromHTTP();
      if (count) this.infoEl.textContent = `Loaded ${count} templates. Drag a line's anchor, then OCR Page.`;
    } catch { /* not served over HTTP — use Load Templates */ }
  },

  async loadTemplates() {
    if (!window.showDirectoryPicker) {
      this.infoEl.textContent = 'showDirectoryPicker not supported — use Chrome or Edge.';
      return;
    }
    let dirHandle;
    try { dirHandle = await window.showDirectoryPicker({ mode: 'read' }); }
    catch { return; }
    const count = await this.engine.loadFromDir(dirHandle);
    this.infoEl.textContent = count ? `Loaded ${count} templates.` : 'No valid templates in that folder.';
  },

  async reloadTemplates() {
    if (this.dirHandle) { await this.engine.loadFromDir(this.dirHandle); return; }
    try { await this._loadTemplatesFromHTTP(); } catch { /* ignore */ }
  },
};

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// core.js (loaded first) attaches the DOM-free helpers used below as globals:
// charToStem, stemToChar, STEM_TO_CHAR, EXACT_MATCH, BLANK_STDDEV,
// TEMPLATE_LEFT_CROP, PLACEHOLDER, makeRowBands, gray, stats, isBlankPixels,
// pixelsEqual.
//
// ocr.js (loaded next) defines the TemplateEngine class — the glyph-matching
// OCR engine that CanvasViewer instantiates below.


// ---------------------------------------------------------------------------
// Config — manual layout (works for any font / page layout)
// ---------------------------------------------------------------------------
class Config {
  constructor() {
    // Horizontal lines (text rows)
    this.rowBase = 40;     // Y of the first row's top edge
    this.rowHeight = 15;   // height of each row band
    this.rowPitch = 18;    // vertical distance between consecutive rows
    this.rowCount = 54;    // number of rows

    // Font used to derive each character's cutout width
    this.fontFamily = 'Times New Roman';
    this.fontSize = 16;    // px, in image space — tune until widths match the scan

    this.startX = 64;      // default X of each row's draggable start anchor
  }

  get fontSpec() { return `${this.fontSize}px ${this.fontFamily}`; }

  makeRowBands() {
    return makeRowBands(this.rowBase, this.rowHeight, this.rowPitch, this.rowCount);
  }
}


// ---------------------------------------------------------------------------
// PDF embedded-image extraction
// ---------------------------------------------------------------------------
async function extractEmbeddedImages(page) {
  const ops = await page.getOperatorList();
  const canvases = [];
  const seen = new Set();
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject &&
        ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObjectRepeat &&
        ops.fnArray[i] !== pdfjsLib.OPS.paintJpegXObject) continue;
    const imageName = ops.argsArray[i][0];
    if (seen.has(imageName)) continue;
    seen.add(imageName);
    const img = await new Promise(resolve => page.objs.get(imageName, resolve));
    if (!img) continue;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (img.bitmap) {
      ctx.drawImage(img.bitmap, 0, 0);
    } else if (img.data) {
      const imageData = new ImageData(
        new Uint8ClampedArray(img.data.buffer ?? img.data),
        img.width, img.height
      );
      ctx.putImageData(imageData, 0, 0);
    } else continue;
    canvases.push(canvas);
  }
  return canvases;
}


// ---------------------------------------------------------------------------
// CanvasViewer
// ---------------------------------------------------------------------------
class CanvasViewer {
  constructor(canvas, wrap, infoEl, config) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.wrap = wrap;
    this.infoEl = infoEl;
    this.config = config;

    this.img = null;
    this.rowBands = config.makeRowBands();
    this.filename = '';

    this.tx = 0; this.ty = 0; this.scale = 1;
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.txStart = { tx: 0, ty: 0 };
    this.dirHandle = null;

    // Per-row line state. Every row owns a draggable start anchor (rowStartX)
    // and its own transcription (rowText); activeRow is the one being edited.
    this.activeRow = 0;
    this.rowStartX = [];   // x of each row's start anchor
    this.rowText = [];     // text per row (typed or OCR'd)
    this.rowScores = [];   // per-char match score (1.0 exact / 0 placeholder, null = manual/blank)
    this.rowMode = [];     // 'ocr' | 'manual' | undefined, per row
    this.rowStopX = [];    // image x of the glyph an OCR row stopped on (anchors its trailing □)
    this.allBoxes = [];    // [{char, x0, x1, y0, y1, score, row, i}] for every row
    this._hoverKey = null; // "row:i" of the box under the cursor
    this._dragAnchorRow = -1; // row whose anchor is currently being dragged

    this.engine = new TemplateEngine();

    this.initEvents();
  }

  initEvents() {
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.resize();

    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    window.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', e => this.onMouseUp(e));
    this.canvas.addEventListener('dblclick', e => this._extractAtEvent(e));
  }

  resize() {
    this.canvas.width = this.wrap.clientWidth;
    this.canvas.height = this.wrap.clientHeight;
    this.render();
  }

  // ------------------------------------------------------------------
  // Image loading
  // ------------------------------------------------------------------
  loadCanvas(canvas, label) {
    this.img = canvas;
    this.filename = label;
    this.resetLine();
    this.autoAnchorRows(); // place each row's start anchor at its first inked column
    this.updateInfo();
    this.resetFit();
    const li = document.getElementById('line-input');
    if (li) li.value = '';
  }

  resetLine() {
    this.activeRow = 0;
    this.rowStartX = [];
    this.rowText = [];
    this.rowScores = [];
    this.rowMode = [];
    this.rowStopX = [];
    this.rowPens = [];        // per row: blind-OCR entries [{ch,pen,adv,score,i}] or undefined
    this.blindObjects = null; // page-level non-text objects from blind OCR
    this.allBoxes = [];
    this._hoverKey = null;
    this.ensureRows();
  }

  // Make sure every current row has a start anchor + text/score slots.
  // Auto (blind) OCR may install MORE measured bands than the configured grid
  // has rows — never truncate those away.
  ensureRows() {
    const n = Math.max(this.config.rowCount, this.rowBands.length);
    for (let i = 0; i < n; i++) {
      if (this.rowStartX[i] === undefined) this.rowStartX[i] = this.config.startX;
      if (this.rowText[i] === undefined) this.rowText[i] = '';
      if (this.rowScores[i] === undefined) this.rowScores[i] = [];
    }
    this.rowStartX.length = n;
    this.rowText.length = n;
    this.rowScores.length = n;
    this.rowMode.length = n;
    this.rowStopX.length = n;
    if (this.activeRow >= n) this.activeRow = n - 1;
    if (this.activeRow < 0) this.activeRow = 0;
  }

  setActiveRow(r) {
    this.activeRow = r;
    this.rebuildBoxes();
    this.render();
    const li = document.getElementById('line-input');
    if (li) { li.value = this.rowText[r] ?? ''; li.focus(); }
  }

  // ------------------------------------------------------------------
  // Templates + OCR
  //
  // The OCR methods live in two mixins, both Object.assign'd onto this prototype
  // at the bottom of this file (so `this` is the viewer, the line/font settings
  // stay here):
  //   • ocr.js    — CanvasViewerTemplates: template loading
  //                 (autoLoadTemplatesFromHTTP, loadTemplates, reloadTemplates).
  //   • reader.js — CanvasViewerReader: line reading, spacing & alignment
  //                 (ocrRow, ocrAllRows, rescoreManualRow, refreshOcrAfterSave,
  //                 _reportConfidence, plus the _nextInk / _matchNear helpers).
  // ------------------------------------------------------------------

  // Identify the glyph at image column sx, row-band top sy.
  //
  // Two bugs in the old "first exact match wins" rule are fixed here:
  //
  // Bug 2 (double letter): a narrow template (e.g. i) can exactly match a slice of a
  // wider glyph, so pass 1 collects ALL exact matches and returns the widest — the
  // widest exact match is the one whose template truly owns this position.
  //
  // Bug 1 (poke-left): uppercase T V W Y … sometimes have their top row extend 1px
  // further left than the template's bounding box, changing the anti-aliased edge pixel
  // at col 0 of row 0. No whole-crop shift can align both the shifted top row and the
  // unchanged body rows at the same time, so pass 2 retries with poke-left tolerance:
  // rows 1..h-1 must match exactly; row 0 cols 1..w-1 must match exactly; col 0 of row
  // 0 is allowed to differ. Widest poke-tolerant match wins; exact always beats poke.
  //
  // Pass 3 (stain tolerance): a redaction box overlapping the band from below covers
  // the bottom rows of every glyph of that line (full black plus an anti-aliased
  // edge row), and a box in the band below draws its AA edge line through row h−1 —
  // either way the bottom 3 rows (the POKE_CROP margin) can be stained. A left
  // neighbour's overhang (an f hook before = or <) can likewise stain the window's
  // 2×2 top-left corner beyond what the harvested variant saw. Stained pixels only
  // ever get DARKER (ink composites over the glyph), so pass 3 accepts a template
  // whose stain-zone pixels are merely not lighter than the page while everything
  // else matches exactly. Exact beats poke beats stain.
  matchAt(sx, sy) {
    let exactBest = null;
    let pokeBest = null;
    let stainBest = null;

    // One whole-page buffer lookup per probe (identity-cached), plus a Uint32 view
    // over the same floats for bit-pattern hashing, memoized on the page object.
    const page = this.engine._pageFor(this.img);
    const PW = page.w, PH = page.h, pg = page.gray;
    const u32 = page.u32 ??
      (page.u32 = new Uint32Array(pg.buffer, pg.byteOffset, pg.length));
    const x0 = Math.round(sx + TEMPLATE_LEFT_CROP), y0 = Math.round(sy);

    // Hash the in-page window ONCE per template height, incrementally column by
    // column (column-major FNV, matching the mapCM/pokeMapCM keys built at load):
    // the chain hash after w columns is exactly hashPixelsCM of the w-wide window,
    // so every size group of this height reads its lookup key from a checkpoint of
    // one shared sweep instead of re-hashing its own window. wMax caps the sweep at
    // the page's right edge; wider groups fall back to the copying path below.
    for (const plan of this.engine._chainPlans.values()) {
      plan.wMax = (x0 >= 0 && y0 >= 0 && y0 + plan.h <= PH)
        ? Math.min(plan.maxW, PW - x0) : 0;
      let hE = 0x811c9dc5, hP = 0x811c9dc5, hSB = 0x811c9dc5, hSC = 0x811c9dc5;
      for (let c = 0; c < plan.wMax; c++) {
        let idx = y0 * PW + x0 + c;
        for (let r = 0; r < plan.h; r++, idx += PW) {
          const v = u32[idx];
          hE = Math.imul(hE ^ v, 0x01000193);
          if (c | r) hP = Math.imul(hP ^ v, 0x01000193);
          if (r < plan.h - 3) {                         // stain chains skip the bottom 3 rows…
            hSB = Math.imul(hSB ^ v, 0x01000193);
            if (r >= 2 || c >= 2)                       // …and hSC the 2×2 corner too
              hSC = Math.imul(hSC ^ v, 0x01000193);
          }
        }
        plan.hE[c + 1] = hE;
        plan.hP[c + 1] = hP;
        plan.hSB[c + 1] = hSB;
        plan.hSC[c + 1] = hSC;
      }
    }

    for (const g of this.engine._sizes.values()) {
      // Hash lookup instead of a scan over every template of the size: candidates are
      // the (usually 0-1) templates whose pixel hash equals the window's; full pixel
      // equality then confirms, so a hash collision can never produce a false match.
      const plan = this.engine._chainPlans.get(g.h);
      if (g.w <= plan.wMax) {
        const cand = g.mapCM.get(plan.hE[g.w] >>> 0);
        if (cand) for (const t of cand) {
          if (pixelsEqualStrided(pg, PW, x0, y0, t.pixels, g.w, g.h) &&
              (!exactBest || t.w > exactBest.w))
            exactBest = { char: t.char, score: EXACT_MATCH, w: t.w, t };
        }
        if (g.h >= 2) {
          const pcand = g.pokeMapCM.get(plan.hP[g.w] >>> 0);
          if (pcand) for (const t of pcand) {
            if (pixelsEqualPokeTolerantStrided(pg, PW, x0, y0, t.pixels, g.w, g.h) &&
                (!pokeBest || t.w > pokeBest.w))
              pokeBest = { char: t.char, score: EXACT_MATCH, w: t.w, t };
          }
        }
        if (g.h >= 3) {
          const corner = g.w >= 4;
          const scand = g.stainMapCM.get((corner ? plan.hSC : plan.hSB)[g.w] >>> 0);
          if (scand) for (const t of scand) {
            if (pixelsEqualStainTolerantStrided(pg, PW, x0, y0, t.pixels, g.w, g.h, corner) &&
                (!stainBest || t.w > stainBest.w))
              stainBest = { char: t.char, score: EXACT_MATCH, w: t.w, t };
          }
        }
        continue;
      }
      // Edge probe: the copying path keeps cropPixels' zero-padding of off-page pixels.
      const px = this.engine.cropPixels(this.img, sx + TEMPLATE_LEFT_CROP, sy, g.w, g.h);
      const cand = g.map.get(hashPixels(px, 0));
      if (cand) for (const t of cand) {
        if (pixelsEqual(px, t.pixels) && (!exactBest || t.w > exactBest.w))
          exactBest = { char: t.char, score: EXACT_MATCH, w: t.w, t };
      }
      if (g.h >= 2) {
        const pcand = g.pokeMap.get(hashPixels(px, 1));
        if (pcand) for (const t of pcand) {
          if (pixelsEqualPokeTolerant(px, t.pixels, g.w) && (!pokeBest || t.w > pokeBest.w))
            pokeBest = { char: t.char, score: EXACT_MATCH, w: t.w, t };
        }
      }
    }

    return exactBest ?? pokeBest ?? stainBest ?? { char: PLACEHOLDER, score: 0, w: 0, t: null };
  }

  // ------------------------------------------------------------------
  // Settings → geometry
  // ------------------------------------------------------------------
  applySettings() {
    this.rowBands = this.config.makeRowBands();
    this.rowPens = [];        // grid settings changed → leave blind-OCR mode
    this.blindObjects = null;
    this.ensureRows();
    this.rebuildBoxes();
    this.updateInfo();
    this.render();
  }

  // ------------------------------------------------------------------
  // Auto OCR (blind) — grid-free reading via blindocr.js: measured bands,
  // measured baselines, measured pens/spaces, auto font pick, object
  // detection. Results are mapped into the normal row model so every
  // existing interaction (row select, edit, box hover, double-click
  // extract) works unchanged, with glyph boxes at the MEASURED pens.
  // ------------------------------------------------------------------
  async _ensureBlindSets() {
    if (!this._blindSets) this._blindSets = await BlindOCR.loadSets();
    if (!this._blindSets.length) throw new Error(
      'no glyph sets found — run ocr/tools/export_glyphs.py (bench/glyphs_*.json)');
    return this._blindSets;
  }

  // Escalating passes: byte-exact first (both compositor models are in the
  // set list — the per-band auto-pick chooses), then small tolerances for
  // producers with sub-model rounding stragglers, then ±10 for near-identical
  // renderers we haven't modelled yet. Keeps the fewest-failures read at the
  // lowest tolerance; certificates are labelled accordingly, never silently
  // weakened.
  async _blindReadEscalating(page, label = 'Auto OCR') {
    const sets = await this._ensureBlindSets();
    let tol = 0, res = null, bestFails = Infinity;
    for (const tryTol of [0, 1, 2, 10]) {
      const r = await BlindOCR.readPage(page, sets, { tol: tryTol,
        progress: (d, t) => { this.infoEl.textContent =
          `${label}${tryTol ? ` (±${tryTol})` : ''}: ${d}/${t} bands…`; },
      });
      const fails = r.lines.reduce((s, L) => s + L.fails.length, 0) +
        r.lines.filter(L => !L.set).length;
      if (fails < bestFails) { bestFails = fails; res = r; tol = tryTol; }
      if (fails === 0) break;                          // fully read — keep lowest tol
      const glyphs = r.lines.reduce((s, L) => s + L.glyphs.length, 0);
      if (tryTol >= 2 && glyphs >= fails * 8) break;   // good enough — stop escalating
    }
    return { res, tol };
  }

  // Whole-document Auto OCR. pageProvider(i) resolves to a canvas (or a
  // ready {w,h,gray} page buffer) or null for an empty page. Returns
  // per-page structured results plus the plain-text transcription.
  async blindOcrDocument(numPages, pageProvider) {
    await this._ensureBlindSets();
    const pages = [];
    const totals = { lines: 0, clean: 0, fails: 0 };
    for (let i = 0; i < numPages; i++) {
      const src = await pageProvider(i);
      if (!src) { pages.push(null); continue; }
      const page = src.gray ? src : this.engine._pageFor(src);
      const { res, tol } = await this._blindReadEscalating(page, `Auto OCR ${i + 1}/${numPages}`);
      for (const L of res.lines) {
        if (L.set) totals.lines++;
        if (L.clean) totals.clean++;
        totals.fails += L.fails.length + (L.set ? 0 : 1);
      }
      pages.push({
        tol, spaceAdv: res.spaceAdv, objects: res.objects,
        lines: res.lines.map(L => ({ baseline: L.baseline ?? null, phy: L.phy ?? 0,
          font: L.font ?? null, text: L.text ?? '', clean: !!L.clean, fails: L.fails.length })),
      });
    }
    const text = pages.map(p => p ? p.lines.map(L => L.text.replace(/□/g, '').trimEnd()).join('\n') : '')
      .join('\n\n') + '\n';
    return { pages, text, totals };
  }

  async blindOcrPage() {
    if (!this.img) return;
    this.infoEl.textContent = 'Auto OCR: loading glyph sets…';
    let out;
    try { out = await this._blindReadEscalating(this.engine._pageFor(this.img)); }
    catch (e) { this.infoEl.textContent = `Auto OCR: ${e.message}`; return; }
    const { res, tol } = out;
    this.rowBands = res.lines.map(L => ({ y0: L.top, y1: L.bot }));
    this.activeRow = 0;
    this.rowStartX = res.lines.map(L => L.entries[0]?.pen ?? this.config.startX);
    this.rowText = res.lines.map(L => L.text);
    this.rowScores = res.lines.map(L => {
      const sc = [];
      for (const e of L.entries) sc[e.i] = e.score;
      return sc;
    });
    this.rowMode = res.lines.map(() => 'ocr');
    this.rowStopX = res.lines.map(() => null);
    this.rowPens = res.lines.map(L => L.entries);
    this.blindObjects = res.objects;
    this.rebuildBoxes();
    this.render();
    const readable = res.lines.filter(L => L.set).length;
    const clean = res.lines.filter(L => L.clean).length;
    const fonts = [...new Set(res.lines.map(L => L.font).filter(Boolean))].join('+') || '—';
    const cert = tol ? `clean@±${tol}` : 'byte-clean';
    this.infoEl.textContent =
      `Auto OCR: ${readable} lines, ${clean} ${cert}, ${res.objects.length} non-text objects · ` +
      `font ${fonts} · space ${res.spaceAdv ? res.spaceAdv.toFixed(2) + 'px' : '—'} · no grid used` +
      (tol ? ' · near-identical renderer (tolerant mode)' : '');
  }

  setLineText(text) {
    this.ensureRows();
    const r = this.activeRow;
    const old = this.rowText[r] || '';
    const oldScores = this.rowScores[r] || [];
    // Keep the score/colour of unchanged characters; new or changed ones become
    // manual (null score → blue).
    const scores = [];
    for (let i = 0; i < text.length; i++) {
      scores[i] = (i < old.length && old[i] === text[i]) ? (oldScores[i] ?? null) : null;
    }
    this.rowText[r] = text;
    this.rowScores[r] = scores;
    this.rowMode[r] = 'manual'; // hand-edited → never auto-overwritten by a save refresh
    if (this.rowPens) this.rowPens[r] = undefined; // measured pens no longer match edited text
    this.rebuildBoxes();
    this.render();
  }

  _measureCtx() {
    if (!this._mctx) this._mctx = document.createElement('canvas').getContext('2d');
    this._mctx.font = this.config.fontSpec;
    return this._mctx;
  }

  // X (image space) of the next character after `text`, from `startX`, using the
  // font's advance widths. The single layout rule: OCR, rescoring, and drawing all
  // call it, so a glyph is always cropped/matched/drawn at the same place.
  charX(startX, text) {
    return startX + this._measureCtx().measureText(text).width;
  }

  // Per-character boxes for a row, walking the font's cumulative advance widths
  // from its anchor (so kerning is respected). Each carries its match score.
  boxesForRow(r) {
    const text = this.rowText[r] || '';
    if (!text || r < 0 || r >= this.rowBands.length) return [];
    const band = this.rowBands[r];
    // Blind-OCR rows carry MEASURED pens — boxes sit exactly on the drawn
    // glyphs regardless of layout, no font-advance walk needed.
    if (this.rowPens && this.rowPens[r]) {
      return this.rowPens[r].map(e => ({
        char: e.ch, x0: e.pen, x1: e.pen + e.adv,
        y0: band.y0, y1: band.y1, score: e.score, row: r, i: e.i,
      }));
    }
    const startX = this.rowStartX[r];
    const scores = this.rowScores[r] || [];
    const out = [];
    for (let i = 0; i < text.length; i++) {
      out.push({
        char: text[i],
        x0: this.charX(startX, text.slice(0, i)),
        x1: this.charX(startX, text.slice(0, i + 1)),
        y0: band.y0, y1: band.y1,
        score: scores[i] ?? null, row: r, i,
      });
    }
    // An OCR row's trailing □ marks the glyph that stopped the line. Pin it to
    // that glyph's real ink column (rowStopX) instead of the drifted space
    // estimate, so it sits on the glyph and a double-click captures it cleanly.
    const last = out[out.length - 1];
    if (last && last.char === PLACEHOLDER && this.rowMode[r] === 'ocr' && this.rowStopX[r] != null) {
      const w = last.x1 - last.x0;
      last.x0 = this.rowStopX[r];
      last.x1 = last.x0 + w;
    }
    return out;
  }

  // Rebuild the boxes for every row so any displayed character can be hit-tested
  // and double-clicked, regardless of which row is active.
  rebuildBoxes() {
    this.ensureRows();
    this.allBoxes = [];
    for (let r = 0; r < this.rowBands.length; r++) {
      if (!this.rowText[r]) continue;
      for (const b of this.boxesForRow(r)) this.allBoxes.push(b);
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  resetFit() {
    if (!this.img) return;
    const margin = 20;
    this.scale = Math.min(
      (this.canvas.width - margin * 2) / this.img.width,
      (this.canvas.height - margin * 2) / this.img.height
    );
    this.tx = (this.canvas.width - this.img.width * this.scale) / 2;
    this.ty = (this.canvas.height - this.img.height * this.scale) / 2;
    this.render();
  }

  updateInfo() {
    if (!this.img) return;
    this.infoEl.textContent =
      `${this.filename}  ·  ${this.img.width}×${this.img.height} px  ·  ${this.config.rowCount} rows  ·  ` +
      `${this.config.fontSize}px ${this.config.fontFamily}  ·  Drag anchor=line start  Type=fill line  Dbl-click box=extract`;
  }

  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.img) {
      this.ctx.fillStyle = '#333';
      this.ctx.font = '14px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('Pick a PDF to begin.', this.canvas.width / 2, this.canvas.height / 2);
      return;
    }

    this.ctx.save();
    this.ctx.translate(this.tx, this.ty);
    this.ctx.scale(this.scale, this.scale);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.img, 0, 0);

    const hairline = 1 / this.scale;

    // Horizontal row bands (blue) + line numbers
    this.ctx.lineWidth = hairline;
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';
    for (let i = 0; i < this.rowBands.length; i++) {
      const { y0, y1 } = this.rowBands[i];
      const active = i === this.activeRow;
      this.ctx.strokeStyle = active ? 'rgba(120, 200, 255, 0.95)' : 'rgba(80, 150, 255, 0.55)';
      this.ctx.beginPath(); this.ctx.moveTo(0, y0); this.ctx.lineTo(this.img.width, y0); this.ctx.stroke();
      this.ctx.beginPath(); this.ctx.moveTo(0, y1); this.ctx.lineTo(this.img.width, y1); this.ctx.stroke();

      this.ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
      this.ctx.font = 'bold 8px monospace';
      this.ctx.fillText(i.toString(), -4, (y0 + y1) / 2);
    }

    // Non-text objects found by Auto OCR (redaction boxes magenta, rules amber)
    if (this.blindObjects) {
      for (const ob of this.blindObjects) {
        this.ctx.fillStyle = ob.type === 'box' ? 'rgba(255, 0, 180, 0.15)' : 'rgba(255, 180, 0, 0.25)';
        this.ctx.fillRect(ob.x0, ob.y0, ob.x1 - ob.x0, ob.y1 - ob.y0);
        this.ctx.strokeStyle = ob.type === 'box' ? 'rgba(255, 0, 180, 0.8)' : 'rgba(255, 180, 0, 0.8)';
        this.ctx.strokeRect(ob.x0, ob.y0, ob.x1 - ob.x0, ob.y1 - ob.y0);
      }
    }

    this.renderLines();
    this.ctx.restore();
  }

  // Every row's characters, the hovered cutout outline, and each row's draggable
  // start anchor. Colour: green = exact match, orange = placeholder, blue = typed.
  renderLines() {
    if (this.rowBands.length === 0) return;
    this.ensureRows();
    const hair = 1 / this.scale;

    // Characters, in the selected font/size, one per box so each can carry its colour.
    this.ctx.font = this.config.fontSpec;
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    for (const b of this.allBoxes) {
      if (b.char === ' ') continue;
      const cy = (b.y0 + b.y1) / 2;
      const dim = b.row === this.activeRow ? 1 : 0.6;
      const rgb = b.char === PLACEHOLDER ? '235,140,0' : b.score != null ? '0,210,70' : null;
      if (rgb) {
        this.ctx.fillStyle = `rgba(${rgb},0.28)`;
        this.ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        this.ctx.fillStyle = `rgba(${rgb},${dim})`;
      } else {
        this.ctx.fillStyle = `rgba(60,130,255,${dim})`; // manual / confirmed
      }
      this.ctx.fillText(b.char, b.x0, cy);
    }

    // Hovered cutout outline — the exact region matched/saved (offset and shrunk
    // by TEMPLATE_LEFT_CROP, matching cropPixels / extractBox).
    this.ctx.lineWidth = hair;
    for (const b of this.allBoxes) {
      if (b.char === ' ' || `${b.row}:${b.i}` !== this._hoverKey) continue;
      const w = Math.max(1, (b.x1 - b.x0) - 1 - TEMPLATE_LEFT_CROP);
      this.ctx.strokeStyle = 'rgba(255, 210, 0, 0.95)';
      this.ctx.strokeRect(b.x0 + TEMPLATE_LEFT_CROP, b.y0, w, b.y1 - b.y0);
    }

    // Draggable start anchors (purple): a vertical tick + a handle above the band.
    for (let r = 0; r < this.rowBands.length; r++) {
      const band = this.rowBands[r];
      const x = this.rowStartX[r];
      const active = r === this.activeRow;
      const color = active ? 'rgba(200, 90, 255, 0.95)' : 'rgba(190, 90, 255, 0.5)';
      this.ctx.strokeStyle = color;
      this.ctx.fillStyle = color;
      this.ctx.lineWidth = hair * (active ? 2 : 1);
      this.ctx.beginPath();
      this.ctx.moveTo(x, band.y0);
      this.ctx.lineTo(x, band.y1);
      this.ctx.stroke();

    }
  }

  // ------------------------------------------------------------------
  // Coordinate helpers
  // ------------------------------------------------------------------
  toImage(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.tx) / this.scale,
      y: (clientY - rect.top - this.ty) / this.scale,
    };
  }

  // The character box under a point, across every row (not just the active one).
  boxAt(imgX, imgY) {
    return this.allBoxes.find(b =>
      b.char !== ' ' && imgX >= b.x0 && imgX < b.x1 && imgY >= b.y0 && imgY <= b.y1) || null;
  }

  // Row whose start anchor is near the given image-space point, else -1.
  anchorAt(imgX, imgY) {
    const tolX = 7 / this.scale;
    const padY = 10 / this.scale;
    for (let r = 0; r < this.rowBands.length; r++) {
      const band = this.rowBands[r];
      if (Math.abs(imgX - this.rowStartX[r]) <= tolX &&
          imgY >= band.y0 - padY && imgY <= band.y1 + padY) return r;
    }
    return -1;
  }

  // ------------------------------------------------------------------
  // Extraction (double-click a character box)
  // ------------------------------------------------------------------
  _extractAtEvent(e) {
    if (!this.img) return;
    const { x, y } = this.toImage(e.clientX, e.clientY);
    const box = this.boxAt(x, y);
    if (!box) return;

    // Make the clicked box's row active so typing / OCR target it.
    if (box.row !== this.activeRow) {
      this.activeRow = box.row;
      const li = document.getElementById('line-input');
      if (li) li.value = this.rowText[box.row] || '';
    }

    // flash to confirm the hit
    this.ctx.save();
    this.ctx.translate(this.tx, this.ty);
    this.ctx.scale(this.scale, this.scale);
    this.ctx.fillStyle = 'rgba(255, 255, 0, 0.4)';
    this.ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    this.ctx.restore();
    setTimeout(() => this.render(), 150);

    this.extractBox(box);
  }

  async findAvailableFilename(stem) {
    if (!this.dirHandle) return `${stem}.png`;
    try { await this.dirHandle.getFileHandle(`${stem}.png`, { create: false }); }
    catch { return `${stem}.png`; }
    for (let n = 2; ; n++) {
      try { await this.dirHandle.getFileHandle(`${stem}_${n}.png`, { create: false }); }
      catch { return `${stem}_${n}.png`; }
    }
  }

  async extractBox(box) {
    const h = Math.max(1, Math.round(box.y1 - box.y0));
    const x0 = Math.round(box.x0);
    // Grayscale crop at the cell's left, `cw` columns wide — the same geometry
    // cropPixels/matchAt read back. Narrower than the advance so neighbouring
    // crops don't share a column.
    const cut = cw => {
      const off = document.createElement('canvas');
      off.width = cw; off.height = h;
      const ctx = off.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.img, x0 + TEMPLATE_LEFT_CROP, Math.round(box.y0), cw, h, 0, 0, cw, h);
      return off;
    };

    let w = Math.max(1, Math.round(box.x1 - box.x0) - 1 - TEMPLATE_LEFT_CROP);
    const off = cut(w);

    const label = await this.promptLabel(off, box.char === PLACEHOLDER ? '' : box.char);
    if (label === null) return;
    const stem = charToStem(label);

    // A □ box carries the placeholder's own advance, not the glyph's. Now that we
    // know the character, re-cut to its advance so the saved template is the
    // right width (matching how a normal box is already one advance wide).
    let saveCanvas = off;
    if (box.char === PLACEHOLDER) {
      w = Math.max(1, Math.round(this._measureCtx().measureText(label).width) - 1 - TEMPLATE_LEFT_CROP);
      saveCanvas = cut(w);
    }

    const blob = await new Promise(resolve => saveCanvas.toBlob(resolve, 'image/png'));

    if (window.showDirectoryPicker) {
      if (!this.dirHandle) {
        try { this.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
        catch { this.infoEl.textContent = 'Folder selection cancelled.'; return; }
      }
      const filename = await this.findAvailableFilename(stem);
      try {
        const fh = await this.dirHandle.getFileHandle(filename, { create: true });
        const w2 = await fh.createWritable();
        await w2.write(blob); await w2.close();
        await this.reloadTemplates();
        this.refreshOcrAfterSave();
        this.infoEl.textContent = `Saved: ${filename}  (${w}×${h}px) — re-OCR'd page.`;
      } catch { this.infoEl.textContent = `Error saving ${filename}`; }
    } else {
      const filename = `${stem}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      this.infoEl.textContent = `Downloaded: ${filename}  (${w}×${h}px)`;
    }
  }

  promptLabel(charCanvas, suggestion = '') {
    return new Promise(resolve => {
      const modal = document.getElementById('label-modal');
      const preview = document.getElementById('label-preview');
      const input = document.getElementById('label-input');

      const SCALE = 6;
      preview.width = charCanvas.width * SCALE;
      preview.height = charCanvas.height * SCALE;
      const pctx = preview.getContext('2d');
      pctx.imageSmoothingEnabled = false;
      pctx.drawImage(charCanvas, 0, 0, preview.width, preview.height);

      input.value = suggestion;
      modal.classList.remove('hidden');
      input.focus();
      input.select();

      const cleanup = () => { modal.classList.add('hidden'); input.removeEventListener('keydown', onKey); };
      const onKey = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = input.value.trim();
          cleanup();
          resolve(val.length > 0 ? val : null); // empty Enter = cancel
        } else if (e.key === 'Escape') {
          e.preventDefault(); cleanup(); resolve(null);
        }
      };
      input.addEventListener('keydown', onKey);
      modal.onclick = e => { if (e.target === modal) { cleanup(); resolve(null); } };
    });
  }

  // ------------------------------------------------------------------
  // Pan / zoom / hover
  // ------------------------------------------------------------------
  onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.05, Math.min(80, this.scale * factor));
    this.tx = mx - (mx - this.tx) * (newScale / this.scale);
    this.ty = my - (my - this.ty) * (newScale / this.scale);
    this.scale = newScale;
    this.render();
  }

  onMouseDown(e) {
    if (e.button !== 0) return;

    // Grab a start anchor if one is under the cursor → drag it (and activate
    // that row). Otherwise fall back to panning.
    if (this.img) {
      const { x, y } = this.toImage(e.clientX, e.clientY);
      const r = this.anchorAt(x, y);
      if (r !== -1) {
        this._dragAnchorRow = r;
        this.setActiveRow(r);
        this.wrap.classList.add('dragging');
        return;
      }
    }

    this.dragging = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.txStart = { tx: this.tx, ty: this.ty };
    this.wrap.classList.add('dragging');
  }

  onMouseMove(e) {
    if (this._dragAnchorRow !== -1) {
      const { x } = this.toImage(e.clientX, e.clientY);
      this.rowStartX[this._dragAnchorRow] = Math.max(0, Math.min(this.img.width, x));
      this.rebuildBoxes();
      this.render();
      return;
    }
    if (this.dragging) {
      this.tx = this.txStart.tx + (e.clientX - this.dragStart.x);
      this.ty = this.txStart.ty + (e.clientY - this.dragStart.y);
      this.render();
      return;
    }
    if (!this.img) return;
    const { x, y } = this.toImage(e.clientX, e.clientY);
    // cursor hint when over a draggable anchor
    this.canvas.style.cursor = this.anchorAt(x, y) !== -1 ? 'ew-resize' : '';
    // hover highlight over any character box
    const box = this.boxAt(x, y);
    const key = box ? `${box.row}:${box.i}` : null;
    if (key !== this._hoverKey) { this._hoverKey = key; this.render(); }
  }

  onMouseUp() {
    if (this._dragAnchorRow !== -1) this._dragAnchorRow = -1;
    this.dragging = false;
    this.wrap.classList.remove('dragging');
  }
}

// Mix the OCR methods onto CanvasViewer: template loading (CanvasViewerTemplates,
// ocr.js) and line reading (CanvasViewerReader, reader.js) — both loaded first.
Object.assign(CanvasViewer.prototype, CanvasViewerTemplates, CanvasViewerReader);


// ---------------------------------------------------------------------------
// App Initialization
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const config = new Config();
  const viewer = new CanvasViewer(
    document.getElementById('canvas'),
    document.getElementById('canvas-wrap'),
    document.getElementById('info'),
    config
  );

  let pdfDoc = null;
  let pdfName = 'ocr';
  const pdfPageCanvases = [];
  let currentPageIndex = 0;

  async function getPageCanvas(index) {
    if (pdfPageCanvases[index]) return pdfPageCanvases[index];
    const page = await pdfDoc.getPage(index + 1);
    const images = await extractEmbeddedImages(page);
    pdfPageCanvases[index] = images[0] ?? null;
    return pdfPageCanvases[index];
  }

  const pageSelect = document.getElementById('page-select');
  const prevBtn = document.getElementById('prev-page-btn');
  const nextBtn = document.getElementById('next-page-btn');

  async function loadPage(index) {
    if (!pdfDoc || index < 0 || index >= pdfDoc.numPages) return;
    currentPageIndex = index;
    pageSelect.value = index;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === pdfDoc.numPages - 1;

    viewer.infoEl.textContent = `Loading page ${index + 1}…`;
    const canvas = await getPageCanvas(index);
    if (!canvas) {
      viewer.infoEl.textContent = `Page ${index + 1}: no embedded image found`;
      return;
    }
    viewer.loadCanvas(canvas, `Page ${index + 1}`);
  }

  document.getElementById('pdf-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    pdfName = file.name.replace(/\.pdf$/i, '') || 'ocr';
    viewer.infoEl.textContent = 'Loading PDF…';
    const ab = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: ab }).promise;

    pdfPageCanvases.length = 0;
    pdfPageCanvases.length = pdfDoc.numPages;

    pageSelect.innerHTML = '';
    for (let i = 0; i < pdfDoc.numPages; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Page ${i + 1}`;
      pageSelect.appendChild(opt);
    }

    document.getElementById('pdf-label').classList.add('active');
    await loadPage(0);
  });

  prevBtn.addEventListener('click', () => loadPage(currentPageIndex - 1));
  nextBtn.addEventListener('click', () => loadPage(currentPageIndex + 1));
  pageSelect.addEventListener('change', e => loadPage(parseInt(e.target.value, 10)));

  // Live-bind every numeric / text setting input to the Config
  const numericSettings = ['rowBase', 'rowHeight', 'rowPitch', 'rowCount', 'fontSize'];
  for (const key of numericSettings) {
    const el = document.getElementById(`set-${key}`);
    if (!el) continue;
    el.value = config[key];
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!Number.isNaN(v)) { config[key] = v; viewer.applySettings(); }
    });
  }
  const fontFamilyEl = document.getElementById('set-fontFamily');
  if (fontFamilyEl) {
    fontFamilyEl.value = config.fontFamily;
    fontFamilyEl.addEventListener('input', () => {
      config.fontFamily = fontFamilyEl.value || 'Times New Roman';
      viewer.applySettings();
    });
  }

  // Line transcription input — type the line's text, boxes follow font widths
  const lineInput = document.getElementById('line-input');
  lineInput.addEventListener('input', () => viewer.setLineText(lineInput.value));

  // Primary OCR = Auto OCR (grid-free, self-verifying). The legacy
  // grid/template reader stays available from the Legacy panel — the bench
  // (dump-ocr.mjs) still drives those code paths, so they are demoted in the
  // UI, not removed. Templates now load on demand instead of at startup.
  document.getElementById('blind-ocr-btn').addEventListener('click',
    () => viewer.blindOcrPage().catch(e => { viewer.infoEl.textContent = `Auto OCR failed: ${e.message}`; }));
  document.getElementById('templates-btn').addEventListener('click', () => viewer.loadTemplates());
  document.getElementById('ocr-page-btn').addEventListener('click', async () => {
    if (viewer.engine.templates.length === 0) {
      viewer.infoEl.textContent = 'Loading templates for grid OCR…';
      try { await viewer.autoLoadTemplatesFromHTTP(); } catch {}
      if (viewer.engine.templates.length === 0) {
        viewer.infoEl.textContent = 'Grid OCR needs templates — click Load Templates.';
        return;
      }
    }
    // grid OCR assumes the configured bands — leave blind mode first
    if (viewer.rowPens && viewer.rowPens.some(Boolean)) viewer.applySettings();
    viewer.ocrAllRows();
  });

  // Auto OCR every page + download — the browser equivalent of
  // bench/blind-read.mjs --all. Text export strips □ (unreadable-cluster
  // markers); the JSON export keeps everything: per-line baseline, font,
  // certificate flag and tolerance, plus detected non-text objects.
  const ocrAllBtn = document.getElementById('ocr-all-btn');
  const downloadBtn = document.getElementById('download-txt-btn');
  const downloadJsonBtn = document.getElementById('download-json-btn');
  let ocrDoc = null;   // last full-document result {pages, text, totals}

  ocrAllBtn.addEventListener('click', async () => {
    if (!pdfDoc) { viewer.infoEl.textContent = 'Load a PDF first.'; return; }
    ocrAllBtn.disabled = true;
    downloadBtn.disabled = true;
    downloadJsonBtn.disabled = true;
    try {
      ocrDoc = await viewer.blindOcrDocument(pdfDoc.numPages, getPageCanvas);
      downloadBtn.disabled = false;
      downloadJsonBtn.disabled = false;
      const t = ocrDoc.totals;
      const tols = [...new Set(ocrDoc.pages.filter(Boolean).map(p => p.tol))].sort((a, b) => a - b);
      viewer.infoEl.textContent =
        `Auto OCR complete — ${pdfDoc.numPages} page(s), ${t.lines} lines, ${t.clean} certified, ` +
        `${t.fails} unread clusters · tol ${tols.join('/')} · Download .txt / .json`;
    } catch (e) {
      viewer.infoEl.textContent = `Auto OCR failed: ${e.message}`;
    } finally {
      ocrAllBtn.disabled = false;
      // Restore the on-screen page (the sweep reused the engine's page buffer).
      await loadPage(currentPageIndex);
    }
  });

  const download = (data, name, type) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  downloadBtn.addEventListener('click', () => {
    if (ocrDoc) download(ocrDoc.text, `${pdfName}.txt`, 'text/plain;charset=utf-8');
  });
  downloadJsonBtn.addEventListener('click', () => {
    if (ocrDoc) download(JSON.stringify({ pdf: pdfName, totals: ocrDoc.totals, pages: ocrDoc.pages }, null, 1),
      `${pdfName}.ocr.json`, 'application/json');
  });
});

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// core.js (loaded first) attaches the DOM-free helpers used below as globals:
// PLACEHOLDER, gray. ocr.js (loaded next) defines the PageEngine class — the
// page-buffer engine (grayscale reduction + RGBA access) that CanvasViewer
// instantiates below.
//
// 2026-07-21: the app is a VIEWER — open a PDF, Auto OCR it, inspect the
// certified overlay, export .txt/.json. The manual-era features (row text
// editing, draggable start anchors, double-click save-glyph-as-template)
// were removed; the purple line-start ticks remain as a read-quality check
// (measured starts should stack into the clean left edge real documents
// have). Resurrect the editing era from git history if ever needed.


// ---------------------------------------------------------------------------
// Config — kept as the viewer's (tiny) settings object; Auto OCR measures
// everything from the pixels, so nothing here shapes the read.
// ---------------------------------------------------------------------------
class Config {}


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
// CanvasViewer — pan/zoom page display + Auto OCR overlay
// ---------------------------------------------------------------------------
class CanvasViewer {
  constructor(canvas, wrap, infoEl, config) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.wrap = wrap;
    this.infoEl = infoEl;
    this.config = config;

    this.img = null;
    this.rowBands = [];    // measured ink bands, installed by Auto OCR
    this.filename = '';

    this.tx = 0; this.ty = 0; this.scale = 1;
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.txStart = { tx: 0, ty: 0 };

    // Per-row read state (all installed by Auto OCR)
    this.rowStartX = [];   // first measured pen per row — the purple tick
    this.rowText = [];     // text per row
    this.rowPens = [];     // per row: entries [{ch,pen,adv,score,i}] or undefined
    this.blindObjects = null; // page-level non-text objects
    this.allBoxes = [];    // [{char, x0, x1, y0, y1, score, row, i}] for every row

    this.engine = new PageEngine();

    this.initEvents();
  }

  initEvents() {
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.resize();

    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    window.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', e => this.onMouseUp(e));
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
    this._blindPassHint = null;    // new page image: forget the learned pass (Recto parity)
    this.resetLine();
    this.updateInfo();
    this.resetFit();
  }

  resetLine() {
    this.rowBands = [];
    this.rowStartX = [];
    this.rowText = [];
    this.rowPens = [];
    this.blindObjects = null;
    this.allBoxes = [];
  }

  // ------------------------------------------------------------------
  // Auto OCR (blindocr.js): measured bands, measured baselines, measured
  // pens/spaces, auto font pick, object detection — no settings, and every
  // line carries a byte-exactness certificate.
  // ------------------------------------------------------------------
  async _ensureBlindSets() {
    if (!this._blindSets) this._blindSets = await BlindOCR.loadSets();
    if (!this._blindSets.length) throw new Error(
      'no glyph sets found — run tools/export-glyphs.mjs (assets/glyphs/glyphs.bin)');
    return this._blindSets;
  }

  // The escalation ladder itself (pass order, tie-breaks, early exits) lives
  // in blindocr.js (BlindOCR.readPageAuto) so embedders share it; this
  // wrapper only adds the app's status-line progress text.
  async _blindReadEscalating(page, label = 'Auto OCR', passHint = null, carry = null) {
    const sets = await this._ensureBlindSets();
    return BlindOCR.readPageAuto(page, sets, { passHint, carry,
      progress: (pass, d, t) => { this.infoEl.textContent =
        `${label}${BlindOCR.passLabel(pass)}: ${d}/${t} bands…`; } });
  }

  // Whole-document Auto OCR. pageProvider(i) resolves to a canvas (or a
  // ready {w,h,gray} page buffer) or null for an empty page. Returns
  // per-page structured results plus the plain-text transcription.
  async blindOcrDocument(numPages, pageProvider) {
    await this._ensureBlindSets();
    const pages = [];
    const totals = { lines: 0, clean: 0, fails: 0 };
    let passHint = null;                   // learned from the previous page
    const carry = {};                      // cross-page baseline hints (this document read)
    for (let i = 0; i < numPages; i++) {
      const src = await pageProvider(i);
      if (!src) { pages.push(null); continue; }
      // colored ink (hyperlink blue) is whitened before reading — with a real
      // canvas the RGBA neutrality test is exact, seeded cache pages fall
      // back to the fractional-gray signal (see BlindOCR.whitenColored)
      const page = src.gray ? BlindOCR.whitenColored(src)
        : BlindOCR.whitenColored(this.engine._pageFor(src), this.engine.pageRGBA(src));
      const { res, pass } = await this._blindReadEscalating(page, `Auto OCR ${i + 1}/${numPages}`, passHint, carry);
      passHint = pass;
      for (const L of res.lines) {
        if (L.set) totals.lines++;
        if (L.clean) totals.clean++;
        totals.fails += L.fails.length + (L.set ? 0 : 1);
      }
      pages.push({
        tol: pass.tol, quant: !!pass.quant, union: !!pass.union,
        spaceAdv: res.spaceAdv, objects: res.objects,
        lines: res.lines.map(L => ({ baseline: L.baseline ?? null, phy: L.phy ?? 0,
          font: L.font ?? null, text: L.text ?? '', clean: !!L.clean, fails: L.fails.length,
          // every glyph's measured ¼-px pen — the raw material for
          // byte-exact source recreation (□ entries carry the fail column)
          glyphs: (L.entries ?? []).map(e => [e.ch, e.pen]) })),
      });
    }
    const text = pages.map(p => p ? p.lines.map(L => L.text.replace(/□/g, '').trimEnd()).join('\n') : '')
      .join('\n\n') + '\n';
    return { pages, text, totals };
  }

  async blindOcrPage() {
    if (!this.img) return;
    this.infoEl.textContent = 'Auto OCR: loading glyph sets…';
    let out, page;
    try {
      page = BlindOCR.whitenColored(this.engine._pageFor(this.img),
        this.engine.pageRGBA(this.img));
      // remember the winning pass across presses (Recto's "Read this Page"
      // does the same via ocrToolState.passHint) — reset on image load
      out = await this._blindReadEscalating(page, 'Auto OCR', this._blindPassHint);
    }
    catch (e) { this.infoEl.textContent = `Auto OCR: ${e.message}`; return; }
    const { res, pass } = out;
    this._blindPassHint = pass;
    this.rowBands = res.lines.map(L => ({ y0: L.top, y1: L.bot }));
    this.rowStartX = res.lines.map(L => L.entries[0]?.pen);
    this.rowText = res.lines.map(L => L.text);
    this.rowPens = res.lines.map(L => L.entries);
    this.blindObjects = res.objects;
    this.rebuildBoxes();
    this.render();
    const readable = res.lines.filter(L => L.set).length;
    const clean = res.lines.filter(L => L.clean).length;
    const fonts = [...new Set(res.lines.map(L => L.font).filter(Boolean))].join('+') || '—';
    const cert = pass.tol ? `clean@±${pass.tol}` : 'byte-clean';
    this.infoEl.textContent =
      `Auto OCR: ${readable} lines, ${clean} ${cert}, ${res.objects.length} non-text objects · ` +
      `font ${fonts} · space ${res.spaceAdv ? res.spaceAdv.toFixed(2) + 'px' : '—'} · no grid used` +
      (pass.quant ? ' · palette-quantized producer' : '') +
      (pass.union ? ' · mixed-font lines' : '') +
      (page.colorRemoved ? ` · ${page.colorRemoved} colored-ink px ignored` : '') +
      (pass.tol ? ' · near-identical renderer (tolerant mode)' : '');
  }

  // Per-character boxes for a row, at the MEASURED pens — boxes sit exactly
  // on the drawn glyphs regardless of layout.
  boxesForRow(r) {
    const band = this.rowBands[r];
    if (!band || !this.rowPens[r]) return [];
    return this.rowPens[r].map(e => ({
      char: e.ch, x0: e.pen, x1: e.pen + e.adv,
      y0: band.y0, y1: band.y1, score: e.score, row: r, i: e.i,
    }));
  }

  rebuildBoxes() {
    this.allBoxes = [];
    for (let r = 0; r < this.rowBands.length; r++)
      for (const b of this.boxesForRow(r)) this.allBoxes.push(b);
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
      `${this.filename}  ·  ${this.img.width}×${this.img.height} px  ·  ` +
      `Auto OCR reads with no settings`;
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
      this.ctx.strokeStyle = 'rgba(80, 150, 255, 0.55)';
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

  // Every row's characters (green = byte-certified match, orange = □
  // placeholder) plus the purple line-start tick — a read-quality check:
  // measured starts should stack into the clean left edge real documents have.
  renderLines() {
    if (this.rowBands.length === 0) return;
    const hair = 1 / this.scale;

    this.ctx.font = '16px "Times New Roman"';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    for (const b of this.allBoxes) {
      if (b.char === ' ') continue;
      const cy = (b.y0 + b.y1) / 2;
      const rgb = b.char === PLACEHOLDER ? '235,140,0' : b.score != null ? '0,210,70' : '60,130,255';
      this.ctx.fillStyle = `rgba(${rgb},0.28)`;
      this.ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      this.ctx.fillStyle = `rgba(${rgb},1)`;
      this.ctx.fillText(b.char, b.x0, cy);
    }

    // Line-start ticks (purple), at each row's first measured pen
    this.ctx.strokeStyle = 'rgba(190, 90, 255, 0.8)';
    this.ctx.lineWidth = hair;
    for (let r = 0; r < this.rowBands.length; r++) {
      const x = this.rowStartX[r];
      if (x === undefined) continue;
      const band = this.rowBands[r];
      this.ctx.beginPath();
      this.ctx.moveTo(x, band.y0);
      this.ctx.lineTo(x, band.y1);
      this.ctx.stroke();
    }
  }

  // ------------------------------------------------------------------
  // Pan / zoom
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
    this.dragging = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.txStart = { tx: this.tx, ty: this.ty };
    this.wrap.classList.add('dragging');
  }

  onMouseMove(e) {
    if (!this.dragging) return;
    this.tx = this.txStart.tx + (e.clientX - this.dragStart.x);
    this.ty = this.txStart.ty + (e.clientY - this.dragStart.y);
    this.render();
  }

  onMouseUp() {
    this.dragging = false;
    this.wrap.classList.remove('dragging');
  }
}


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

  // Auto OCR the shown page.
  document.getElementById('blind-ocr-btn').addEventListener('click',
    () => viewer.blindOcrPage().catch(e => { viewer.infoEl.textContent = `Auto OCR failed: ${e.message}`; }));

  // Auto OCR every page + download — the browser equivalent of
  // tools/blind-read.mjs --all. Text export strips □ (unreadable-cluster
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

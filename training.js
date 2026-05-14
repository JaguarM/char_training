// ---------------------------------------------------------------------------
// TemplateEngine — loads Base64 glyph PNGs and runs NCC matching
// ---------------------------------------------------------------------------
const STEM_TO_CHAR = { eq: '=', slash: '/', plus: '+', minus: '-' };
const CHAR_TO_STEM = Object.fromEntries(Object.entries(STEM_TO_CHAR).map(([k, v]) => [v, k]));

class TemplateEngine {
  constructor() {
    this.templates = []; // [{char, pixels: Float32Array(77), mean, den}]
    this._canvas = null;
    this._ctx = null;
  }

  stemToChar(stem) {
    const base = stem.split('_')[0];
    return STEM_TO_CHAR[base] ?? (stem.includes('_UPPER') ? stem.split('_UPPER')[0] : base);
  }

  charToStem(label) {
    return CHAR_TO_STEM[label] ?? (label.length === 1 && label >= 'A' && label <= 'Z' ? label + '_UPPER' : label);
  }

  _dataToGray(data) {
    const pixels = new Float32Array(77);
    for (let i = 0; i < 77; i++)
      pixels[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    return pixels;
  }

  _pixelStats(pixels) {
    let sum = 0;
    for (let i = 0; i < 77; i++) sum += pixels[i];
    const mean = sum / 77;
    let sq = 0;
    for (let i = 0; i < 77; i++) { const v = pixels[i] - mean; sq += v * v; }
    return { mean, l2: Math.sqrt(sq) };
  }

  async loadFromDir(dirHandle) {
    this.templates = [];
    const tasks = [];

    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      if (!name.endsWith('.png') || name.includes('unmatched')) continue;
      const stem = name.slice(0, -4);
      const char = this.stemToChar(stem);
      if (!char || char.length !== 1) continue;
      tasks.push(
        handle.getFile().then(async file => {
          const url = URL.createObjectURL(file);
          try { return await this._loadGray(url, char); }
          finally { URL.revokeObjectURL(url); }
        })
      );
    }

    const results = await Promise.all(tasks);
    this.templates = results.filter(Boolean);
    return this.templates.length;
  }

  _loadGray(url, char) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 7; c.height = 11;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, 7, 11);
        const pixels = this._dataToGray(ctx.getImageData(0, 0, 7, 11).data);
        const { mean, l2 } = this._pixelStats(pixels);
        resolve({ char, pixels, mean, den: l2 });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  _cropCtx() {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = 7; this._canvas.height = 11;
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }
    return this._ctx;
  }

  extractCrop(imgEl, sx, sy) {
    const ctx = this._cropCtx();
    ctx.clearRect(0, 0, 7, 11);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(imgEl, Math.ceil(sx), sy, 7, 11, 0, 0, 7, 11);
    return this._dataToGray(ctx.getImageData(0, 0, 7, 11).data);
  }

  // TM_CCOEFF_NORMED — aL2 is precomputed by the caller to avoid recomputing per template
  ncc(a, aMean, aL2, t) {
    let num = 0;
    for (let i = 0; i < 77; i++)
      num += (a[i] - aMean) * (t.pixels[i] - t.mean);
    const den = aL2 * t.den;
    return den < 1e-8 ? 0 : num / den;
  }

  matchPixels(pixels) {
    const { mean, l2 } = this._pixelStats(pixels);
    if (l2 / Math.sqrt(77) < 5) return { char: ' ', score: 1, blank: true };

    let bestChar = '?', bestScore = -Infinity;
    for (const t of this.templates) {
      const score = this.ncc(pixels, mean, l2, t);
      if (score > bestScore) { bestScore = score; bestChar = t.char; }
    }
    return { char: bestChar, score: bestScore, blank: false };
  }

  matchAll(imgEl, rowBands, config) {
    const pitch = config.charPitch;
    return rowBands.map(({ y0 }) =>
      Array.from({ length: config.nCols }, (_, col) => {
        const pixels = this.extractCrop(imgEl, config.xStart + col * pitch, y0);
        return this.matchPixels(pixels);
      })
    );
  }

  // Load templates from the /api/templates manifest served by launch.py
  async loadFromHTTP(manifest) {
    const tasks = manifest.map(({ filename, char }) =>
      this._loadGray(`/templates/${filename}`, char)
    );
    const results = await Promise.all(tasks);
    this.templates = results.filter(Boolean);
    return this.templates.length;
  }
}


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
class Config {
  constructor() {
    this.xStart = 60;
    this.xEnd = 653;
    this.nCols = 76;
    this.rowBands = Array.from({ length: 65 }, (_, i) => ({ y0: 40 + i * 15, y1: 51 + i * 15 }));
  }

  get charPitch() { return (this.xEnd - this.xStart) / this.nCols; }
  get nGridLines() { return this.nCols + 1; } // column edges: one per col + right edge of last
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
    this.rowBands = this.config.rowBands;
    this.filename = '';

    this.tx = 0; this.ty = 0; this.scale = 1;
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.txStart = { tx: 0, ty: 0 };
    this.dirHandle = null;

    this.engine = new TemplateEngine();
    this.matchResults = null;
    this.showConfidence = true;

    this.initEvents();
  }

  initEvents() {
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.resize();

    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    window.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas.addEventListener('dblclick', e => this._extractAtEvent(e));

    this.wrap.addEventListener('dragenter', e => { e.preventDefault(); this.wrap.classList.add('drop-over'); });
    this.wrap.addEventListener('dragover', e => { e.preventDefault(); });
    this.wrap.addEventListener('dragleave', e => { if (!this.wrap.contains(e.relatedTarget)) this.wrap.classList.remove('drop-over'); });
    this.wrap.addEventListener('drop', e => this.onDrop(e));
  }

  resize() {
    this.canvas.width = this.wrap.clientWidth;
    this.canvas.height = this.wrap.clientHeight;
    this.render();
  }

  // ------------------------------------------------------------------
  // Image loading
  // ------------------------------------------------------------------
  loadURL(url, label, revoke) {
    const image = new Image();
    image.onload = async () => {
      this.img = image;
      this.filename = label;
      if (revoke) URL.revokeObjectURL(url);
      this.matchResults = null;
      this.updateInfo();
      this.resetFit();
      if (this.engine.templates.length > 0) await this.runMatching();
    };
    image.onerror = () => {
      this.infoEl.textContent = `Could not load "${label}" — drop a file or use the button.`;
    };
    image.src = url;
  }

  onDrop(e) {
    e.preventDefault();
    this.wrap.classList.remove('drop-over');
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    this.loadURL(URL.createObjectURL(file), file.name, true);
  }

  // ------------------------------------------------------------------
  // Template loading + NCC matching
  // ------------------------------------------------------------------
  async autoLoadTemplatesFromHTTP() {
    const res = await fetch('/api/templates');
    if (!res.ok) return;
    const manifest = await res.json();
    if (!manifest.length) return;
    this.infoEl.textContent = 'Loading templates…';
    const count = await this.engine.loadFromHTTP(manifest);
    if (count === 0) { this.infoEl.textContent = 'No valid templates found.'; return; }
    this.infoEl.textContent = `Auto-loaded ${count} / 65 templates.`;
    if (this.img) await this.runMatching();
  }

  async loadTemplates() {
    if (!window.showDirectoryPicker) {
      this.infoEl.textContent = 'showDirectoryPicker not supported — use Chrome or Edge.';
      return;
    }
    let dirHandle;
    try { dirHandle = await window.showDirectoryPicker({ mode: 'read' }); }
    catch { return; }

    this.infoEl.textContent = 'Loading templates...';
    const count = await this.engine.loadFromDir(dirHandle);
    if (count === 0) { this.infoEl.textContent = 'No valid templates found in that folder.'; return; }
    this.infoEl.textContent = `Loaded ${count} / 65 template chars.`;
    if (this.img) await this.runMatching();
  }

  async runMatching() {
    if (!this.img || this.engine.templates.length === 0) return;
    this.infoEl.textContent = 'Running NCC matching...';
    await new Promise(r => setTimeout(r, 0));

    this.matchResults = this.engine.matchAll(this.img, this.rowBands, this.config);

    let high = 0, mid = 0, low = 0, total = 0;
    for (const row of this.matchResults)
      for (const r of row) {
        if (r.blank) continue;
        total++;
        if (r.score >= 0.75) high++;
        else if (r.score >= 0.50) mid++;
        else low++;
      }
    this.infoEl.textContent =
      `Match: ${high} high / ${mid} mid / ${low} low  (${total} cells, ${this.rowBands.length} rows)`;
    this.render();
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
      `${this.filename}  ·  ${this.img.width}×${this.img.height} px  ·  ${this.rowBands.length} rows  ·  ` +
      `pitch ${this.config.charPitch.toFixed(4)} px  ·  Dbl-click=extract  Scroll=zoom  Drag=pan`;
  }

  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.img) {
      this.ctx.fillStyle = '#333';
      this.ctx.font = '14px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('Upload a scanned document image to begin.', this.canvas.width / 2, this.canvas.height / 2);
      return;
    }

    this.ctx.save();
    this.ctx.translate(this.tx, this.ty);
    this.ctx.scale(this.scale, this.scale);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.img, 0, 0);

    const hairline = 1 / this.scale;

    // Vertical char-column grid (red)
    this.ctx.strokeStyle = 'rgba(255, 60, 60, 0.70)';
    this.ctx.lineWidth = hairline;
    for (let i = 0; i < this.config.nGridLines; i++) {
      const x = Math.ceil(this.config.xStart + i * this.config.charPitch);
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.img.height);
      this.ctx.stroke();
    }

    // Horizontal row bands (blue) and line numbers
    this.ctx.lineWidth = hairline;
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';

    for (let i = 0; i < this.rowBands.length; i++) {
      const { y0, y1 } = this.rowBands[i];
      
      this.ctx.strokeStyle = 'rgba(80, 150, 255, 0.80)';
      this.ctx.beginPath(); this.ctx.moveTo(this.config.xStart, y0); this.ctx.lineTo(this.config.xEnd, y0); this.ctx.stroke();
      this.ctx.beginPath(); this.ctx.moveTo(this.config.xStart, y1); this.ctx.lineTo(this.config.xEnd, y1); this.ctx.stroke();
      
      this.ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
      this.ctx.font = 'bold 8px monospace';
      this.ctx.fillText((i + 1).toString(), this.config.xStart - 4, (y0 + y1) / 2);
    }

    this.renderConfidence();
    this.ctx.restore();
  }

  renderConfidence() {
    if (!this.showConfidence || !this.matchResults) return;

    const pitch = this.config.charPitch;
    const scoreColor = s => s >= 0.75 ? '0,210,70' : s >= 0.50 ? '230,185,0' : '230,55,55';

    // textAlign/textBaseline are invariant for the entire overlay pass
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    for (let ri = 0; ri < Math.min(this.matchResults.length, this.rowBands.length); ri++) {
      const { y0, y1 } = this.rowBands[ri];
      const row = this.matchResults[ri];
      const cellH = y1 - y0;
      const cy = (y0 + y1) / 2;
      const showScore = pitch * this.scale >= 60;

      for (let ci = 0; ci < row.length; ci++) {
        const { char, score, blank } = row[ci];
        if (blank) continue;

        const x = Math.ceil(this.config.xStart + ci * pitch);
        const rgb = scoreColor(score);

        this.ctx.fillStyle = `rgba(${rgb},0.28)`;
        this.ctx.fillRect(x, y0, 7, 11);

        this.ctx.font = `bold ${cellH * (showScore ? 0.6 : 0.9)}px monospace`;
        this.ctx.fillStyle = `rgba(${rgb},1)`;
        this.ctx.fillText(char, x + 3.5, cy - (showScore ? cellH * 0.1 : 0));

        if (showScore) {
          this.ctx.font = `${cellH * 0.35}px monospace`;
          this.ctx.fillStyle = 'rgba(210,210,210,0.85)';
          this.ctx.fillText(score.toFixed(2), x + 3.5, cy + cellH * 0.35);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Filename helpers
  // ------------------------------------------------------------------
  async findAvailableFilename(stem) {
    if (!this.dirHandle) return `${stem}.png`;
    try { await this.dirHandle.getFileHandle(`${stem}.png`, { create: false }); }
    catch { return `${stem}.png`; }
    for (let n = 2; ; n++) {
      try { await this.dirHandle.getFileHandle(`${stem}_${n}.png`, { create: false }); }
      catch { return `${stem}_${n}.png`; }
    }
  }

  // ------------------------------------------------------------------
  // Box extraction (Dbl-click)
  // ------------------------------------------------------------------
  _extractAtEvent(e) {
    if (!this.img) return;
    const rect = this.canvas.getBoundingClientRect();
    const imgX = (e.clientX - rect.left - this.tx) / this.scale;
    const imgY = (e.clientY - rect.top - this.ty) / this.scale;

    let col = -1, hitX0 = 0, hitX1 = 0;
    for (let i = 0; i < this.config.nCols; i++) {
      const x0 = Math.ceil(this.config.xStart + i * this.config.charPitch);
      const x1 = Math.ceil(this.config.xStart + (i + 1) * this.config.charPitch);
      if (imgX >= x0 && imgX < x1) { col = i; hitX0 = x0; hitX1 = x1; break; }
    }

    const rowIdx = this.rowBands.findIndex(r => imgY >= r.y0 && imgY <= r.y1);
    const targetRow = rowIdx !== -1 ? this.rowBands[rowIdx] : null;

    if (col !== -1 && targetRow !== null) {
      this.ctx.save();
      this.ctx.translate(this.tx, this.ty);
      this.ctx.scale(this.scale, this.scale);
      this.ctx.fillStyle = 'rgba(255, 255, 0, 0.4)';
      this.ctx.fillRect(hitX0, targetRow.y0, hitX1 - hitX0, targetRow.y1 - targetRow.y0);
      this.ctx.restore();
      setTimeout(() => this.render(), 150);

      this.extractBox(col, rowIdx, targetRow.y0, targetRow.y1);
    }
  }

  onMouseDown(e) {
    if (e.button !== 0) return;

    this.dragging = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.txStart = { tx: this.tx, ty: this.ty };
    this.wrap.classList.add('dragging');
  }

  async extractBox(col, rowIdx, y0, y1) {
    const pitch = this.config.charPitch;
    const sx = this.config.xStart + col * pitch;
    if (pitch <= 0 || y1 - y0 <= 0) return;

    const off = document.createElement('canvas');
    off.width = 7; off.height = 11;
    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.img, Math.ceil(sx), y0, 7, 11, 0, 0, 7, 11);

    let suggestion = '';
    if (this.matchResults && this.matchResults[rowIdx]) {
      const m = this.matchResults[rowIdx][col];
      if (m && !m.blank) suggestion = m.char;
    }

    const label = await this.promptLabel(off, suggestion);
    if (label === null) return;

    const blob = await new Promise(resolve => off.toBlob(resolve, 'image/png'));
    const stem = this.engine.charToStem(label);

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
        this.infoEl.textContent = `Saved: ${filename} — reloading templates…`;
        await this.reloadTemplates();
      } catch { this.infoEl.textContent = `Error saving ${filename}`; }
    } else {
      const filename = `${stem}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      this.infoEl.textContent = `Downloaded: ${filename}`;
    }
  }

  async reloadTemplates() {
    if (this.dirHandle) {
      await this.engine.loadFromDir(this.dirHandle);
      if (this.img) await this.runMatching();
      return;
    }

    try {
      const res = await fetch('/api/templates');
      if (res.ok) {
        const manifest = await res.json();
        if (manifest.length) {
          await this.engine.loadFromHTTP(manifest);
          if (this.img) await this.runMatching();
          return;
        }
      }
    } catch { }
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

  onMouseMove(e) {
    if (!this.dragging) return;
    this.tx = this.txStart.tx + (e.clientX - this.dragStart.x);
    this.ty = this.txStart.ty + (e.clientY - this.dragStart.y);
    this.render();
  }

  onMouseUp() { this.dragging = false; this.wrap.classList.remove('dragging'); }
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

  document.getElementById('file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    viewer.loadURL(URL.createObjectURL(file), file.name, true);
  });

  document.getElementById('templates-btn').addEventListener('click', () => {
    viewer.loadTemplates();
  });

  const confBtn = document.getElementById('confidence-btn');
  const confLegend = document.querySelectorAll('.conf-legend');

  confBtn.textContent = 'Confidence: On';
  confBtn.classList.add('active');
  confLegend.forEach(el => el.classList.remove('hidden'));

  confBtn.addEventListener('click', () => {
    viewer.showConfidence = !viewer.showConfidence;
    confBtn.textContent = `Confidence: ${viewer.showConfidence ? 'On' : 'Off'}`;
    confBtn.classList.toggle('active', viewer.showConfidence);
    confLegend.forEach(el => el.classList.toggle('hidden', !viewer.showConfidence));
    viewer.render();
  });

  const pages = Array.from({ length: 76 }, (_, i) => `EFTA00400459_pages/page_${String(i + 1).padStart(3, '0')}.png`);
  let currentPageIndex = 0;

  const pageSelect = document.getElementById('page-select');
  const prevBtn = document.getElementById('prev-page-btn');
  const nextBtn = document.getElementById('next-page-btn');

  pages.forEach((page, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Page ${i + 1}`;
    pageSelect.appendChild(opt);
  });

  function loadPage(index) {
    if (index < 0 || index >= pages.length) return;
    currentPageIndex = index;
    pageSelect.value = index;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === pages.length - 1;
    
    fetch(pages[index])
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(blob => viewer.loadURL(URL.createObjectURL(blob), pages[index].split('/').pop(), true))
      .catch(() => { viewer.infoEl.textContent = `Could not load ${pages[index]}`; });
  }

  prevBtn.addEventListener('click', () => loadPage(currentPageIndex - 1));
  nextBtn.addEventListener('click', () => loadPage(currentPageIndex + 1));
  pageSelect.addEventListener('change', e => loadPage(parseInt(e.target.value, 10)));

  loadPage(0);

  viewer.autoLoadTemplatesFromHTTP().catch(() => { /* silent fail on file:// */ });
});

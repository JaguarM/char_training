// ocr.js — PageEngine: the whole-page grayscale buffer + RGBA access the blind
// reader (blindocr.js, wired up in training.js) reads pages through. This is
// what remains of the legacy TemplateEngine after the grid/template path was
// removed (2026-07-13) — the buffer semantics are unchanged, so raster caches
// and byte-exact reads are unaffected.
//
// Loaded after core.js, before blindocr.js/training.js. Relies on the core.js
// global `gray`. Defines the `PageEngine` global that CanvasViewer
// (training.js) instantiates.

class PageEngine {
  constructor() {
    this._c = document.createElement('canvas');
    this._ctx = this._c.getContext('2d', { willReadFrequently: true });
    this._page = null;    // { w, h, gray: Float32Array(w*h) } — whole-page grayscale
    this._pageImg = null; // the img the buffer was built from (identity key)
  }

  // Read the whole source into one grayscale Float32Array, once per page.
  // Cached by img identity (a new page is a new canvas), so it rebuilds
  // automatically when the page changes. A 1:1 blit of the full image is
  // byte-identical to blitting any sub-rectangle of it, so anything derived
  // from this buffer stays pixel-exact.
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
}

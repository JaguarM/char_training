// core.js — DOM-free core logic for char_training. Pure: no browser globals,
// no side effects on load. Runs as a browser <script> (attaches exports as
// globals for training.js) and as a Node module (require → exports; see test.js).
(function (root) {
  'use strict';

  // Stem ↔ char mapping, used when saving crops as template PNGs.
  // '_' needs a NAMED stem: a literal '_' collides with the stem_variant separator —
  // stemToChar('__1') splits to '', and every loader silently drops the template.
  const STEM_TO_CHAR = { less: '<', greater: '>', colon: ':', doublequote: '"', slash: '/', backslash: '\\', pipe: '|', question: '?', asterisk: '*', eq: '=', plus: '+', minus: '-', caret: '^', tilde: '~', period: '.', comma: ',', semicolon: ';', exclamation: '!', quote: "'", backtick: '`', lparen: '(', rparen: ')', lbracket: '[', rbracket: ']', lbrace: '{', rbrace: '}', at: '@', hash: '#', dollar: '$', percent: '%', ampersand: '&', underscore: '_' };
  const CHAR_TO_STEM = Object.fromEntries(Object.entries(STEM_TO_CHAR).map(([k, v]) => [v, k]));

  function charToStem(label) {
    return CHAR_TO_STEM[label] ??
      (label.length === 1 && label >= 'A' && label <= 'Z' ? label + '_UPPER' : label);
  }

  function stemToChar(stem) {
    const base = stem.split('_')[0];
    return STEM_TO_CHAR[base] ?? (stem.includes('_UPPER') ? stem.split('_UPPER')[0] : base);
  }

  // Tuning constants.
  const EXACT_MATCH = 1.0;        // score of a pixel-identical match (drawn green)
  const BLANK_STDDEV = 5;         // crop with per-pixel std-dev below this is a gap
  const TEMPLATE_LEFT_CROP = 1;   // read/save crops this many px right of the advance,
                                  // so a saved template aligns pixel-for-pixel with the page
  const PLACEHOLDER = '□';        // stands in (orange) for a glyph that matched no template

  // Row bands: rowCount × { y0 = rowBase + i*rowPitch, y1 = y0 + rowHeight }.
  function makeRowBands(rowBase, rowHeight, rowPitch, rowCount) {
    return Array.from({ length: rowCount }, (_, i) => {
      const y0 = rowBase + i * rowPitch;
      return { y0, y1: y0 + rowHeight };
    });
  }

  // Pixel math.

  // Average R,G,B of each pixel of an RGBA buffer into n grayscale values (alpha ignored).
  function gray(data, n) {
    const px = new Float32Array(n);
    for (let i = 0; i < n; i++) px[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    return px;
  }

  // Mean and L2 (sqrt of summed squared deviation) of a grayscale buffer.
  function stats(px) {
    const n = px.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += px[i];
    const mean = s / n;
    let sq = 0;
    for (let i = 0; i < n; i++) { const v = px[i] - mean; sq += v * v; }
    return { mean, l2: Math.sqrt(sq) };
  }

  // A crop is "blank" (a gap) when its per-pixel std-dev is below BLANK_STDDEV.
  function isBlankPixels(px) {
    return stats(px).l2 / Math.sqrt(px.length) < BLANK_STDDEV;
  }

  // Exact pixel equality (the test behind matchAt): same length, every element identical.
  function pixelsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // FNV-1a hash over a grayscale buffer's raw float bits, starting at element `from`.
  // Bit-pattern hashing is equality-safe here: gray() only produces non-negative
  // finite values (no -0/NaN), so equal pixels have equal bits. `from = 1` gives the
  // poke-tolerant variant (everything but col 0 of row 0 — see pixelsEqualPokeTolerant).
  // Templates hashed once at load; a crop hashed once per probe then found by Map
  // lookup — replacing the compare-against-every-template scan in matchAt.
  function hashPixels(px, from) {
    const u = new Uint32Array(px.buffer, px.byteOffset, px.length);
    let h = 0x811c9dc5;
    for (let i = from; i < u.length; i++) {
      h = Math.imul(h ^ u[i], 0x01000193);
    }
    return h >>> 0;
  }

  // Like pixelsEqual but tolerates col 0 of row 0 differing. Used for poke-left glyphs
  // (T V W Y …) where the top row extends 1px further left than the template's bounding
  // box, changing the anti-aliased edge pixel at that column. Rows 1..h-1 must be exact;
  // row 0, cols 1..w-1 must be exact; only col 0 of row 0 is allowed to differ.
  function pixelsEqualPokeTolerant(a, b, w) {
    if (a.length !== b.length || a.length < w) return false;
    for (let col = 1; col < w; col++) if (a[col] !== b[col]) return false;
    for (let i = w; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Strided variants of the crop primitives above. They read the w×h window at
  // (x0, y0) directly out of the whole-page buffer (row stride PW) instead of
  // requiring the caller to copy the window out first — the copy + allocation per
  // probe per size group was most of matchAt. Each visits the SAME float values in
  // the SAME row-major order as its copying counterpart on cropPixels output, so
  // results are bit-identical (hash: same FNV input sequence; stats: same float
  // addition order). Callers must ensure the window is fully inside the page —
  // cropPixels' zero-padding of off-page reads has no equivalent here, so edge
  // windows keep using the copying path.

  // hashPixels of the window, `from` elements skipped (0 = exact, 1 = poke: skip
  // col 0 of row 0). u32 is a Uint32Array view over the page's Float32 buffer.
  function hashPixelsStrided(u32, PW, x0, y0, w, h, from) {
    let hsh = 0x811c9dc5;
    for (let r = 0; r < h; r++) {
      const idx = (y0 + r) * PW + x0;
      for (let c = r === 0 ? from : 0; c < w; c++) {
        hsh = Math.imul(hsh ^ u32[idx + c], 0x01000193);
      }
    }
    return hsh >>> 0;
  }

  // hashPixels in COLUMN-major order (col asc, row asc within col) over a
  // row-major w×h buffer; `from` elements of that order skipped (0 = exact,
  // 1 = poke: element 0 is col 0 of row 0 in either order). Column-major keys
  // let matchAt hash one probe window INCREMENTALLY across template widths —
  // one chain with a checkpoint per width instead of one full pass per size
  // group. Template maps and probe chains must both use this order.
  function hashPixelsCM(px, w, h, from) {
    const u = new Uint32Array(px.buffer, px.byteOffset, px.length);
    let hsh = 0x811c9dc5;
    for (let c = 0; c < w; c++) {
      for (let r = c === 0 ? from : 0; r < h; r++) {
        hsh = Math.imul(hsh ^ u[r * w + c], 0x01000193);
      }
    }
    return hsh >>> 0;
  }

  // hashPixelsCM skipping the pixels a STAIN may cover: the bottom 3 rows (a
  // redaction box overlapping the band from below covers them — full black plus one
  // anti-aliased edge row — and a box in the band below draws its edge line through
  // row h−1; 3 = the same POKE_CROP margin the reader's blank tests ignore) and,
  // when `corner` (used for w ≥ 4 groups), the 2×2 top-left corner (a left
  // neighbour's overhang — an f hook — poking further into the window than it did
  // in the harvested variant). Template maps and probe chains must skip the
  // identical pixels in the identical column-major order.
  function hashPixelsCMStain(px, w, h, corner) {
    const u = new Uint32Array(px.buffer, px.byteOffset, px.length);
    let hsh = 0x811c9dc5;
    for (let c = 0; c < w; c++) {
      for (let r = 0; r < h; r++) {
        if (r >= h - 3 || (corner && r < 2 && c < 2)) continue;
        hsh = Math.imul(hsh ^ u[r * w + c], 0x01000193);
      }
    }
    return hsh >>> 0;
  }

  // pixelsEqual with stain tolerance: pixels in the stain zones (same zones as
  // hashPixelsCMStain) may only be DARKER than the template — box edges and
  // neighbour overhangs composite ink over the glyph, never remove it — and every
  // other pixel must match exactly. Every template keeps ink above the stain rows,
  // so a bare stain line (or a gap under one) can never fake a whole glyph.
  function pixelsEqualStainTolerantStrided(g, PW, x0, y0, b, w, h, corner) {
    if (b.length !== w * h) return false;
    let i = 0;
    for (let r = 0; r < h; r++) {
      const idx = (y0 + r) * PW + x0;
      for (let c = 0; c < w; c++, i++) {
        const v = g[idx + c];
        if (r >= h - 3 || (corner && r < 2 && c < 2)) {
          if (v > b[i]) return false;      // lighter than the template: not a stain
        } else if (v !== b[i]) return false;
      }
    }
    return true;
  }

  // pixelsEqual(window, b) — b is a template's row-major w×h buffer.
  function pixelsEqualStrided(g, PW, x0, y0, b, w, h) {
    if (b.length !== w * h) return false;
    let i = 0;
    for (let r = 0; r < h; r++) {
      const idx = (y0 + r) * PW + x0;
      for (let c = 0; c < w; c++, i++) if (g[idx + c] !== b[i]) return false;
    }
    return true;
  }

  // pixelsEqualPokeTolerant(window, b, w) — element 0 (col 0 of row 0) may differ.
  function pixelsEqualPokeTolerantStrided(g, PW, x0, y0, b, w, h) {
    if (b.length !== w * h || b.length < w) return false;
    let i = 0;
    for (let r = 0; r < h; r++) {
      const idx = (y0 + r) * PW + x0;
      for (let c = 0; c < w; c++, i++) {
        if (i !== 0 && g[idx + c] !== b[i]) return false;
      }
    }
    return true;
  }

  // isBlankPixels of the window: same two-pass mean/L2 as stats(), same order.
  function isBlankStrided(g, PW, x0, y0, w, h) {
    const n = w * h;
    let s = 0;
    for (let r = 0; r < h; r++) {
      const idx = (y0 + r) * PW + x0;
      for (let c = 0; c < w; c++) s += g[idx + c];
    }
    const mean = s / n;
    let sq = 0;
    for (let r = 0; r < h; r++) {
      const idx = (y0 + r) * PW + x0;
      for (let c = 0; c < w; c++) { const v = g[idx + c] - mean; sq += v * v; }
    }
    return Math.sqrt(sq) / Math.sqrt(n) < BLANK_STDDEV;
  }

  // Export to Node (module.exports) or attach to the browser global.
  const api = {
    STEM_TO_CHAR, CHAR_TO_STEM, charToStem, stemToChar,
    EXACT_MATCH, BLANK_STDDEV, TEMPLATE_LEFT_CROP, PLACEHOLDER,
    makeRowBands, gray, stats, isBlankPixels, pixelsEqual, pixelsEqualPokeTolerant,
    hashPixels,
    hashPixelsStrided, pixelsEqualStrided, pixelsEqualPokeTolerantStrided, isBlankStrided,
    hashPixelsCM, hashPixelsCMStain, pixelsEqualStainTolerantStrided,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    for (const k in api) root[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this);

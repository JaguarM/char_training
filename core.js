// core.js — DOM-free core logic for char_training. Pure: no browser globals,
// no side effects on load. Runs as a browser <script> (attaches exports as
// globals for training.js) and as a Node module (require → exports; see test.js).
//
// The template-matching pixel primitives (hashing, strided equality, stain
// tolerance) left with the legacy grid/template path (removed 2026-07-13);
// what remains serves the viewer and the blind reader.
(function (root) {
  'use strict';

  // Stem ↔ char mapping, used when saving glyph crops as PNGs (dbl-click extract).
  // '_' needs a NAMED stem: a literal '_' collides with the stem_variant separator —
  // stemToChar('__1') splits to '', and loaders would silently drop the file.
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

  // Display constants.
  const TEMPLATE_LEFT_CROP = 1;   // glyph crops start this many px right of the advance
  const PLACEHOLDER = '□';        // stands in (orange) for an unreadable glyph cluster

  // Row bands: rowCount × { y0 = rowBase + i*rowPitch, y1 = y0 + rowHeight }.
  function makeRowBands(rowBase, rowHeight, rowPitch, rowCount) {
    return Array.from({ length: rowCount }, (_, i) => {
      const y0 = rowBase + i * rowPitch;
      return { y0, y1: y0 + rowHeight };
    });
  }

  // Average R,G,B of each pixel of an RGBA buffer into n grayscale values
  // (alpha ignored). THE page-buffer law: the raster cache stores exactly
  // these values (see bench/raster-cache-browser.js), so cached and live
  // pages are bit-identical.
  function gray(data, n) {
    const px = new Float32Array(n);
    for (let i = 0; i < n; i++) px[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    return px;
  }

  // Export to Node (module.exports) or attach to the browser global.
  const api = {
    STEM_TO_CHAR, CHAR_TO_STEM, charToStem, stemToChar,
    TEMPLATE_LEFT_CROP, PLACEHOLDER,
    makeRowBands, gray,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    for (const k in api) root[k] = api[k];
  }
})(typeof self !== 'undefined' ? self : this);

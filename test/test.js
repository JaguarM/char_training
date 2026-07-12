// ---------------------------------------------------------------------------
// test.js — headless smoke tests for the DOM-free core (core.js).
//
// Dependency-free: only Node's built-in node:test + node:assert. No npm
// install, no PDF, no browser, no assets. Run with:
//
//     node test.js          (or:  node --test)
//
// It exits non-zero if anything fails. (The template-matching pixel-math
// tests left with the legacy grid/template path, removed 2026-07-13.)
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core.js');

test('charToStem / stemToChar round-trips', () => {
  // A–Z uppercase → <letter>_UPPER and back
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    assert.strictEqual(core.charToStem(ch), ch + '_UPPER');
    assert.strictEqual(core.stemToChar(ch + '_UPPER'), ch);
  }

  // digits 0–9 map to themselves
  for (let d = 0; d <= 9; d++) {
    const ch = String(d);
    assert.strictEqual(core.charToStem(ch), ch);
    assert.strictEqual(core.stemToChar(ch), ch);
  }

  // lowercase letters map to themselves
  for (let c = 'a'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    assert.strictEqual(core.charToStem(ch), ch);
    assert.strictEqual(core.stemToChar(ch), ch);
  }

  // the symbol map round-trips both ways
  for (const [stem, ch] of Object.entries(core.STEM_TO_CHAR)) {
    assert.strictEqual(core.charToStem(ch), stem, `charToStem(${ch})`);
    assert.strictEqual(core.stemToChar(stem), ch, `stemToChar(${stem})`);
  }

  // a numbered variant still resolves to its base character
  assert.strictEqual(core.stemToChar('a_3'), 'a');
  assert.strictEqual(core.stemToChar('B_UPPER_2'), 'B');
});

test('makeRowBands produces rowCount bands with correct y0/y1', () => {
  const bands = core.makeRowBands(40, 11, 15, 65);
  assert.strictEqual(bands.length, 65);
  assert.deepStrictEqual(bands[0], { y0: 40, y1: 51 });
  assert.deepStrictEqual(bands[1], { y0: 55, y1: 66 });
  assert.deepStrictEqual(bands[64], { y0: 40 + 64 * 15, y1: 40 + 64 * 15 + 11 });

  // a second, different Config to be sure the formula isn't hard-coded
  const other = core.makeRowBands(0, 10, 10, 3);
  assert.deepStrictEqual(other, [
    { y0: 0, y1: 10 }, { y0: 10, y1: 20 }, { y0: 20, y1: 30 },
  ]);
});

test('gray maps a known RGBA buffer to the expected grayscale values', () => {
  // white, black, and (30,60,90) → averaged channels; alpha is ignored
  const data = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 0,
    30, 60, 90, 255,
  ]);
  const px = core.gray(data, 3);
  assert.strictEqual(px.length, 3);
  assert.strictEqual(px[0], 255);
  assert.strictEqual(px[1], 0);
  assert.strictEqual(px[2], 60); // (30 + 60 + 90) / 3
});

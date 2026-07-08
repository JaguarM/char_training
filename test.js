// ---------------------------------------------------------------------------
// test.js — headless smoke tests for the DOM-free core (core.js).
//
// Dependency-free: only Node's built-in node:test + node:assert. No npm
// install, no PDF, no browser, no assets. Run with:
//
//     node test.js          (or:  node --test)
//
// It exits non-zero if anything fails.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const core = require('./core.js');

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

test('blank / std-dev threshold classifies flat vs inked buffers', () => {
  // a perfectly flat buffer has zero std-dev → blank
  const flat = new Float32Array(100).fill(200);
  assert.strictEqual(core.isBlankPixels(flat), true);

  // a buffer with strong black-on-white contrast is clearly not blank
  const inked = new Float32Array(100).fill(255);
  for (let i = 0; i < 20; i++) inked[i] = 0;
  assert.strictEqual(core.isBlankPixels(inked), false);
});

test('exact pixel-equality: identical true, one-pixel diff false', () => {
  const a = new Float32Array([1, 2, 3, 4]);
  const b = new Float32Array([1, 2, 3, 4]);
  const c = new Float32Array([1, 2, 3, 5]);
  assert.strictEqual(core.pixelsEqual(a, b), true);
  assert.strictEqual(core.pixelsEqual(a, c), false);
  // differing lengths are never equal
  assert.strictEqual(core.pixelsEqual(a, new Float32Array([1, 2, 3])), false);
});

test('pixelsEqualPokeTolerant: tolerates col 0 of row 0, requires exact elsewhere', () => {
  // 3 columns wide, 2 rows tall: layout [r0c0, r0c1, r0c2, r1c0, r1c1, r1c2]
  const W = 3;
  const base  = new Float32Array([10, 20, 30,  40, 50, 60]);
  // col 0 of row 0 differs → should still match
  const pokeL = new Float32Array([99, 20, 30,  40, 50, 60]);
  assert.strictEqual(core.pixelsEqualPokeTolerant(pokeL, base, W), true);
  // identical → also matches
  assert.strictEqual(core.pixelsEqualPokeTolerant(base, base, W), true);
  // col 1 of row 0 differs → must NOT match
  const diffR0 = new Float32Array([10, 99, 30,  40, 50, 60]);
  assert.strictEqual(core.pixelsEqualPokeTolerant(diffR0, base, W), false);
  // col 0 of row 1 differs → must NOT match
  const diffR1 = new Float32Array([10, 20, 30,  99, 50, 60]);
  assert.strictEqual(core.pixelsEqualPokeTolerant(diffR1, base, W), false);
  // differing lengths → false
  assert.strictEqual(core.pixelsEqualPokeTolerant(base, new Float32Array(5), W), false);
});

test('strided variants agree exactly with copy-out + copying primitives', () => {
  // A deterministic pseudo-random "page" (float values like gray() produces:
  // k/3 for integer k in 0..765) and every window position/size across it.
  const PW = 23, PH = 17;
  const page = new Float32Array(PW * PH);
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  for (let i = 0; i < page.length; i++) page[i] = (rnd() % 766) / 3;
  const u32 = new Uint32Array(page.buffer, page.byteOffset, page.length);

  // copy-out of the window, the reference the strided variants must reproduce
  const copyOut = (x0, y0, w, h) => {
    const out = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) out[r * w + c] = page[(y0 + r) * PW + x0 + c];
    return out;
  };

  for (const [w, h] of [[1, 9], [4, 11], [7, 12], [12, 15]]) {
    for (let y0 = 0; y0 + h <= PH; y0 += 3) {
      for (let x0 = 0; x0 + w <= PW; x0 += 2) {
        const px = copyOut(x0, y0, w, h);
        assert.strictEqual(
          core.hashPixelsStrided(u32, PW, x0, y0, w, h, 0), core.hashPixels(px, 0));
        assert.strictEqual(
          core.hashPixelsStrided(u32, PW, x0, y0, w, h, 1), core.hashPixels(px, 1));
        assert.strictEqual(
          core.isBlankStrided(page, PW, x0, y0, w, h), core.isBlankPixels(px));
        // equality against the window's own copy, and against a mutant of it
        assert.strictEqual(core.pixelsEqualStrided(page, PW, x0, y0, px, w, h), true);
        assert.strictEqual(
          core.pixelsEqualPokeTolerantStrided(page, PW, x0, y0, px, w, h), true);
        const mut = px.slice(); mut[mut.length >> 1] += 1;
        assert.strictEqual(core.pixelsEqualStrided(page, PW, x0, y0, mut, w, h),
          core.pixelsEqual(px, mut));
        assert.strictEqual(
          core.pixelsEqualPokeTolerantStrided(page, PW, x0, y0, mut, w, h),
          core.pixelsEqualPokeTolerant(px, mut, w));
        // poke pixel (element 0) may differ — in both variants
        const poke = px.slice(); poke[0] += 1;
        assert.strictEqual(
          core.pixelsEqualPokeTolerantStrided(page, PW, x0, y0, poke, w, h), true);
        assert.strictEqual(core.pixelsEqualStrided(page, PW, x0, y0, poke, w, h), false);
      }
    }
  }

  // length-mismatched template buffers are never equal
  assert.strictEqual(core.pixelsEqualStrided(page, PW, 0, 0, new Float32Array(5), 2, 3), false);
  assert.strictEqual(
    core.pixelsEqualPokeTolerantStrided(page, PW, 0, 0, new Float32Array(5), 2, 3), false);
});

test('column-major chain checkpoints equal hashPixelsCM at every width', () => {
  // Same page fixture idea as above; replicate matchAt's incremental sweep and
  // check each width's checkpoint against hashPixelsCM of the equivalent
  // copied-out window (the key _setTemplates puts in mapCM/pokeMapCM).
  const PW = 19, PH = 16;
  const page = new Float32Array(PW * PH);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  for (let i = 0; i < page.length; i++) page[i] = (rnd() % 766) / 3;
  const u32 = new Uint32Array(page.buffer, page.byteOffset, page.length);

  const copyOut = (x0, y0, w, h) => {
    const out = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) out[r * w + c] = page[(y0 + r) * PW + x0 + c];
    return out;
  };

  for (const h of [1, 9, 15]) {
    for (const [x0, y0] of [[0, 0], [3, 1], [6, PH - h]]) {
      const maxW = Math.min(12, PW - x0);
      let hE = 0x811c9dc5, hP = 0x811c9dc5;
      for (let c = 0; c < maxW; c++) {
        let idx = y0 * PW + x0 + c;
        for (let r = 0; r < h; r++, idx += PW) {
          const v = u32[idx];
          hE = Math.imul(hE ^ v, 0x01000193);
          if (c | r) hP = Math.imul(hP ^ v, 0x01000193);
        }
        const w = c + 1, win = copyOut(x0, y0, w, h);
        assert.strictEqual(hE >>> 0, core.hashPixelsCM(win, w, h, 0), `exact w=${w} h=${h}`);
        assert.strictEqual(hP >>> 0, core.hashPixelsCM(win, w, h, 1), `poke w=${w} h=${h}`);
      }
    }
  }
});

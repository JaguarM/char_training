// ---------------------------------------------------------------------------
// engine.test.js — fast, isolated unit tests for the engine primitives in
// src/ocr-engine.js (detectObjects, findBands, quantMap, anchorGroups,
// scanLine, spaceCalib, readPage).
//
// Dependency-free and corpus-free: synthetic glyph sets and pages are
// fabricated in memory and rendered through the SAME proven blend law the
// scanner checks (dst = (dst·(256−e))>>8, e = cov + (cov>>7)), so every
// assertion exercises the real acceptance physics. Runs in milliseconds:
//
//     node test/engine.test.js
//
// This is the quick "did I break something" signal for engine edits; the
// full corpus gate (npm run gate) and app test remain the final
// certification. Glyph records here mirror the exact shape
// tools/glyph-bundle.mjs materializeSet produces ({ch, adv, phx, w, h, dx,
// dy, bytes, alpha, ink, inkC/R/B/A, inkLeft}).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/ocr-engine.js');

// ---- synthetic glyph / page helpers ----

// pattern rows: '#' = full ink (alpha 255), '+' = half ink (alpha 128),
// '.' = blank. Page byte over white is gb = (255·(256−e))>>8 by the law.
const ALPHA = { '#': 255, '+': 128, '~': 55, '.': 0 };
const gbOf = a => { const e = a + (a >> 7); return (255 * (256 - e)) >> 8; };

function makeGlyph(ch, pattern, { dy, adv, dx = 0, phx = 0 }) {
  const h = pattern.length, w = pattern[0].length;
  const bytes = new Uint8Array(w * h).fill(255);
  const alpha = new Uint8Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const a = ALPHA[pattern[r][c]];
      if (a) { alpha[r * w + c] = a; bytes[r * w + c] = gbOf(a); }
    }
  // ink in the loader's column-major order (candidate order is significant)
  const ink = [];
  let inkLeft = w;
  for (let c = 0; c < w; c++)
    for (let r = 0; r < h; r++)
      if (bytes[r * w + c] < 255) { ink.push(r * w + c); if (c < inkLeft) inkLeft = c; }
  const inkC = new Int16Array(ink.length), inkR = new Int16Array(ink.length),
    inkB = new Uint8Array(ink.length), inkA = new Uint8Array(ink.length);
  for (let k = 0; k < ink.length; k++) {
    inkC[k] = ink[k] % w; inkR[k] = (ink[k] / w) | 0;
    inkB[k] = bytes[ink[k]]; inkA[k] = alpha[ink[k]];
  }
  return { ch, adv, phx, w, h, dx, dy, bytes, alpha, ink, inkC, inkR, inkB, inkA, inkLeft };
}

function makeSet(name, glyphs, phy = 0) {
  let maxAsc = 0, maxDesc = 0;
  for (const g of glyphs) {
    maxAsc = Math.max(maxAsc, -g.dy);
    maxDesc = Math.max(maxDesc, g.dy + g.h);
  }
  return { name, sizePx: 16, linear: false, fontFile: name,
    byPhy: new Map([[phy, glyphs]]), maxAsc, maxDesc };
}

const makePage = (w, h) => ({ w, h, gray: new Uint8Array(w * h).fill(255) });
const zeroMask = page => new Uint8Array(page.w * page.h);

// composite a glyph onto the page through the blend law (over white this
// reproduces the glyph's bytes exactly — same construction as the renderer)
function drawGlyph(page, g, pen, baseline) {
  for (let k = 0; k < g.inkC.length; k++) {
    const x = pen + g.dx + g.inkC[k], y = baseline + g.dy + g.inkR[k];
    const a = g.inkA[k], e = a + (a >> 7);
    page.gray[y * page.w + x] = (page.gray[y * page.w + x] * (256 - e)) >> 8;
  }
}

// the shared 5-row test font: three distinct letters, all ink on/above the
// baseline (dy = −5), advance 6 px
const PAT = {
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
};
function abcSet() {
  return makeSet('synth', Object.entries(PAT).map(([ch, p]) =>
    makeGlyph(ch, p, { dy: -5, adv: 6 })));
}
function drawWord(page, set, word, pens, baseline) {
  const byCh = new Map(set.byPhy.get(0).map(g => [g.ch, g]));
  [...word].forEach((ch, i) => drawGlyph(page, byCh.get(ch), pens[i], baseline));
}

// ---- quantMap ----

test('quantMap: nearest available gray, ties toward darker, fixpoints', () => {
  const page = makePage(4, 1);
  page.gray.set([0, 100, 255, 255]);
  const Q = E.quantMap(page);
  assert.strictEqual(Q[0], 0);        // available bytes are fixpoints
  assert.strictEqual(Q[100], 100);
  assert.strictEqual(Q[255], 255);
  assert.strictEqual(Q[49], 0);       // nearest
  assert.strictEqual(Q[51], 100);
  assert.strictEqual(Q[50], 0);       // tie → darker
  assert.strictEqual(Q[200], 255);    // |200−100|=100 > |200−255|=55
});

// ---- findBands ----

test('findBands: blank-row-separated ink bands; mask pixels are invisible', () => {
  const page = makePage(20, 20);
  for (const y of [3, 4, 5, 10, 11, 12]) page.gray[y * 20 + 7] = 0;
  const mask = zeroMask(page);
  assert.deepStrictEqual(E.findBands(page, mask), [[3, 6], [10, 13]]);
  for (const y of [10, 11, 12]) mask[y * 20 + 7] = 1;   // masked → band gone
  assert.deepStrictEqual(E.findBands(page, mask), [[3, 6]]);
});

// ---- detectObjects ----

test('detectObjects: text-sized ink produces NO objects', () => {
  const page = makePage(60, 30);
  drawWord(page, abcSet(), 'ABC', [10, 16, 22], 20);
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 0);
  assert.ok(mask.every(v => v === 0));
});

test('detectObjects: dark horizontal rule (≥40px run) with ±2-row mask pad', () => {
  const page = makePage(80, 30);
  for (let x = 5; x < 56; x++) page.gray[10 * 80 + x] = 0;
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'rule');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [10, 11, 5, 56]);
  assert.strictEqual(mask[8 * 80 + 30], 1);   // rules pad ±2 rows
  assert.strictEqual(mask[12 * 80 + 30], 1);
  assert.strictEqual(mask[13 * 80 + 30], 0);
});

test('detectObjects: near-constant LIGHT run ≥40px is a rule too', () => {
  const page = makePage(80, 30);
  for (let x = 5; x < 50; x++) page.gray[10 * 80 + x] = 200;
  const { objects } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  assert.strictEqual(objects[0].type, 'rule');
});

test('detectObjects: vertical rule down a column', () => {
  const page = makePage(80, 60);
  for (let y = 5; y < 55; y++) page.gray[y * 80 + 70] = 0;
  const { objects } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'vrule');
  assert.deepStrictEqual([o.x0, o.x1, o.y0, o.y1], [70, 71, 5, 55]);
});

test('detectObjects: small solid redaction box (10–39px runs, ≥8 rows)', () => {
  const page = makePage(80, 60);
  for (let y = 30; y < 42; y++)
    for (let x = 10; x < 30; x++) page.gray[y * 80 + x] = 0;
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'box');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [30, 42, 10, 30]);
  assert.strictEqual(mask[35 * 80 + 20], 1);          // interior masked
  assert.strictEqual(mask[35 * 80 + 40], 0);          // beside it: not masked
});

test('detectObjects: wide solid box goes through mode-voted segmentation', () => {
  const page = makePage(100, 60);
  for (let y = 20; y < 34; y++)
    for (let x = 10; x < 70; x++) page.gray[y * 100 + x] = 0;
  const { objects } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'box');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [20, 34, 10, 70]);
});

// ---- unionSets ----

test('unionSets: merges pools, tags per-glyph src and lin', () => {
  const a = makeSet('a', [makeGlyph('A', PAT.A, { dy: -5, adv: 6 })]);
  const b = makeSet('b', [makeGlyph('B', PAT.B, { dy: -5, adv: 6 })]);
  b.linear = true;
  const u = E.unionSets([a, b]);
  assert.strictEqual(u.name, 'a+b');
  assert.strictEqual(u.linear, true);
  const pool = u.byPhy.get(0);
  assert.deepStrictEqual(pool.map(g => [g.ch, g.src, g.lin]),
    [['A', 'a', false], ['B', 'b', true]]);
  assert.strictEqual(u.maxAsc, 5);
});

// ---- anchorGroups ----

test('anchorGroups: builds group + chain index; span > 64 falls back to null', () => {
  const set = abcSet();
  const idx = E.anchorGroups(set, 0, null, 0);
  assert.ok(idx && idx.groups.length >= 1);
  const members = idx.groups.flatMap(g => g.subs.flatMap(s => s.members));
  assert.strictEqual(members.length, 3);
  assert.ok(idx.chain[0]);                             // phx 0 → phase bucket 0
  const tall = { byPhy: new Map([[0, []]]), maxAsc: 40, maxDesc: 30 };
  assert.strictEqual(E.anchorGroups(tall, 0, null, 0), null);
});

// ---- scanLine ----

test('scanLine: reads back a rendered word byte-exactly, clean certificate', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'B', 'C']);
  assert.deepStrictEqual(L.glyphs.map(g => g.pen), [10, 16, 22]);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('scanLine: unknown ink becomes ONE □ fail, no hallucinated glyphs', () => {
  const set = abcSet(), page = makePage(60, 30);
  for (let y = 15; y < 20; y++)                        // checkerboard blob ∉ dict
    for (let x = 30; x < 34; x++)
      if ((x + y) & 1) page.gray[y * 60 + x] = 0;
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.strictEqual(L.glyphs.length, 0);
  assert.strictEqual(L.fails.length, 1);
});

test('scanLine: a bad glyph mid-word fails alone — neighbours still read', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'AC', [10, 22], 20);
  for (let y = 15; y < 20; y++)                        // blob where B would sit
    for (let x = 16; x < 20; x++)
      if ((x + y) & 1) page.gray[y * 60 + x] = 0;
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'C']);
  assert.strictEqual(L.fails.length, 1);
});

test('scanLine: object-mask pixels are don\'t-care, not fails', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'AC', [10, 22], 20);
  const mask = zeroMask(page);
  for (let y = 14; y < 21; y++)                        // pretend a box covers 16..20
    for (let x = 16; x < 21; x++) {
      page.gray[y * 60 + x] = 0;
      mask[y * 60 + x] = 1;
    }
  const L = E.scanLine(page, mask, set, 0, 20, 0, 60);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'C']);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('scanLine: kerned AA overlap composites through the blend law', () => {
  // two half-ink glyphs overlapping one column: the shared pixels are a true
  // composite (126 over 126 → 62), so this exercises tryCand's non-fresh
  // branch AND the accept-blend prediction — the paths the fresh-canvas fast
  // path skips (a wrong e/shift here is invisible to non-overlapping text)
  // alphas 55 (gb 200) and 128 (gb 126) chosen so the composite 200·127>>8
  // = 99 actually moves if e is off by one (126-over-126 wouldn't — both
  // floor to 62 and a wrong e passes unseen)
  const n = makeGlyph('n', ['~~~', '~~~', '~~~'], { dy: -3, adv: 2 });
  const m = makeGlyph('m', ['+++', '+++', '+++'], { dy: -3, adv: 2 });
  const set = makeSet('ov', [n, m]);
  const page = makePage(40, 30);
  drawGlyph(page, n, 10, 20);
  drawGlyph(page, m, 12, 20);                          // overlap column 12
  assert.strictEqual(page.gray[18 * 40 + 12], 99);     // composite by the law
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 40);
  assert.deepStrictEqual(L.glyphs.map(g => [g.ch, g.pen]), [['n', 10], ['m', 12]]);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('scanLine: TOL relaxes byte-exactness; 0 stays strict', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);
  page.gray[17 * 60 + 10]++;                           // one A ink byte off by +1
  const strict = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.ok(strict.fails.length > 0);
  const tol = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60,
    Infinity, Infinity, 1);
  assert.deepStrictEqual(tol.glyphs.map(g => g.ch), ['A', 'B', 'C']);
  assert.strictEqual(tol.fails.length, 0);
  assert.strictEqual(tol.residual, 0);
});

test('scanLine: palette-quantized page reads through QUANT, fails without', () => {
  const d = makeGlyph('d', ['+##+', '#..#', '+##+'], { dy: -3, adv: 6 });
  const set = makeSet('q', [d]);
  const page = makePage(40, 30);
  drawGlyph(page, d, 10, 20);
  for (let i = 0; i < page.gray.length; i++)           // producer palettizes to {0,255}
    page.gray[i] = page.gray[i] < 128 ? 0 : 255;
  const bare = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 40);
  assert.ok(bare.fails.length > 0);                    // AA bytes ≠ law without the map
  const Q = E.quantMap(page);
  const q = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 40,
    Infinity, Infinity, 0, Q);
  assert.deepStrictEqual(q.glyphs.map(g => g.ch), ['d']);
  assert.strictEqual(q.fails.length, 0);
  assert.strictEqual(q.residual, 0);
});

// ---- spaceCalib ----

test('spaceCalib: recovers the space width from clustered gaps', () => {
  const glyphs = [];
  let pen = 0;
  for (const gap of [0, 4, 4, 0, 4, 0]) {              // adv 6 + measured gaps
    glyphs.push({ pen, adv: 6 });
    pen += 6 + gap;
  }
  glyphs.push({ pen, adv: 6 });
  const sp = E.spaceCalib([{ glyphs }]);
  assert.ok(Math.abs(sp - 4) < 1e-9, `space ${sp}`);
  assert.strictEqual(E.spaceCalib([{ glyphs: glyphs.slice(0, 2) }]), null);
});

// ---- readPage ----

test('readPage: blind end-to-end — bands, baseline pinning, objects, clean lines', async () => {
  const set = abcSet(), page = makePage(80, 70);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);        // band 15..20
  drawWord(page, set, 'CBA', [10, 16, 22], 40);        // band 35..40
  for (let x = 10; x < 60; x++) page.gray[50 * 80 + x] = 0;   // a rule object
  const { lines, objects } = await E.readPage(page, [set]);
  assert.strictEqual(objects.length, 1);
  assert.strictEqual(objects[0].type, 'rule');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')),
    ['ABC', 'CBA']);
  assert.deepStrictEqual(lines.map(L => L.baseline), [20, 40]);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.strictEqual(L.font, 'synth');
  }
});

test('readPage: unreadable band is an honest □ line, not silence', async () => {
  const set = abcSet(), page = makePage(80, 40);
  for (let y = 15; y < 20; y++)
    for (let x = 30; x < 34; x++)
      if ((x + y) & 1) page.gray[y * 80 + x] = 0;
  const { lines } = await E.readPage(page, [set]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].set, null);
  assert.strictEqual(lines[0].fails.length, 1);
});

// ---- stacked bands (line pitch < maxAsc + maxDesc: rows interleave) ----

// tall/descender font: maxAsc 8 ('J'/'T'), maxDesc 4 ('q', unused on page,
// present so the scan window reaches a neighbour line's glued rows)
function tallSet() {
  return makeSet('tall', [
    makeGlyph('A', ['.##.', '#..#', '####', '#..#', '#..#'], { dy: -5, adv: 6 }),
    makeGlyph('y', ['#.#', '#.#', '#.#', '.##', '..#', '..#', '..#', '##.'], { dy: -5, adv: 6 }),
    makeGlyph('q', ['###', '#.#', '###', '..#', '..#', '..#', '..#', '..#', '..#'], { dy: -5, adv: 6 }),
    makeGlyph('J', ['###', '...', '.#.', '.#.', '.#.', '.#.', '#.#', '.#.'], { dy: -8, adv: 6 }),
    makeGlyph('T', ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.'], { dy: -8, adv: 6 }),
  ]);
}

test('readPage: one band holding two stacked lines splits and reads both', async () => {
  // 'yy' baseline 50 (ink 45..52) touches 'TT' baseline 61 (ink 53..60):
  // ONE contiguous band; the picked bottom line cannot reach rows 45..52,
  // so the band must split and read the upper line first — and the upper
  // segment's judging must stop at the split boundary (T's top row 53).
  const set = tallSet(), page = makePage(60, 80);
  drawWord(page, set, 'yy', [5, 11], 50);
  drawWord(page, set, 'TT', [5, 11], 61);
  assert.strictEqual(E.findBands(page, zeroMask(page)).length, 1);
  const { lines } = await E.readPage(page, [set]);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')), ['yy', 'TT']);
  assert.deepStrictEqual(lines.map(L => L.baseline), [50, 61]);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.deepStrictEqual(L.fails, []);
  }
});

test('readPage: neighbour ascender tip glued to the band above is retracted, not a □', async () => {
  // 'Ay' baseline 20 (ink 15..22); 'JA' baseline 31 below. J's detached top
  // row (row 23) is contiguous with the upper band while J's body (25..30,
  // row 24 blank) is its own band. The upper line's scan window (maxDesc 4)
  // judges row 23, fails on the tip — then the lower line explains it and
  // the page-end retro-check must retract the fail.
  const set = tallSet(), page = makePage(60, 60);
  drawWord(page, set, 'Ay', [5, 11], 20);
  drawWord(page, set, 'JA', [5, 11], 31);
  assert.deepStrictEqual(E.findBands(page, zeroMask(page)), [[15, 24], [25, 31]]);
  const { lines } = await E.readPage(page, [set]);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')), ['Ay', 'JA']);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.deepStrictEqual(L.fails, []);
  }
});

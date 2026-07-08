// reader.js — line reader mixed onto CanvasViewer.prototype by training.js.
// Glyph matching: matchAt (training.js). Template/pixel primitives: ocr.js.
// Globals from core.js: EXACT_MATCH, PLACEHOLDER, TEMPLATE_LEFT_CROP.
//
// Position detection (template_metrics.json): when the loaded templates carry measured
// metrics (bench/measure-metrics.mjs), each match pins the glyph's FRACTIONAL layout
// position — x0 = matched column − the template's measured anchor — and the next glyph
// is PLACED at x0 + advanceWidth (+ the measured pair kern), instead of guessed from
// the template's ink width. Every candidate the search finds is also verified against
// its own anchor: a template whose implied x0 disagrees with the pen's prediction by
// more than OCR_POS_TOL is rejected (a slid or stray match sits ~a whole column off,
// so the gate separates cleanly). Templates without metrics — or metrics measured
// under a different fontSpec — fall back to the unguided behaviour below.

const OCR_ALIGN_SEARCH  = 3;  // ±px search when anchoring a new word
const OCR_MIDWORD_SEARCH = 3; // ±px search on the advance grid
const OCR_MIDWORD_RESYNC = 8; // wider ±px fallback when the local grid loses the glyph
                              // (a mis-cut template width can drift the pen past ±3)
// Max |implied x0 − predicted x0| for a metric'd candidate to be accepted. A correct
// match is off by at most both anchors' half-ranges (~0.15 each, more when an anchor was
// estimated from few samples); a match one column over is off by ~1. 0.38 sits in the
// gap between those two populations.
const OCR_POS_TOL = 0.38;
const POKE_CROP = 3;          // rows to ignore at top+bottom in blank tests
                               // (glyphs like j f W Y bleed beyond their advance)
// Where the next glyph's cell-left sits, measured from the matched glyph's own column:
// a template is cut to advance − 1 − TEMPLATE_LEFT_CROP, so the next cell-left is
// (cellLeft + w) + TEMPLATE_LEFT_CROP + 1. Advancing the pen this way — locally, off
// each glyph's real matched position and ink width — instead of off measureText's
// cumulative advance is what keeps source kerning from drifting the grid. measureText
// can't apply the kern that tucks a narrow glyph under a wide neighbour (Ve, Vp, Aj…)
// until that glyph is already in the string, so it predicts a column or two too far
// right; on a tightly-cut font that overshoot exceeds the ±search and the narrow glyph
// is dropped (or, after a very wide glyph, the line stops). The local pen lands on the
// glyph instead. (measureText is still used only for the space width.)
const INTERGLYPH = TEMPLATE_LEFT_CROP + 1;

const CanvasViewerReader = {
  // The candidate's measured metrics, but only when they can be trusted for POSITION:
  // measured under the font the app is currently laying out with (metrics from another
  // fontSpec would place every glyph wrong), in the format that records the anchor, and
  // with a TIGHT anchor — a template whose match column wanders relative to its glyph
  // (anchorRange ≳ a column: a cut that slides on its own ink, or one polluted by
  // mis-predicted rows) can't pin position. Untrusted metrics are ignored wholesale,
  // never partially.
  _metric(best) {
    const m = best?.t?.metric;
    return m && m.anchor !== undefined && m.anchorRange <= 0.6 &&
      this.engine.metricsFontSpec === this.config.fontSpec ? m : null;
  },

  // The glyph's fractional layout x0 implied by template m matching at column sx.
  // m.anchor is the measured (matchColumn − x0), one fractional number per template —
  // integer cut displacement and subpixel bucket in one — so inverting it recovers x0.
  _x0At(sx, m) {
    return sx - m.anchor;
  },

  // Kern between a and b beyond their isolated advances (negative when b tucks under a,
  // as in Ve/Aj) — the part of the pair advance measureText can't see one char at a time.
  // Cached per fontSpec; the cache resets when the font changes.
  _kern(a, b) {
    if (this._kernFont !== this.config.fontSpec) {
      this._kernFont = this.config.fontSpec;
      this._kerns = new Map();
    }
    const key = a + b;
    let k = this._kerns.get(key);
    if (k === undefined) {
      const ctx = this._measureCtx();
      k = ctx.measureText(key).width - ctx.measureText(a).width - ctx.measureText(b).width;
      this._kerns.set(key, k);
    }
    return k;
  },

  // Position error of a candidate vs the pen's prediction: |implied x0 − predicted x0|,
  // or null when it can't be judged (no prediction — line start, or the pen lost its
  // metric — or a candidate without metrics). expect.x is the predicted x0 before the
  // pair kern (known only now that the candidate's char is); expect.step (the space
  // advance) turns the prediction into a grid — the gap before a re-anchored word is
  // some whole number of spaces ≥ 1.
  _posErr(sx, best, expect) {
    if (!expect) return null;
    const m = this._metric(best);
    if (!m) return null;
    const implied = this._x0At(sx, m);
    let want = expect.x + this._kern(expect.prev, best.char);
    if (expect.step) want += Math.max(1, Math.round((implied - want) / expect.step)) * expect.step;
    return Math.abs(implied - want);
  },

  // Gate tolerance for a candidate. A wide anchor carries less positional
  // information — the template's correct matches genuinely sit up to half its
  // range from the centre — so the gate widens with it rather than rejecting the
  // template's own glyphs.
  _posTol(best) {
    const m = this._metric(best);
    return Math.max(OCR_POS_TOL, (m ? m.anchorRange / 2 : 0) + 0.05);
  },

  // Ink window for a row's blank tests: the band minus POKE_CROP at top and bottom,
  // where a neighbour's descender or poke-out (j f W Y) bleeds across the advance.
  _inkWindow(band) {
    const cellH = Math.round(band.y1 - band.y0);
    return { inkY: band.y0 + POKE_CROP, inkH: Math.max(1, cellH - POKE_CROP * 2) };
  },

  // First non-blank column at or after x; -1 if the row ends first.
  // sy/h are the cropped ink window (see _inkWindow).
  _nextInk(x, right, sy, h) {
    while (x + 1 < right && this.engine.isBlank(this.img, x, sy, 1, h)) x++;
    return x + 1 < right ? x : -1;
  },

  // Anchor every row to its first inked column (its left text start), so a page whose
  // text begins at any left offset reads without manual dragging. Reuses the same
  // first-ink scan the reader uses to re-anchor after a space (_nextInk), bounded to the
  // left 60% of the page so a right-margin smudge can't anchor an otherwise-blank row.
  // Scans the FULL band height, not the POKE_CROP ink window: a row can begin with a
  // glyph whose ink lives entirely in the cropped margins (the underscore's bar sits in
  // the bottom 3 rows), and at line start there is no left neighbour whose descender
  // could fake ink — the only left-poke is the first glyph's own (a leading j's hook),
  // which lands within the ±OCR_ALIGN_SEARCH of the first match anyway.
  autoAnchorRows() {
    if (!this.img) return;
    const right = Math.min(this.img.width - 1, Math.round(this.img.width * 0.6));
    for (let r = 0; r < this.rowBands.length; r++) {
      const band = this.rowBands[r];
      const x = this._nextInk(0, right, band.y0, Math.round(band.y1 - band.y0));
      this.rowStartX[r] = x < 0 ? 0 : x;
    }
  },

  // Nearest-first exact match ±reach px around predicted column px. A closer column
  // always beats a farther one (so we can't slide onto a neighbour); at the same distance
  // the LEFT probe wins — reading left-to-right, the next glyph is the leftmost ink not
  // yet consumed, so when the locally-advanced pen overshoots a glyph kerned tight under a
  // wide neighbour (the j tucked under Q in "fQjJ"), the left probe lands on that real
  // glyph instead of skipping to a wider following one. matchAt already returns the widest
  // template at each column, so the left probe still gets the true glyph, not a slice.
  //
  // minX bounds the search on the left: it never probes left of the previous glyph's
  // right edge, so the backward reach can re-find the NEXT glyph (overshot) but never
  // the one just emitted. Without it a wide fallback reach loops on the last glyph when
  // the following one has no template — e.g. an endless run of the same narrow letter.
  //
  // `expect` (see _posErr) position-gates every candidate. With an expectation, all
  // metric'd candidates in reach compete on position error and the BEST-agreeing one
  // wins — not the nearest-probed. Nearest-first alone can accept a narrow template
  // that pixel-matches a SLICE of a wider glyph (an I on an H's stem) at a marginally
  // passing error before the true glyph a column further is even probed; with exact
  // anchors the true glyph's error is ~0, so min-error separates them cleanly. A hit
  // that won with real metrics is `trusted` — its column IS the bucket-verified
  // cell-left, so _span must not slide it. Unjudgeable candidates (no metrics) keep
  // the old nearest-first behaviour, as a fallback when nothing judged passes.
  _matchNear(band, px, reach, minX = 0, expect = null) {
    let judged = null;   // gate-passing metric'd hit with the smallest position error
    let unjudged = null; // nearest exact hit that carries no metric to judge
    let rejected = null; // distance of the nearest gate-REJECTED metric'd hit
    for (let d = 0; d <= reach; d++) {
      for (const sx of d === 0 ? [px] : [px - d, px + d]) {
        if (sx < minX) continue;
        const best = this.matchAt(sx, band.y0);
        if (best.score < EXACT_MATCH) continue;
        const err = this._posErr(sx, best, expect);
        if (err === null) {
          if (!expect) return this._span(band, { best, cellLeft: sx }, minX, false);
          if (!unjudged) unjudged = { best, cellLeft: sx, d };
          continue;
        }
        if (err <= this._posTol(best) && (!judged || err < judged.err))
          judged = { err, best, cellLeft: sx };
        else if (rejected === null) rejected = d;
      }
    }
    if (judged) return this._span(band, { best: judged.best, cellLeft: judged.cellLeft }, minX, true);
    // A metric-less hit only stands in when nothing nearer was gate-rejected: a
    // rejected candidate closer to the probe usually means the PEN is off (its
    // prediction built on a wide pooled anchor), not that the glyph is absent —
    // returning null lets the caller's ungated retry re-find that nearest glyph,
    // instead of a far metric-less template (m, W) swallowing it.
    if (unjudged && (rejected === null || unjudged.d <= rejected))
      return this._span(band, unjudged, minX, false);
    return null;
  },

  // Resolve a raw match to the glyph's full column span. A template can match at several
  // adjacent columns when the page glyph is a pixel or two wider than the cut (or saved a
  // hair off-centre): the same char keeps matching as the crop slides across its ink.
  //   • cellLeft — the LEFTMOST such column, the glyph's true cell-left. Matching at the
  //     rightmost instead drifts the pen right, and that drift accumulates until it
  //     overshoots a glyph kerned tight under a wide neighbour (the j in "12DjT" sits
  //     under the D, so a few px of drift lands the pen past it and it reads as a space).
  //   • rightCol — the RIGHTMOST such column, the glyph's true ink-right edge. The caller
  //     floors the NEXT search just past it, so a thin glyph spanning several columns is
  //     emitted once, not re-matched a column or two over into a double ("4jj4").
  // The caller still advances the pen from cellLeft (+ w), so the span only de-dups; it
  // doesn't change where the next glyph is predicted. Left walk stops at minX (the
  // previous glyph) and the same-or-wider-char test stops at the next, different glyph.
  //
  // `trusted` marks a hit whose column already passed the bucket gate (_posOk with real
  // metrics): that column IS the glyph's cell-left, so the left walk — the unguided
  // stand-in for exactly that question — is skipped rather than allowed to slide off it.
  //
  // The returned hit also carries the metric view of the glyph, when it has one:
  //   • x0f  — the fractional layout x0 implied by the template matched AT cellLeft
  //     (leftBest, not the widest-seen `best`: the widest may have matched a column
  //     over, and its offset would misplace x0f).
  //   • advF — that template's measured fractional advance, for the pen.
  _span(band, hit, minX, trusted = false) {
    let best = hit.best, cellLeft = hit.cellLeft, rightCol = hit.cellLeft;
    let leftBest = hit.best; // the match at the final cellLeft — the x0f witness
    const ch = best.char;
    // Widen across the same-char run both ways; keep the widest template seen (the
    // truest, fullest cut) for the pen advance. Left stops at minX (the previous glyph),
    // both stop at the next, different glyph.
    if (!trusted) {
      while (cellLeft - 1 >= minX) {
        const l = this.matchAt(cellLeft - 1, band.y0);
        if (l.score < EXACT_MATCH || l.char !== ch) break;
        cellLeft--; leftBest = l; if (l.w > best.w) best = l;
      }
    }
    // Bound the right walk to one advance (w + INTERGLYPH) from the true cell-left:
    // within that span a same-char re-match is the glyph's own ink sliding under a
    // too-narrow cut (de-dup it); a same-char match a full advance away is a real next
    // glyph — a legit "ii"/"ll" — which must survive, so the walk stops before it.
    // The walk MUST stop at the first miss: scanning over gap columns reaches the next
    // glyph's own slide matches and eats real doubles ("11" reads as "1"). Ghost
    // repeats from NON-contiguous slides (two cuts of one char a few columns apart)
    // are a template-set problem — prune the split cut-family, keep the middle cut.
    while (rightCol + 1 < cellLeft + best.w + INTERGLYPH) {
      const r = this.matchAt(rightCol + 1, band.y0);
      if (r.score < EXACT_MATCH || r.char !== ch) break;
      rightCol++; if (r.w > best.w) best = r;
    }
    const m = this._metric(leftBest);
    return { best, cellLeft, rightCol,
      x0f: m ? this._x0At(cellLeft, m) : null, advF: m ? m.advanceWidth : null };
  },

  // OCR one row from its anchor left-to-right.
  ocrRow(r) {
    const band = this.rowBands[r];
    if (!band) return null;
    const { inkY, inkH } = this._inkWindow(band);
    const spaceAdvance = Math.max(1, this._measureCtx().measureText(' ').width);
    const sw    = Math.max(1, Math.round(spaceAdvance) - 1);
    const right = this.img.width;

    let text = '', scores = [], stopped = null, stopX = null;
    let penX = this.rowStartX[r]; // predicted cell-left of the next glyph
    let penF = null;              // fractional predicted x0 (metric pen; null = unknown)
    let prevChar = null;          // last emitted char, for the pair kern
    let floor = 0;                // search floor: just past the last glyph's full span
    let anchored = false;

    // Record a matched glyph: emit it, advance the pen and floor the next search just
    // past its full span (so a thin glyph matching several columns isn't re-matched
    // into a double). Both the align and mid-word paths funnel here. With metrics the
    // pen is FRACTIONAL — re-seeded from the matched template's own bucket (x0f), then
    // advanced by its measured advance — so nothing accumulates and the next glyph is
    // placed, not guessed; without them it falls back to the ink-width advance.
    // The row's FIRST glyph also snaps the row anchor to its implied layout x0: the
    // first-ink anchor sits at the glyph's leftmost ink, which is right of the true
    // cell-left by the side bearing (well inside a 7), and every box charX lays out
    // from the anchor would inherit that shift.
    //
    // Word gaps are emitted as spaces here, on the metric pen: the glyph's implied
    // x0 sitting whole spaces past the prediction IS the drawn gap (kern shifts are
    // under a pixel, a space is ~4 — rounding separates them cleanly). Emitting on
    // the pen rather than in the blank branch also catches a short space whose
    // sw-wide blank window straddles the next glyph's ink and never reads as blank.
    // `minSp` = 1 from the re-anchor path (a gap the blank test DID fire on is at
    // least one space); it also gates the unguided fallback, which can only trust
    // the blank test's word gaps, not sub-pixel pen arithmetic.
    const take = (hit, minSp = 0) => {
      if (!text && hit.x0f != null) this.rowStartX[r] = hit.x0f;
      if (text) {
        let k = 0;
        if (penF != null && hit.x0f != null)
          k = Math.max(minSp, Math.round((hit.x0f - penF) / spaceAdvance));
        else if (minSp > 0)
          k = Math.max(1, Math.round((hit.cellLeft - penX) / spaceAdvance));
        for (let i = 0; i < k; i++) { text += ' '; scores.push(null); }
      }
      text += hit.best.char; scores.push(hit.best.score);
      if (hit.x0f != null) {
        penF = hit.x0f + hit.advF;
        penX = Math.round(penF);
      } else {
        penF = null;
        penX = hit.cellLeft + hit.best.w + INTERGLYPH;
      }
      prevChar = hit.best.char;
      floor = hit.rightCol + 1;
    };

    while (text.length < 1000) {
      if (penX + sw >= right) break;

      // Blank cell (gap or pre-first-word): walk white pixels forward to where ink
      // resumes and re-anchor the next match there, on its own column, not this grid.
      // A mid-line gap is emitted as spaces (the page really draws them); the gap
      // before the first word (an indent) is not.
      // The re-anchor search is floored at `floor` (just past the last glyph) like the
      // mid-word one: otherwise, when the pen sits a pixel past a glyph on a faint speck,
      // its backward reach re-finds that glyph, re-seeds the pen to the same column, and
      // loops — an endless run of the last letter at end of line (a faint r after "wTf").
      if (!anchored || this.engine.isBlank(this.img, penX, inkY, sw, inkH)) {
        // The cropped blank test is blind to a glyph whose ink lives entirely inside
        // the POKE_CROP margins — the underscore's bar sits in the bottom 3 rows — so
        // it reads as a gap and the ink walk below would step straight over it. When
        // the FULL-height cell does hold ink where the cropped window saw none, probe
        // the pen column for an exact match before declaring a gap: a real gap is
        // all-white and no template is all-white, so a hit here is always real ink.
        // (A left neighbour's descender poking into the cell also trips the full-height
        // test, but its partial ink exact-matches no template and falls through.)
        const cellH = Math.round(band.y1 - band.y0);
        if (!this.engine.isBlank(this.img, penX, band.y0, sw, cellH)) {
          const exm = penF != null && prevChar != null ? { x: penF, prev: prevChar } : null;
          const hid = this._matchNear(band, penX, OCR_ALIGN_SEARCH, floor, exm);
          if (hid) { take(hid); anchored = true; continue; }
        }
        const inkX = this._nextInk(penX, right, inkY, inkH);
        if (inkX < 0) break;
        // With a live metric pen the word gap is a whole number of spaces, so the new
        // word's x0 sits on the pen's space grid (expect.step) — but a gap that isn't
        // spaces (an indent, a table column) would fail that grid, so on a full miss
        // the anchor retries ungated rather than stopping the line.
        const ex = penF != null ? { x: penF, prev: ' ', step: spaceAdvance } : null;
        let hit = this._matchNear(band, inkX, OCR_ALIGN_SEARCH, floor, ex);
        if (!hit && ex) hit = this._matchNear(band, inkX, OCR_ALIGN_SEARCH, floor, null);
        if (!hit) { stopped = 0; stopX = inkX; break; }
        take(hit, anchored ? 1 : 0); anchored = true;
        continue;
      }

      // Mid-word: the next glyph sits on the local advance grid — with metrics, exactly
      // at penF + the pair kern (checked per candidate by _posOk, since the kern needs
      // the candidate's char); without, at the previous glyph's matched column + its ink
      // width + INTERGLYPH. A short ±search absorbs the small per-pair kern, and the
      // matched column re-seeds the pen so nothing accumulates.
      // On a miss the grid has drifted (a glyph cut narrower/wider than its real advance
      // mispredicts the next column by more than ±OCR_MIDWORD_SEARCH); widen the search
      // once to re-lock onto the nearest glyph rather than dropping the rest of the line.
      // Both searches are floored just past the last glyph's full span so they can only
      // ever find the NEXT glyph, never re-match the one just emitted (a thin glyph that
      // matches across several columns would otherwise read twice, or loop on a line whose
      // following glyph has no template).
      const ex = penF != null ? { x: penF, prev: prevChar } : null;
      let hit = this._matchNear(band, penX, OCR_MIDWORD_SEARCH, floor, ex)
             || this._matchNear(band, penX, OCR_MIDWORD_RESYNC, floor, ex);
      // The gate can be wrong by a few tenths on kern-heavy pairs (an f tucked under a
      // Z shifts the prediction via whichever template read the Z), so when NOTHING in
      // reach passes it, fall back to the nearest ungated exact match — the unguided
      // reader's behaviour — rather than stopping the line. The gate still arbitrates
      // whenever any position-consistent candidate exists.
      if (!hit && ex)
        hit = this._matchNear(band, penX, OCR_MIDWORD_SEARCH, floor)
           || this._matchNear(band, penX, OCR_MIDWORD_RESYNC, floor);
      if (!hit) { stopped = 0; stopX = penX; break; }
      take(hit);
    }

    while (text.endsWith(' ')) { text = text.slice(0, -1); scores.pop(); }
    if (stopped !== null) { text += PLACEHOLDER; scores.push(stopped); }
    this.rowText[r]   = text;
    this.rowScores[r] = scores;
    this.rowMode[r]   = 'ocr';
    this.rowStopX[r]  = stopped !== null ? stopX : undefined;
    return stopped;
  },

  ocrAllRows() {
    if (!this.img) { this.infoEl.textContent = 'Load a page first.'; return; }
    if (this.engine.templates.length === 0) {
      this.infoEl.textContent = 'No templates loaded — click Load Templates.';
      return;
    }
    for (let r = 0; r < this.rowBands.length; r++) this.ocrRow(r);
    this.rebuildBoxes();
    this.render();
    this._reportConfidence('OCR page');
  },

  // Re-check a hand-typed row: chars with an exact template match turn green.
  rescoreManualRow(r) {
    const typed = this.rowText[r] || '';
    if (!typed) return;
    const band = this.rowBands[r];
    const startX = this.rowStartX[r];
    let text = '', scores = [];
    for (let i = 0; i < typed.length; i++) {
      const ch = typed[i];
      if (ch === ' ') { text += ' '; scores.push(null); continue; }
      const best = this.matchAt(this.charX(startX, text), band.y0);
      if (best && best.score >= EXACT_MATCH) { text += best.char; scores.push(best.score); }
      else { text += ch; scores.push(null); }
    }
    this.rowText[r] = text; this.rowScores[r] = scores;
  },

  refreshOcrAfterSave() {
    if (!this.img || this.engine.templates.length === 0) return;
    for (let r = 0; r < this.rowBands.length; r++) {
      if (this.rowMode[r] === 'ocr') this.ocrRow(r);
      else if (this.rowText[r]) this.rescoreManualRow(r);
    }
    this.rebuildBoxes();
    this.render();
    const li = document.getElementById('line-input');
    if (li) li.value = this.rowText[this.activeRow] || '';
  },

  _reportConfidence(prefix) {
    let read = 0, todo = 0;
    for (let r = 0; r < this.rowBands.length; r++) {
      for (const s of (this.rowScores[r] || [])) {
        if (s == null) continue;
        if (s >= EXACT_MATCH) read++; else todo++;
      }
    }
    this.infoEl.textContent = `${prefix}: ${read} read / ${todo} to fill  (${read + todo} chars).`;
  },
};

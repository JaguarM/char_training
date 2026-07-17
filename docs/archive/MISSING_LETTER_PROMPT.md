# Prompt: stress-test — recover a single erased letter from a line

> **COMPLETED 2026-07-09** — results, calibration numbers (δ = [0, 1/32 px],
> x0 = 45.0000 exactly), and the honest write-up live in
> [MISSING_LETTER.md](../MISSING_LETTER.md). Kept as the record of the task
> definition; numbers below (e.g. "δ ≈ 0.025") were superseded by measurement.

Read `docs/RENDERER_IDENTIFIED.md` and `docs/SYNTHETIC_DICT.md` first; the
rendering physics below is proven there, don't re-derive it.

## Goal

Stress-test our OCR's information limit: if ONE letter in the middle of a real
corpus line is completely erased (its pixels whited out), can we recover it?
Build the inference engine, run it over many lines of `corpus/v3.pdf` (then
`corpus/big.pdf` for volume), and report recovery rates honestly.

## The physics you get to assume (all byte-proven)

- Pages are MuPDF renders of Times New Roman 12 pt @ 96 dpi gray. Baselines are
  integer (band top + 11; rows `40 + 18·row`). Pen x is snapped to the nearest
  ¼ px (bucket boundaries at .125/.375/.625/.875). Each distinct glyph raster
  identifies its ¼-px bucket **uniquely** — matching a template = reading off
  the drawn pen bucket exactly.
- Layout is Chrome-metric: kern-correct cumulative advances from canvas
  measureText (`16px "Times New Roman"`), all dyadic (exact in float64).
  `tools/dump-layout.mjs` computes them; `docs/layout_v3.json` is its output
  (regenerate if missing).
- The layout producer's pens sit δ ∈ [0, ~0.025] px BELOW the ideal measureText
  positions, varying per glyph (unmodeled quantization). So the pre-image of an
  observed bucket b for the *ideal* position is
  `x_ideal ∈ [b − 0.125, b + 0.125 + 0.025)` — widen intervals accordingly and
  treat the exact δ bound as something to MEASURE, not assume.

## Adapting the interval-arithmetic sketch

For letter i at cumulative kern-correct width C_i from line start x0 = 45:
observed bucket S_i ⇒ `S_i − 0.125 ≤ x0 + C_i − δ_i < S_i + 0.125`. With an
erased letter c at position k, every C_i for i > k contains the unknown
advance(c) + kern terms, so each candidate c yields a different interval system.
A candidate survives only if the intersection over all observed letters is
non-empty. Note the phase-lock ceiling: buckets repeat mod 0.25, so distinct
fractional alignments — not letter count — set the precision floor; measure
where it lands empirically (is it the 0.025 δ band? 1/128?).

## Test protocol (three evidence levels — report each separately)

1. **Geometry only**: erase the letter's full advance window (replace with 255);
   infer c from the surviving letters' bucket constraints alone. This is the
   pure interval-intersection test. Expect ambiguity classes (e.g. same-advance
   letters: i/l/1, e/o?) — report the ambiguity-set-size distribution, not just
   top-1 accuracy.
2. **+ neighbour bleed**: erase only the letter's own-ink columns; its
   neighbours' windows still contain the erased letter's kern-bleed columns
   (and vice versa). Byte-compare candidate composites (the exact blend law:
   `fontgen.py` glyph sets, now in `tools/fontgen/`; `validate_pairs.py` /
   `composite_check.py` in the archived ocr workspace zip).
3. **Render-and-verify (generative)**: for each surviving candidate, render the
   full line hypothesis through MuPDF (see `render_synth_*.py` in the ocr
   workspace, mind the snap-boundary shift copies) and byte-compare everything
   EXCEPT the erased window. Should collapse most remaining ambiguity.

Harness notes: page rasters come from `tools/raster-cache/` (v3 =
4a03e5ed497dd6a3, big = 370b1d50ba19fda8; format in raster-cache-browser.js) —
never re-rasterize the PDFs. Pick erased letters uniformly over mid-line
positions (not first/last), include kern-heavy neighbours (AV, Ye, T?) and
narrow glyphs on purpose. Skip the known narrow-space styled rows
(`docs/archive/SPACE_REVIEW.md` list) in the main run; report them as a separate
hard bucket if attempted. dump-ocr comparisons need `KEEP_SPACES=1`.

## Deliverables

- `tools/guess-letter.mjs` (node; may reuse puppeteer for measureText like
  dump-layout.mjs) — takes `--pdf --page --row --col` to erase+infer one glyph,
  and a `--sample N` mode for the batch benchmark.
- Numbers: per evidence level — unique-recovery %, mean ambiguity set size,
  failure list with causes; the measured x0 precision floor vs the theoretical
  phase-lock argument.
- A short honest writeup appended to `docs/` (what information a single ¼-px
  bucket stream actually carries; where geometry alone fails and why).

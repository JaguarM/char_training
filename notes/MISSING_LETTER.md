# Missing-letter recovery — what a ¼-px bucket stream actually knows (2026-07-09)

Stress-test from `MISSING_LETTER_PROMPT.md`: erase ONE letter from a real
corpus line and try to recover it from the surviving pixels. Tool:
`bench/guess-letter.mjs` (single trial `--page/--row/--col`, batch
`--sample N [--targeted]`, physics `--calibrate`; Python halves
`export_glyphs.py` / `render_hypotheses.py` in `..\ocr\tools`). All numbers
below are measured on the real `corpus/v3.pdf` and `corpus/big.pdf` rasters
from `bench/raster-cache/` — nothing re-rasterized, no template dictionary
involved (glyph rasters come straight from fontgen).

## Setup (what the inference engine gets)

A trial erases the glyph at one mid-line position (never first/last, never a
space, styled/skip-listed rows excluded from sampling). The engine knows: the
surviving text, x0 = 45, the row baseline, the erased slot; it never sees the
erased glyph's pixels.

- **Level 1 (geometry)** erases the full advance window ∪ every column the
  glyph inked, then locates each surviving glyph's drawn ¼-px bucket by
  byte-matching its fontgen raster (the `recover_pens` recipe: strong-ink core
  columns, byte-equal; three passes — plain, located-ink masked, plausible-ink
  masked for mutual overlaps like W↔A). Candidate c survives iff every observed
  suffix bucket satisfies `ideal_i(c) − b_i ∈ [−0.125, 0.125+δmax]`.
- **Level 2 (+ bleed)** erases only the columns where the erased glyph's ink
  stands ALONE; columns shared with neighbour ink survive as composites, and
  the glyph's own bleed into neighbour windows survives outright. Candidates
  must byte-reproduce every surviving pixel near the slot through the proven
  blend law `dst = (dst·(256−e))>>8`, `e = cov + (cov>>7)`, honouring the g→e
  inversion ambiguity, parts chosen by column overlap (an index window misses
  a 'j' descender reaching in from 5 glyphs away — found the hard way).
- **Level 3 (render-and-verify)** re-renders the full line hypothesis through
  real MuPDF (`render_hypotheses.py` worker) — surviving glyphs at their
  OBSERVED buckets (exact ¼-px pens, so the snap is a no-op), candidate at
  each δ-feasible bucket — and byte-compares the whole row band outside the
  level-1 hole. Unpinned glyphs are omitted and their plausible columns
  excluded from the compare.

Truth-gates validate every trial: the true letter must survive each level,
else the trial (level-1 gate) or that level (2/3) is excluded and the cause
counted. Gates fire on model-coverage failures only — post-gate, truth ∈ set
in **791/791 clean trials at every level**.

## Calibration first (the assumed physics, measured)

`--calibrate 80` on both docs, styled rows split off per-row:

- δ = ideal − drawn-pen band: **[0, 0.03125] px on v3 AND big** (0 outliers at
  δmax 0.032 over ~10k glyphs). The prompt's "~0.025" was slightly tight — the
  real bound is exactly 1/32 px. `--deltaMax 0.032` is the baked default.
- ~97% of glyphs byte-pin to exactly one bucket (ambiguous: 4 in 10k).
- **Styled rows are real**: 11/80 v3 rows and 9/80 big rows drift off the
  measureText model by up to ±0.4 px, non-uniformly, ≫ δ — the known
  narrow-space layout gap (SYNTHETIC_DICT.md), NOT noise. Per-trial gates
  catch the ones the skip list doesn't.
- **x0 phase-lock floor**: a single row pins x0 to a median 0.040 px interval
  (min 0.0086 with δ model; the δ=0 model goes infeasible on some rows —
  direct proof δ > 0 exists). Intersecting a whole doc's rows:
  **x0 ∈ [45.0000, 45.0008] on BOTH docs — a 1/1280 px interval.** Per-row the
  floor is the realized δ spread (~1/32 px) plus phase-coverage gaps; across
  rows it collapses to the dyadic frac granularity, sub-milli-pixel. x0 = 45
  exactly, beyond reasonable doubt.

## The advance lattice (why geometry can't finish the job)

TNR16 advances are exact multiples of **1/128 px**. The 94 printable ASCII
glyphs share only **22 distinct advances**:

```
 2.8828125 ×1  '        7.1015625 ×5  ?acez     9.7734375 ×4  ELTZ
 3.2031250 ×1  |        7.5078125 ×1  ^        10.6718750 ×3  BCR
 4.0000000 ×2  ,.       7.6796875 ×2  {}       11.5546875 ×13 ADGHKNOQUVXYw
 4.4453125 ×8  /:;\ijlt 8.0000000 ×27 #$*0-9_  12.4453125 ×2  &m
 5.3281250 ×10 !()-I[]`fr             bdghknopquvxy
 6.2265625 ×2  Js       8.6562500 ×1  ~        13.3281250 ×1  %
 6.5312500 ×1  "        8.8984375 ×3  FPS      14.2265625 ×1  M
                        9.0234375 ×4  +<=>     14.7343750 ×1  @
                                               15.1015625 ×1  W
```

A level-1 trial measures the erased glyph's advance contribution
Δ(c) = kern(prev,c) + adv(c) + kern(c,next) to a feasible interval of
**median width 0.055 px, p10 0.032 (= the δmax floor), min 0.0086 (one
targeted trial: 0.0007)** — one to two orders finer than any advance gap. More suffix observations do NOT help
(unique rate 2.9% with 1–2 observations, 4.4% with 11+): the interval
saturates at the δ floor almost immediately; the LATTICE binds, not the
measurement. Kerning both splits classes (V, A, T, J, Y all went unique or
near-unique in kerning contexts) and merges them ('T' before 'o' picks up
kern(T,o) ≈ −1.77 px and lands dead-on the 8.0 class).

## Results — random mid-line erasures

v3 300 trials (243 clean), big 600 trials (542 clean); exclusions: 99 styled
rows (level-1 gate), 10 unpinnable true glyphs; per-level gates: 2 composite,
4 render (see failure census).

| level | unique | mean \|set\| | median | on bleed>0 subset | on no-bleed subset |
|---|---|---|---|---|---|
| 1 geometry | 4.6% | 13.6 | 11 | 6.5% (n=401) | 2.6% (n=390) |
| 2 +bleed | **53.2%** | 5.2 | **1** | **92.7%** (n=399) | 12.8% (n=390) |
| 3 render | 4.6% | 13.2 | 11 | 6.6% (n=396) | 2.6% (n=389) |

By erased-char class (combined, level → unique):

|  | lower (n≈300) | UPPER (n≈360) | digit (n≈109) | punct (n≈21) |
|---|---|---|---|---|
| L1 | 1.3% | 8.6% | 0.9% | 0% |
| L2 | 64.0% | 52.9% | 28.4% | 33.3% |
| L3 | 1.3% | 8.6% | 0.9% | 0% |

L1-unique recoveries are exactly the advance-singletons and kern-splits:
M×11, W×8, A×4, T×4, V×3, f×2, plus 1/J/r/u once each. The dominant ambiguity
sets ARE the advance classes: {0-9#$*_bdghknopquvxy}×221, {ADGHKNOQUVXYw}×111,
{/:;\ijlt}×49, {BCR}×44, {?acez}×41 … 2-member residues are the 2-member
classes: {Js}×18, {&m}×9.

### Targeted erasures (kern pairs + narrow glyphs, half of each sample biased)

v3 200 trials (175 clean), big 300 trials (268 clean) — `--targeted` biases
sampling toward NARROW glyphs (i l f t j r . , ' - : ; !) and classic kern
pairs (AV Ye To Wa f. …):

| level | v3 unique | big unique | bleed>0 subset | no-bleed subset |
|---|---|---|---|---|
| 1 geometry | 10.9% | 5.6% | — | — |
| 2 +bleed | 60.6% | 64.9% | **97.1% / 98.8%** | 5.7% / 8.0% |
| 3 render | 10.9% | 6.3% | 17.1% / 8.9% | 1.4% / 2.0% |

Kern contexts help geometry (unique doubles: classes split when the erased
slot's neighbours kern) and make level 2 near-perfect where ink truly touches.
Level 3 gains too (its channel IS escaped ink: 'j' drops from {/:;\ijlt}, 'f'
from {!()-I[]`fr} in the residuals) but stays an order below level 2 — the
render only sees what the level-1 hole didn't swallow. The stubborn L2
residual on narrow glyphs is {:;il} (×33 across both docs): identical
footprints, stem-only ink, nothing outside the erasure to compare.

## Reading the numbers honestly

- **Level 1** answers "how wide was the erased glyph" almost exactly, and
  width is nearly non-informative about identity: 22 advances for 94 glyphs,
  27 of them sharing 8.0 px. Uniqueness (4.6%) is the probability the erased
  char was M/W/@-class or got kern-split.
- **Level 2 is the strongest level as defined — but read the fine print.**
  Its erasure (own-ink-alone columns) leaks the erased glyph's exact column
  footprint, and surviving white columns inside the advance window falsify
  every candidate that would ink them. That absence-of-ink evidence — not
  compositing — is most of its power on isolated letters (no-bleed subset:
  still 12.8%). Where real column contact exists (53% of random trials at
  column granularity — AA edges touch even where template-window overlap is
  the census's 1.2%), byte-compositing is devastating: **92.7% unique**.
- **Level 3 does NOT collapse the remaining ambiguity — and proves why.** With
  the full advance window erased, same-advance candidates paint byte-identical
  pixels everywhere outside the hole: identical suffix buckets, no kern
  contact, so the MuPDF render literally certifies them indistinguishable
  (L3 < L2 in only 6/789 trials; L2 < L3 in 572). L3's small edge over L1 is
  glyphs whose ink escapes the hole: 'f' overhang and 'j' descender drop out
  of the {!()-I[]`fr} / {/:;\ijlt} residuals. The erased window is simply
  GONE; rendering can't resurrect it.
- The truth-gates double as an end-to-end proof: on every clean trial the
  full-line MuPDF hypothesis render at observed buckets is **byte-identical
  to the real page outside the hole** — layout model, bucket locating, blend
  law and renderer all exact, on two documents, 340+34 pages.

## Failure census (what "excluded" means)

- `gate-L1-true-infeasible` ×99 (11%): styled rows — drawn pens off the
  measureText model (narrow spaces; residuals up to ±0.4 px, non-uniform).
  Concentrated on v3 P3–P6 (the email-body pages) exactly where SPACE_REVIEW
  lives. Recovering letters there needs the recovered-pen layout
  (render_synth_recovered.py's approach) — same Phase-2 gap as
  SYNTHETIC_DICT.md, out of scope here.
- `true-bucket-nohit` ×10: the erased glyph itself couldn't be byte-pinned
  within ±0.5 px (styled-row drift, deep contamination).
- `gate-L3-true-render-mismatch` ×4: byte-verified causes — a redaction box
  right after "> Record Locator:" on v3 P2 L1 (pure black cols 160–233 the
  text model can't render), styled leaks with 41 unpinned glyphs, and
  occasional false pins that slip the L1 gate (core-columns match at a
  0.25-off bucket) and get caught by the render. The gate working as designed.
- `gate-L2-true-composite-mismatch` ×2: deep-overlap pixels where the
  composed e-ambiguity sets don't cover MuPDF's exact value — the g→e
  inversion is per-glyph; three-deep stacks can compound. Rare (0.25%).

## Honest summary

A single erased letter in this pipeline is recoverable:

- **from geometry alone**: uniquely only 4.6% of the time (advance singletons
  M W @ % ~ ^ " | ' and kern-splits); otherwise geometry hands you the
  letter's advance class — typically 11–27 candidates — and *no amount of
  additional suffix observations improves it* (the ¼-px stream saturates at
  the δ = 1/32 px floor within a few glyphs).
- **with surviving pixel evidence** (level 2): 53% unique overall; 93% when
  the letter's ink actually touched a neighbour's columns; the rest of its
  power is the erasure-footprint + white-column leak, which is intrinsic to
  the "erase only own ink" protocol and should be treated as such.
- **not at all** — provably, by byte-exact generative verification — when the
  full advance window of a letter from a populated advance class is erased in
  a kern-free context. The bucket stream then carries exactly "a glyph of
  advance 8.0 stood here": 1 of 27 equal possibilities. Language priors (never
  used above) are the only remaining channel.

Reproduce: `node bench/guess-letter.mjs --sample 300 --seed 11` ·
`--pdf ../corpus/big.pdf --sample 600 --seed 13` · `--targeted` variants ·
`--calibrate 80`. `bench/glyphs_times16.json` regenerates via
`python ..\ocr\tools\export_glyphs.py`; the level-3 worker is
`..\ocr\tools\render_hypotheses.py` (`--worker` to relocate).

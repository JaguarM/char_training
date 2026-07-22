# gpu-ocr — naive template matching, on purpose, on a GPU

A deliberate return to the original char_training idea: every letter is a
little grayscale picture, and OCR is "find pixel-perfect copies of these
pictures on the page." No renderer simulation, no compositing law, no
coverage certificate — templates with **all their problems**, traded for a
brutally simple, embarrassingly parallel core in C++20 + CUDA.

Scope so far: **Times New Roman 16 px only** (the corpus MuPDF family),
tested against `char_training/corpus/big.pdf` (340 pages). Expansion = export
more sets and pass more `--templates` flags.

## Results (RTX 5060 Ti, big.pdf, tol 0)

| metric | value |
|---|---|
| wall time, 340 pages | **1.84 s** (5.4 ms/page; 0.9 s of it is the match kernel) |
| chars read | 1,010,650 / 1,338,832 = **75.5%** |
| lines fully intact | 212 / 18,307 = **1.2%** |
| GPU vs CPU reference | hit sets IDENTICAL (`--cpu`) |

The bench scoreboard (2026-07-22, `node tools/bench.mjs`, certified gate
transcripts as reference — exact deterministic integers in
`bench-baseline.json`):

| doc | pages | wall | chars | exact lines |
|---|---|---|---|---|
| big-tnr (times_16 only, crop 3×11 −3) | 340 | 1.8 s | 98.5% | 33.8% |
| big (5-set union, same crop) | 340 | 5.2 s | 98.5% | **33.5% — union theft** |
| v3 (5-set union) | 34 | 0.5 s | 98.4% | 28.8% |
| courier_1 (4 sets, uncropped) | 25 | 0.2 s | 97.4% | 39.4% |
| courier_2 (4 sets, uncropped) | 76 | 0.6 s | 97.2% | 36.5% |

Two findings the bench surfaced on day one: (1) **naive unions steal
pixels** — adding bold/italic/courier/arial sets to big *lowers* exact lines
(6,193 → 6,130): with 3×11 crops, foreign-face templates fire inside
letters. The exact engine's grouped-union lesson, reproduced here in one
table row. (2) **crop tuning is per-family** — the TNR-swept 3×11 window
over-emits ~12% spurious chars on Courier docs; uncropped, over-emission
vanishes.

(char_training's blind reader: ~22.6 s, 0 □, byte-certified — different sport.
It simulates the renderer; this project just pattern-matches pictures.)

The 24.5% missing chars are the point of the experiment:
1. **Touching letters.** Where a neighbour's antialiasing fringe composites
   into a glyph's pixels, byte-exact matching correctly refuses BOTH letters
   ("from" → "  om"). This is the bleed problem that careful manual cropping
   used to paper over; matching only ink pixels (white template pixels are
   don't-care) is the automated equivalent, and it is not enough.
2. **Other faces.** big.pdf mixes in bold/italic Times, Courier and Arial
   spans; a regular-TNR-only dictionary cannot see them at all.
3. No unread-ink accounting: what doesn't match simply isn't there (spaces
   appear instead). The blind reader's □ honesty does not exist here.

## Pipeline

```
char_training assets (committed, zero corpus pixels)
  assets/fonts/times_16.npz      --tools/export-templates.mjs-->  data/templates/times_16.tpl
  tools/raster-cache/<sha16>/    --tools/export-pages.mjs----->   data/pages/big/page-NNNN.pgm
                                                                       |
build/gpu-ocr.exe  (C++20 + CUDA)  <-----------------------------------+
  darkListKernel   compact page's non-white pixels (~97% of a page is white)
  matchDarkKernel  one thread per (dark pixel x template), template anchored
                   at its darkest ink pixel, darkest-first early-exit,
                   |page - template| <= tol on ink pixels only
  assemble         hits -> baselines (y - dy) -> greedy left-to-right by pen
                   (x - dx + phx/4), most-ink-wins, gaps -> spaces
        -> out/big/page-NNNN.txt + all.txt
```

## Classifier (the F:\ role, live since 2026-07-22)

`node tools/classify.mjs <pdf>...` answers "which renderer family is this
doc" from PIXELS: samples interior pages (never P1/P2 — the court family's
cover pages miss), decodes them mupdf-direct with per-page palette LUTs, runs
ONE launch with every registered family's sets, and thresholds the per-SET
assembled-glyph tallies the exe emits under `--classify`. Verdicts are
MULTI-LABEL because eDiscovery compilations really mix families per section.
Two passes: tol 0 for exact families, tol 2 only for calibri's tally (its ±1
harvest wobble is part of the family proof; tol 2 for lin/no-lin twins would
destroy discrimination).

`node tools/classify.mjs --labeled` = the validation run, 2026-07-22,
**11/11 correct** on this week's labeled docs: 3× nimbusromCourt, censcbk
(93044, multi-label), 2× nimbusromLin, nimbus791, 2× calibri, and the two
junk classes (281516 resample → literally zero hits, 240536 skew → 9) as
`none`. Bonus: the 93044 run found an old-rev-NimbusRoman section (p382,
722 glyphs) and a corpus-TNR16 section (p193) inside the "censcbk" doc —
compilation structure the single-doc hunts had not mapped.

## Commands

```powershell
.\build.ps1                                     # CMake (VS 17 2022, sm_120) -> build/gpu-ocr.exe
node tools/bench.mjs                            # THE test: full roster, auto-materialize, PASS/DRIFT
node tools/bench.mjs --doc big-tnr              # one roster entry
node tools/bench.mjs --update                   # accept changed numbers as the new baseline
node tools/bench.mjs --clean                    # wipe regenerable data (pages/templates/out)

node tools/export-templates.mjs                 # manual: times_16.npz -> data/templates/times_16.tpl
node tools/export-pages.mjs                     # manual: big.pdf raster cache -> data/pages/big/*.pgm
.\build\gpu-ocr.exe                             # manual full run, text -> out/big/
node tools/compare.mjs                          # manual score vs certified transcript

.\build\gpu-ocr.exe --page 2 --print --cpu      # one page, dump text, verify GPU==CPU
.\build\gpu-ocr.exe --naive                     # brute-force every-position kernel (~6x slower)
.\build\gpu-ocr.exe --tol 2                     # per-pixel tolerance (breaks byte-exactness)
.\build\gpu-ocr.exe --crop 3 11 --crop-yoff -3  # best known single-set: 98.5% chars, 33.8% lines
```

Both exporters accept `--from <char_training root>` (default: sibling dir).
Expansion example:

```powershell
node tools/export-templates.mjs --set timesbd_16.npz
.\build\gpu-ocr.exe --templates data/templates/times_16.tpl --templates data/templates/timesbd_16.tpl
```

## Formats

**TPL1** (`data/templates/*.tpl`, little-endian): `'TPL1' u32ver f64sizePx
f64spaceAdv u32n`, then per record `u32 cp, f64 adv, u8 phx4, u8 phy2,
i16 dx, i16 dy, u16 w, u16 h, u8 gray[w*h]`. One record = one glyph at one
subpixel phase (x quarters, y halves), rendered alone on white in page space
— the full uncropped letter. `dx/dy` place the bitmap relative to the
integer pen x / baseline y; `adv` is the exact dyadic advance.

**Pages**: plain binary PGM (P5), one per page, decoded from char_training's
gzipped GRY1 raster cache (modes 1/2/3 incl. the mode-3 colored-ink
whitening flood — same laws as `raster-cache-browser.js`).

## Design notes

- Templates come from char_training's fontgen `.npz` sets — synthetic
  renders, zero corpus pixels. This project only *consumes* them; the npz
  recipe lives over there.
- Ink pixels are sorted darkest-first at load: the darkest pixel is the
  match anchor (it must sit on a dark-list pixel for the position to be
  tested at all — that's the ~30x search-space cut) and the earliest
  possible early-exit for everything else.
- TNR16's two y-phases often carry the *identical bitmap* with `dy` off by
  one, which would duplicate every line 1 px apart; exact duplicates are
  dropped at load and the assembler merges adjacent-baseline runs (real
  lines are a dozen+ px apart), majority baseline wins.
- Corpus physics (char_training `docs/MISSING_LETTER.md`): pens advance by
  exact dyadic advances, no kerning — so the greedy left-to-right
  advance-stepping resolution is principled, not a heuristic.
- `--crop W H [--crop-yoff N]` shrinks every template to a W×H window
  centered on its ink centroid (`--crop-yoff` shifts it vertically, negative
  = up, clamped to the bitmap), dodging the edge pixels a touching
  neighbour's fringe composites into. It trades discrimination for bleed
  immunity, and a 55-run sweep on big.pdf says the trade is very good:

  | crop | chars read | lines intact |
  |---|---|---|
  | none | 75.5% | 1.2% |
  | 4×12 centered | 98.0% | 25.1% |
  | **3×11, yoff −3** | **98.5%** | **33.8%** |
  | 2×8 centered | 5.6% | 0.6% |

  Width does the work: at w=3 any height ≥10 lands on the same 33.8%
  (the window already covers the bitmap), while w=5 halves the line rate
  (edge bleed re-enters) and w=2 costs discrimination *and* over-emits
  (~0.5% spurious chars). Vertical position only matters for short windows
  (h≤9), where anything not clamped to the bitmap top collapses — mid-glyph
  strips are where letters look alike. Below w=3, ambiguity wins outright:
  2×8 centered emits garbage because stems of i/l/I/t/h… become identical.
  (Cropping keeps hit sets byte-exact per template; it changes *which*
  templates exist, not the matching law. Sweep detail: exact-line rate is
  the honest metric — "chars emitted" >100% means false positives.)
- **Per-line space advance** (2026-07-22): every template carries its SET's
  space advance (explicit from the npz; a monospace set's uniform cell IS its
  space; else em/4), and the assembler votes per line — a Courier line in a
  mixed doc gets Courier gaps, a Times line Times gaps. This alone took
  courier_1 from 62 to 612 exact lines. One global `spaceAdv` cannot serve a
  mixed-pitch document.
- Template metadata lives in GLOBAL GPU memory (one cached read per block —
  the old 64KB `__constant__` array bought nothing and capped the roster at
  4,096 templates; the ceiling is now 65,535, the grid-dim limit).
- Known ideas if the char rate should ever matter more than the purity of
  the experiment: pair templates (render touching bigrams at their exact
  dyadic pen deltas — corpus physics makes the pair set finite), one-sided
  "page may be darker" acceptance, or just admit the blind reader was right.

## Testing — the bench is the contract

`node tools/bench.mjs` is this project's `npm run gate`: it materializes
whatever is missing (templates from char_training npz sets, pages from its
raster cache), runs every roster doc, scores against the certified gate
transcripts, and diffs six deterministic integers per doc (pages, lines,
glyphs, hits, exact lines, chars) against `bench-baseline.json`. Numbers are
bit-stable run to run, so ANY drift means the matcher, a template set, or a
page export changed. `--update` accepts intentional changes; the diff it
prints is the review. Run it after every change to `src/`, `tools/`, or the
roster; add a roster entry when a new doc family becomes readable.

The roster pins configs, not just docs — `big-tnr` exists so the README's
documented single-set sweep stays reproducible forever, next to the
multi-set rows that supersede it operationally.

`data/` and `out/` are disposable caches (`--clean` wipes them, the next run
regenerates on demand; pages cost ~1.6 MB each on disk). Nothing under them
is tracked. `--cpu` on any page is the kernel-correctness oracle: the GPU
hit set must be IDENTICAL to the CPU reference.

## Where this fits in the lab (and where it could go)

char_training now has two OCR philosophies, and they are complements, not
rivals:

- The **exact engine** (`src/ocr-engine.js`) simulates the renderer —
  compositing, page laws, unread-ink honesty — and certifies bytes. Its
  cost: a new face is a HUNT (this week's court sub-family took a session),
  and ~20 s/doc.
- **gpu-ocr** knows nothing. It pattern-matches pictures at ~5 ms/page and
  is wrong, by design, wherever letters touch. But 97–98% of chars with a
  ~40% exact-line rate, for any face it has templates for, in milliseconds.

The realistic future roles, in order of value:

1. **Pixel-level family classifier for the F:\ dataset** (531,281 docs,
   census done, ~3,800 palette candidates and counting). Today's census
   greps BYTES; the trust rule says pixels are the only ground truth. A
   `--classify` mode — per-set hit density per page, all registered sets in
   one kernel launch (the 65,535-template headroom is why that cap fell) —
   answers "which face/size is this doc, roughly" from PIXELS at GPU speed.
   Palette-family pages decode via mupdf raw extraction (no Chrome), so the
   feed is drive-bound and the whole pipeline stays batchable. Route winners
   to the exact engine's certified pools; only true unknowns reach a human.
2. **A growth rule that costs one command.** Templates only ever come from
   the registry's npz sets (`export-templates --set <name>.npz`). When a
   hunt closes a family, its sets are exportable here the same evening —
   nimbusrom1024 (closed yesterday) is one command away from being a
   classifier axis. Never hand-make a tpl.
3. **Page laws are the boundary.** email needs `--quant`, the nimbusrom
   family needs the per-page palette LUT — laws the exact engine applies to
   the PAGE before matching. Until export-pages learns them (a LUT pass at
   export time, like its mode-3 flood today), those docs stay off the
   roster. That is the honest line between "benchable" and not.
4. **The accuracy ceiling is structural.** Touching-letter bleed is
   compositing; naive matching can only dodge it (crop) or model it (bigram
   templates). If the last 2% of chars ever matters here, bigrams are the
   one principled extension — otherwise that job belongs to the engine.

Maintainability contract: the C++ core stays dumb on purpose (match
pictures, nothing else); new smarts prototype in `tools/` JS first; the
bench gates every change; `BENCHMARK.md` holds perf snapshots so kernel
regressions are visible too.

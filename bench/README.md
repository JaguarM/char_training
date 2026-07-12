# bench/ — headless tooling

Two generations of tools live here. **The blind reader family (first sections
below) is the current system**; the grid/template tools (benchmark, dump-ocr,
synth-templates, tracing, pruning, metrics) serve the legacy path and remain
the regression harness for `templates/` changes. The map of proven physics
and the full regression gate: [../notes/README.md](../notes/README.md).

---

# Blind reader — `blind-read.mjs` (the current OCR)

Self-calibrating byte-exact reader with **no layout constants**: ink bands,
per-band baseline/y-phase/font pinning, then a left→right composite-aware
scan that accepts a glyph only if it explains the page bytes through the
producer's blend law. Spaces are measured (pen gap vs advance, width
self-calibrated); redaction boxes / rules / vrules are detected, masked, and
reported as objects; strike-through spans are voided; unknown ink = honest
`□` with exact coordinates. Glyph sets are fontgen exports
(`glyphs_*.json`, zero corpus pixels; `*lin*` sets carry the eDiscovery
producer's linear compositor).

```
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt --verify
node blind-read.mjs --pdf ../corpus/v4.pdf --tol 0 --quant --union \
  --glyphs glyphs_times16.json,glyphs_timesbd16.json,glyphs_timesi16.json
node blind-read.mjs --raster raster-cache/<key>/page-0001.gray.gz --glyphs …
```

| Flag | Meaning |
|---|---|
| `--pdf` / `--raster` | document (pages come from `raster-cache/`; populate it once with `dump-ocr.mjs --all`) or a single cached page |
| `--page <n>` / `--all` | page selection |
| `--glyphs a.json,b.json` | glyph sets; the per-band auto-pick chooses font AND compositor |
| `--union` | merge the sets into one candidate pool so a single line may mix fonts (bold labels + regular values); opt-in |
| `--tol N` | per-pixel tolerance for near-identical rasterizers (0 = byte-exact; keep 0 unless a producer is unidentified) |
| `--quant` | palette-quantized producers (v4-family): snap every prediction to the page's available gray levels |
| `--truth <txt>` | per-row letters/spaces comparison |
| `--verify` | per-line byte-exact MuPDF re-render certificates (needs `..\ocr\tools\render_hypotheses.py`) |
| `--out` / `--json` | clean text / structured output (baselines, fonts, per-glyph ¼-px pens, objects, certificates, struck spans) |

Mode-2 (color) pages: neutral ink (R=G=B) is read byte-exactly via sum/3;
ink components connected to non-neutral pixels (hyperlink blue) are flooded
away before reading. Debug envs: `BR_DEBUG=1` (fail pixels), `BR_LINE=<baseline>`
(accept trace), `BR_PIX=<col>` (per-pixel rejection detail).

# Source recreation — `recreate.mjs`

The round-trip certificate: rebuild page rasters from a blind-read `--json`
(pens + baselines + fonts + compositor law) and byte-compare against the
cached truth outside objects/□ masks — the proof that the JSON losslessly
describes the page text.

```
node blind-read.mjs --pdf ../corpus/v3.pdf --page 2 --json p2.json
node recreate.mjs --json p2.json --pdf ../corpus/v3.pdf --page 2
```

# App Auto-OCR test — `test-blind-app.mjs`

Headless test of the browser port (`blindocr.js` + `CanvasViewer.blindOcrPage`
/ `blindOcrDocument`) through the real `training.html`: v3 P1+P2 vs truth +
the document-level API. Run after touching `blindocr.js` — the port does NOT
yet have `--union`/mode-2/strike/quant (bench-only for now).

# Erased-letter information limit — `guess-letter.mjs`

The stress-test tool behind [../notes/MISSING_LETTER.md](../notes/MISSING_LETTER.md)
(erase one glyph, infer it back at three evidence levels; also `--calibrate`
for the δ/x0 physics numbers).

---

# OCR speed benchmark (legacy grid path)

A headless benchmark for the **OCR Page** path (`ocr.js` + `reader.js`). It runs the
real matching engine and line reader in headless Chrome against a real PDF page, then
attributes the wall time to the exact leaf operations and maps each back to a
`file:line` — so you can see what to fix and re-measure after changing it.

## Run

```
cd bench
npm install                 # once — installs puppeteer-core (no Chromium download)
node ocr-bench.mjs          # benchmark page 1 of the newest *.pdf in the repo root
```

It starts `../launch.py` on a free port (so `/api/templates` and the PDF are served),
drives the same pdf.js raster-extraction the app uses, loads the served templates,
auto-anchors every row to its first inked column, then times the OCR loop (no render).

## Make it representative

The layout (row bands + font) defaults to the app's `Config`. If the report warns that
most rows stopped on `□`, the bands don't fit that PDF and the run under-counts work —
pass the **Horizontal Lines** + **Font** values you use in the UI:

```
node ocr-bench.mjs --rowBase 40 --rowHeight 15 --rowPitch 18 --rowCount 54 --fontSize 16
```

The op breakdown (which operation dominates) is valid either way; only the absolute ms
depend on a realistic layout.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--pdf <path>` | newest `*.pdf` in repo root | PDF to OCR |
| `--page <n>` | `1` | 1-based page number |
| `--runs <n>` | `5` | timed iterations (median is reported) |
| `--rowBase/--rowHeight/--rowPitch/--rowCount/--fontSize/--startX <n>` | from `Config` | layout overrides |
| `--fontFamily <s>` | Times New Roman | font family |
| `--no-autoanchor` | off | keep `Config.startX` instead of detecting line starts |
| `--chrome <path>` | auto-detect / `$CHROME` | browser executable |
| `--json` | off | machine-readable output (for regression diffs) |

## Reading the result

- **Where the time goes** — leaf ops are mutually exclusive and sum to the wall time.
  `cropPixels` indexes the whole-page grayscale buffer (built by one `getImageData` per
  page), so per-crop canvas readbacks are ~0. `matchAt` is hash-indexed: in-page probes
  hash the window once per template HEIGHT — an incremental column-major chain with a
  checkpoint per width (`mapCM`/`pokeMapCM` in `_setTemplates`) — and only page-edge
  probes still copy a crop out; `pixelsEqual*` only runs to confirm hash hits — a large
  share there means the hash index isn't being hit (check `_setTemplates`).
- **Call volume** — `cropPixels` is now only the page-edge fallback (in-page probes and
  blank tests read the page buffer strided, no copy), so its count is near zero on a
  normal page and the tool's `cropPixels`/`getImageData` buckets mostly measure the
  fallback. `isBlank` probes are driven by `_nextInk` scanning one pixel column at a time.
- **Hot spots to fix** — the leaf ops ranked by share of OCR time, with `file:line`.

---

# Extract OCR text

`dump-ocr.mjs` runs the real OCR engine against a PDF and dumps the recognised text.

```
node bench/dump-ocr.mjs --all --out out.txt   # extract every page to a clean .txt file
node bench/dump-ocr.mjs --page 3              # print rows of page 3 to stdout (debug format)
```

The `--out` mode strips quote markers and the `□` placeholder (unmatched glyphs), so the
file contains only recognised characters.

**This is also the regression check for every template or reader change**: dump the whole
document before the change and again after, then byte-compare the two files
(`node -e "const fs=require('fs'); console.log(fs.readFileSync('a.txt','utf8')===fs.readFileSync('b.txt','utf8'))"`).
For template-set changes, classify per row instead of demanding byte equality: a row that
*extends* the reference read further (fine — usually a formerly-stuck kern context), a
*truncated* or *mid-row-changed* one is a regression. Compare only finished files — a dump
still being written reads as a bogus mismatch.

The browser is set up once (templates + PDF parse), then Node drives the pages one at a
time and **streams each page's lines to the file as they're produced** — memory holds a
single page, partial output survives a crash or Ctrl-C, and there's no end-of-run stall.
Each run prints a `timing:` line to stderr splitting startup vs. setup vs. per-page OCR,
plus a `per-page split:` line attributing the per-page time (getPage / extract / setup /
ocr rows) and the raster-cache hit count.

**Raster cache.** Each page's extracted grayscale raster is persisted to
`bench/raster-cache/<sha256[:16] of the PDF>/page-NNNN.gray.gz` the first time it's
extracted (`raster-cache.mjs` + `raster-cache-browser.js`). Re-runs on the same PDF fetch
the cached buffer (served by launch.py's static handler) and skip pdf.js entirely —
including the document parse, when every page is cached. The cache stores the integer
R+G+B sums behind the engine's own `(R+G+B)/3` grayscale, so a cached page is
**bit-identical** to live extraction by construction (no PNG/canvas re-decode in the
loop); a swapped PDF hashes to a fresh directory and repopulates automatically. Delete
`bench/raster-cache/` at any time — the only cost is one live re-extraction pass.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--pdf <path>` | newest `*.pdf` in repo root | PDF to OCR |
| `--page <n>` | `1` | page to dump (ignored when `--all`) |
| `--all` | off | dump every page |
| `--out <path>` | — | write clean text to file instead of printing debug lines |
| `--templates <dir>` | `../templates` | alternate template folder (repo-relative, e.g. `templates_synth`) |
| `--chrome <path>` | auto-detect / `$CHROME` | browser executable |

---

# Synthesize the template set from the document

`synth-templates.mjs` regenerates the whole template dictionary **without hand-cutting**:
it walks every glyph of `source.txt` at its kern-correct layout position, crops the page
raster with `extractBox`'s own geometry, and writes every **distinct** raster as a PNG to
`../templates_synth/` — plus a **`template_metrics.json` with exact anchors** computed from
the layout itself (not measured after the fact), which `dump-ocr.mjs --templates` serves
and the reader consumes for guided placement.

```
node synth-templates.mjs                # all cached pages → ../templates_synth
node synth-templates.mjs --pages 1-20   # subset, faster iteration
```

Why this works (research 2026-07-03): the page images were drawn as **unhinted grayscale
Times New Roman 16px**, black on white, each glyph's pen x **quantized to the nearest
¼ px** (plus ±0.03 px of generator-side boundary jitter) and the baseline at integer
y = band top + 11. Rendering is deterministic — every occurrence of the same (char, ¼-px
phase, kern context) is byte-identical — so harvesting one crop per distinct raster
reproduces exactly what hand-cutting produced. Pages come from the **raster cache**
(run `dump-ocr.mjs --all` once to populate it); PNGs are written as RGB with
`r+g+b = cached sum`, so the engine's `(R+G+B)/3` reproduces the page bit-exactly even for
mode-2 pages. `synth-manifest.json` records every file's char, width, and occurrence count.

> **Update 2026-07-07:** the renderer is identified — MuPDF drawing PDF text (Times New
> Roman 12 pt) at 96 dpi grayscale; byte-exact proof and corrections to this paragraph's
> open hypotheses in [notes/RENDERER_IDENTIFIED.md](../notes/RENDERER_IDENTIFIED.md)
> (¼-px snap = MuPDF glyph cache, jitter is pre-snap layout-side, y snaps at ½ px,
> mode-2 needs a pdf.js-artifact check, templates are now generable).
>
> **Update 2026-07-08:** proven end to end — `templates_full_synth/` was harvested from
> MuPDF-rendered synthetic pages (this same harvester pointed at a synthetic raster
> cache; zero corpus pixels) and reads the real v3.pdf letter-identically to the live
> hand-curated dict. Recipe, snap-boundary findings, and the layout dumper
> (`dump-layout.mjs`) in [notes/SYNTHETIC_DICT.md](../notes/SYNTHETIC_DICT.md).
> For spaced comparisons run the dump with `KEEP_SPACES=1`.

The full loop — synthesize, OCR with the synthetic set, score against the transcription:

```
node synth-templates.mjs
node dump-ocr.mjs --all --templates templates_synth --out out_synth.txt
node compare-dump.mjs out_synth.txt ../source.txt
```

`compare-dump.mjs` classifies every row: **exact** · **truncated** (OCR stopped early) ·
**mismatched** (differs mid-row), prints char-level accuracy plus the source char at each
first divergence (a stuck char points at a missing/mislabeled template), and exits 0 only
when every row is exact.

State of the loop on `base64.pdf`: **18089/18089 rows byte-exact (100.000%)** with the
default harvest (advance-wide kern-context variants + exact metrics; the one historical
divergence turned out to be a `source.txt` error at P272 L11 — the page renders an F where
the transcription said E — since corrected).

## `--trim` (bleed-free where affordable)

`--trim` merges the kern-context variants of a (char, phase) and cuts the columns where
neighbour ink varies — but only while the remaining core stays at least `--min-width`
(default 5) columns wide. Wide kern-heavy letters, which carry both the variant explosion
(A: 286 variants, V: 208, Y: 231, T: 131…) and plenty of discriminative pixels, collapse
to ~one bleed-free template per ¼-px phase (A→8, V→8, Y→6); narrow glyphs keep their full
advance windows and every context variant. A merge that would shrink a core below the
floor is rolled back, so no (char, phase) ever loses its template. Result on
`base64.pdf`: **1057 templates (from 2773), still 18089/18089 rows (100.000%)**.

Why the floor is load-bearing: a narrow glyph's white margins are **negative evidence**
the exact matcher needs — an isolated `I` and the I-shaped slice of an `H`'s left stem
have identical core pixels and are only told apart by what surrounds them. Unbounded
trimming (`--min-width 0`, ~447 templates) is the cleanest position-bucket table but
collapses full-document reads to ~21% (`H→I`, `4→I` substitutions): use it for bucket
analysis only, never for OCR.

## Position accuracy (for placing text back into the PDF)

- **y**: baselines are exact — integer y = `rowBase + 18·row + 11`, zero error.
- **x**: line anchors are exact (`startX = 45`) and glyph pens follow the measureText
  layout model, so *embedding* positions computed by the same model equal the generator's
  intent exactly; the drawn ink deviates from it only by the ¼-px pen quantization
  (≤ 1/8 px) + boundary jitter (~0.04 px) ≈ **≤ 0.17 px (≤ 0.13 pt) per glyph**.
- **pixel-implied x** (layout unknown, position recovered from a single match via
  `x0 = column − anchor`): residual ≤ anchorRange/2 ≈ **±0.15–0.2 px** per glyph;
  averaging a few glyphs pins a line's origin to ~±0.02 px.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--pages <a-b\|all>` | all | page range to harvest |
| `--out <dir>` | `../templates_synth` | output folder (wiped each run) |
| `--source <path>` | the PDF's `.txt` sibling (`v3.pdf` → `v3.txt`) | ground-truth transcription |
| `--startX <n>` | `45` | fixed left anchor every row is laid out from |
| `--trim` | off | merge kern variants + cut bleed columns, respecting `--min-width` |
| `--min-width <n>` | `5` | smallest core a trim may leave; chars at/below it keep full windows |
| `--pdf <path>` | newest `*.pdf` in repo root | PDF whose raster cache to harvest |
| `--chrome <path>` | auto-detect / `$CHROME` | browser executable (layout measureText only) |

---

# Merge a harvest into an existing dictionary

A new render of the same recipe lays glyphs at fresh ¼-px phases and kern contexts, so a
few rasters exist that no earlier document drew (a `Y` with less right-neighbour bleed
reads as a gap). Instead of keeping one template set per PDF, harvest the new document
into a scratch dir and fold the genuinely new variants into the main dictionary:

```bash
node dump-ocr.mjs --all --pdf ../v3.pdf --templates ../templates --out ../out_v3.txt
node compare-dump.mjs ../out_v3.txt ../v3.txt           # misses? then:
node synth-templates.mjs --pdf ../v3.pdf --trim --min-width 5 --out ../templates_synth_new
node merge-templates.mjs ../templates_synth_new ../templates
# (corpora live in ../corpus — big.pdf/big.txt is the 340-page regression doc)
# rerun the dump + compare — and re-verify the other documents still read 100%
```

`merge-templates.mjs <srcDir> <dstDir>` drops variants whose pixels already exist for the
same char (equality on the R+G+B sums the loaders reduce to), copies new rasters under the
next free variant number, and appends their `template_metrics.json` entries (renamed to
match). It refuses to merge across different `fontSpec`s. Adding templates can change
widest-match outcomes, so the full compare on every known document is the regression gate.

---

# Trace glyphs to template files

`trace-templates.mjs` maps every OCR'd glyph back to the **template file** that matched it,
and — given a ground-truth transcription — flags the **false matches** and ranks the
culprit templates. This is how you find a mis-positioned or near-blank template (one that
reads a stray letter, like an `l` template matching a `t`'s stem a few px over) so you can
delete it.

```
node bench/trace-templates.mjs --page 12                          # every glyph: col, char, file(s)
node bench/trace-templates.mjs --page 12 --source ../source_page12.txt   # only the false matches
node bench/trace-templates.mjs --all --pdf ../v3.pdf --source ../v3.txt --templates ../templates  # doc-wide culprit ranking
```

A **false match** is a glyph the OCR emitted that the source doesn't have there — an
*insertion* in an LCS diff of the OCR line vs the source line. Each is traced to the
template file(s) whose pixels are pixel-identical to the page at that column (probing a few
px around the reader's snapped cell-left), then tallied:

```
P12 L22 col  537  FALSE 'i'  <- i_18.png        # an i template read a stray letter
…
N false matches.  Culprit templates (by false-match count):
   12  i_18.png
    7  l_26.png
    …
```

Delete the high-count culprits and re-run to confirm. The `--source` file must line up with
the dump: per page, one line per row in the same order `dump-ocr.mjs --out` writes them (a
single-page source file is indexed by row; the full `source.txt` is walked page by page,
skipping the blank line between pages). Without `--source` it just prints every glyph and
its file — handy for inspecting one suspicious spot.

A few false matches print `(no file?!)` — the glyph is still counted as false, but its
template couldn't be re-identified at the recorded column (the reader's snap landed it just
outside the probe window). The ranked list still attributes the large majority, so the top
culprits are reliable.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--pdf <path>` | newest `*.pdf` in repo root | PDF to OCR |
| `--page <n>` | `1` | page to trace (ignored when `--all`) |
| `--all` | off | trace every page |
| `--source <path>` | — | ground-truth transcription; enables false-match flagging + ranking |
| `--chrome <path>` | auto-detect / `$CHROME` | browser executable |

---

# Remove duplicate template files

`dedupe_pngs.py` deletes **byte-identical** template PNGs (same SHA-256) under `templates/`,
keeping the first of each. It catches exact re-saves; it does **not** catch near-duplicates
that differ by a pixel or a re-encode — for those, use `trace-templates.mjs` to find the
ones that actually cause false matches.

```
python bench/dedupe_pngs.py
```

---

# Prune stale templates

`prune-templates.mjs` finds (and optionally deletes) template PNGs whose glyph
**never occurs anywhere** in a PDF — so templates left over from an old document or
layout can be removed.

```
node prune-templates.mjs            # dry run: list stale templates
node prune-templates.mjs --delete   # delete them from ../templates
node prune-templates.mjs --pdf ../other.pdf --json
```

## What "matches" means

Exactly what an **exact** `matchAt` hit means (in `training.js`): a template matches when its
`w×h` block of grayscale pixels is **pixel-identical** to some crop of a page raster. The
reader's poke-tolerant pass is not replicated, so a template that only ever matches
poke-tolerantly (col 0 of row 0 differing) would be listed stale even though the reader can
still use it — rare, since such a template normally also exact-matches elsewhere, but it's a
reason to run the full-document dump comparison after `--delete` rather than trusting the
list blindly. The tool searches
that *exhaustively* — every `(x, y)` of every page, not just the OCR read paths — so a
template counts as used if its glyph appears **anywhere** in the document (any row, any
column), even where the line reader would have stopped early. Templates that never match
are stale.

## How it works

Same scaffold as the benchmark: it starts `../launch.py`, drives the app's pdf.js
raster-extraction in headless Chrome, and loads the served templates (keeping each
filename). Then, per page:

1. **Hash every column once.** Each height-15 pixel column gets a polynomial hash,
   maintained by an O(1) vertical recurrence as `y` advances down the page — so the whole
   page is column-hashed in one `O(W·H)` pass instead of re-reading 15 rows per position.
2. **Roll a window hash across each width.** For every template width, a horizontal
   rolling hash sweeps the column-hash row. A template's precomputed window hash lands in
   the same bucket the page produces only at a true match (plus rare hash collisions).
3. **Verify every hit.** Each hash hit is confirmed with the real `pixelsEqual` against
   the template's pixels — so the result is exact, never a hash guess. A template is
   marked used the first time it's confirmed and skipped thereafter.

A full per-pixel × per-template compare would be billions of ops; the two-level hash
prunes that to a single page scan while keeping the match exact.

The search only ever *fails to find* a template, so a stale verdict is safe even if some
pages don't rasterize: scanning more pages can only confirm more templates as used, never
fewer.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--pdf <path>` | newest `*.pdf` in repo root | PDF to search |
| `--delete` | off (dry run) | delete the stale templates from `../templates` |
| `--json` | off | machine-readable output |
| `--chrome <path>` | auto-detect / `$CHROME` | browser executable |

## Reading the result

- **`N/total matched`** — how many templates were confirmed somewhere in the PDF.
- **`stale (never matched)`** — the rest, listed by filename and grouped by char so you
  can eyeball what's being dropped before passing `--delete`.

---

# Measure subpixel usage range per template

`measure-metrics.mjs` OCRs the whole document and records, for **each template**, the
**subpixel bucket** at which it actually gets used — a centre and a width — into
`../templates/template_metrics.json`. At this font size a glyph only renders in a handful of
distinct subpixel buckets, so each template really stands in for one bucket; the saved bucket
tells you exactly where-in-a-pixel a template applies (and which "duplicate" templates share
the same bucket).

**The reader consumes this file.** `reader.js` auto-loads it next to the templates and,
when its `fontSpec` matches the app's, *places* each next glyph from the previous one's
measured fractional advance + anchor (and rejects candidates whose anchor contradicts the
position) instead of guessing from ink widths. Regenerate it after adding, cutting, or
deleting templates; the measurement itself always runs unguided, so re-running is never a
feedback loop. Delete the file (or change fonts) and the reader falls back to the unguided
behaviour.

```
node bench/measure-metrics.mjs                 # whole document → ../templates/template_metrics.json
node bench/measure-metrics.mjs --page 1        # one page only (fast iteration)
node bench/measure-metrics.mjs --pdf ../base64-page1.pdf
```

## What "subpixel" means here

The automated reader (`reader.js`) matches purely on the **integer pixel grid** — its
`cellLeft` is always a whole column, so it carries no subpixel. Subpixel only exists in the
font-layout math, `charX = startX + measureText(text).width` (`training.js`), i.e. the
`box.x0` a glyph would be laid out at. A glyph's subpixel is `box.x0 − Math.floor(box.x0)`,
and the set of subpixels a template is used at (over the whole document) is its bucket.

Three things make those numbers meaningful, and all must hold or the buckets smear:

- **Fixed anchor.** Every source line starts at the same x (here `45`), so all rows are
  anchored there (`--startX`, default `45`) instead of to each line's first inked column —
  otherwise every line's origin shifts by its first glyph's left bearing.
- **Kerning.** The left edge is computed kern-correctly as
  `startX + measureText(text[0..i+1]) − measureText(char_i)`, so pairs that tuck a narrow
  glyph under a wide neighbour (`Ve`, `Vp`, `Aj`…) land where the PDF actually drew them.
  Plain `measureText(prefix)` omits that kern and drifts the prediction a pixel right.
- **Circular range (no `[0,1)` wraparound).** A bucket often sits right on a pixel edge, so
  its samples land at both ~0.02 and ~0.98. Plain `min`/`max` reads that as the full `[0,1)`
  range; instead the range is the whole circle **minus its largest empty gap**, so an
  edge-straddling bucket reads tight (e.g. centre `0.99`, width `0.24`) and `hi` may exceed 1.

The layout therefore has to match the source: **12 pt Times New Roman with kerning**, rendered
at **16 px** (the page raster is 96 dpi, 72/96 = 0.75, so 12 pt → 16 px). A wrong font, size,
or anchor makes the predicted positions drift and the buckets widen.

## How it works

Same scaffold as `trace-templates.mjs` (`../launch.py` + headless Chrome), loading the
templates a second time keeping each filename so a match can be attributed to its file.
Per page: pick the largest embedded image, build the row bands, fix every row's anchor, then
for each OCR'd glyph compute its kern-correct left edge, attribute it to the template file(s)
whose pixels are identical near that column, and record the glyph's subpixel as a sample for
each matching template. Attribution probes offsets `0, ±1 … ±12` around the advance and
credits **every** matching (template, column) — same-char templates are usually shadow
variants cut a column apart (`l_3` matches at `d=-1` wherever `l_4` matches at `d=0`), and
first-offset-wins would starve the shadowed cuts of their real samples. The integer offset
never changes the recorded subpixel (frac is shift-invariant); each match's fractional
`matchColumn − x0` is pooled into the template's `anchor`. Samples are pooled across pages
and reduced to one circular range per template.

The output is **regenerated** each run (not appended). A glyph whose template can't be
re-identified at any probe offset is tallied as `unattributed`.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--pdf <path>` | newest `*.pdf` in repo root | PDF to measure |
| `--all` | on by default | measure every page (the whole-document range) |
| `--page <n>` | — | measure only page `n` (turns `--all` off) |
| `--startX <n>` | `45` | fixed left anchor every row is laid out from |
| `--autoanchor` | off | use per-line first-ink anchor instead of `--startX` |
| `--out <path>` | `../templates/template_metrics.json` | where to write |
| `--chrome <path>` | auto-detect / `$CHROME` | browser executable |

## Reading the result

`template_metrics.json` has a header (the `pdf`, `pages`, `fontSpec`/`fontSize`, `anchor`,
and `templateLeftCrop` the numbers were measured under, plus an `unattributed` total) and a
`templates` array, one row per template:

```json
{ "filename": "e_2.png", "char": "e", "width": 5, "advanceWidth": 7.1, "anchor": 0.028,
  "anchorRange": 0.242, "anchorShare": 0.998, "count": 21,
  "subpixelCenter": 0.996, "subpixelWidth": 0.242, "subpixelLo": 0.875, "subpixelHi": 1.117 }
```

- **`subpixelCenter`** — the middle of the bucket (in `[0,1)`): the subpixel this template
  stands for. Two templates of a char with the same centre are duplicates.
- **`anchor`** — the centre of `(matchColumn − x0)` over all the template's matches: one
  fractional number tying the column where the crop's pixels sit to the glyph's layout
  position (integer cut displacement and subpixel in one — rounding-free, so buckets that
  straddle `frac = 0.5` stay stable). The reader inverts it (`x0 = column − anchor`) to
  place the next glyph. **`anchorRange`** is its spread — near the bucket width for a clean
  cut, `+1` per extra column the cut can slide on its own glyph; above `0.6` the reader
  ignores the template's metrics (it can't pin position). Both are reduced over the CORE
  cluster (within ±0.5 of the median) so a handful of one-column slides out of thousands of
  samples can't blow the range up; **`anchorShare`** is the core's weight.
- **`unattributed`** (header) counts glyph boxes with no *exact* in-window match. The reader
  also reads via its poke-tolerant pass and its ungated fallbacks, so a nonzero total is
  normal and does **not** mean those glyphs go unread — the dump comparison above is the
  accuracy check; this number just locates where attribution (and template coverage) is
  thinnest.
- **`subpixelWidth`** — how tight the bucket is. Should be well under a pixel; a width
  approaching `1` means the layout is drifting (wrong font/anchor/kerning), not a genuinely
  wide bucket.
- **`subpixelLo`/`subpixelHi`** — the bucket edges; `Hi` can exceed `1` when the bucket
  straddles the pixel edge (e.g. `[0.875, 1.117]` for a centre near `1.0`).
- **`count`** — how many times the template matched across the document.

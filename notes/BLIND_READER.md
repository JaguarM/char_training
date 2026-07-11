# Blind reader — self-calibrating byte-exact OCR, no layout constants (2026-07-10)

`bench/blind-read.mjs`: the generalization step. The main reader assumes the
corpus grid (rows 40+18·r, baseline top+11, startX 45, measureText spacing);
this one assumes NOTHING about layout and measures everything from the pixels:

1. **ink bands** — blank-row splits, no row grid;
2. **baseline + y-phase + font pin** per band — candidate baselines (integer
   and ½-px) × candidate glyph sets, byte-probed on the leftmost glyphs;
3. **left→right composite-aware scan** — at the leftmost unexplained ink
   column, try every (glyph, ¼-px x-phase) whose first ink column lands there;
   predicted = blend(explained-canvas, coverage) via the proven law
   `dst=(dst·(256−e))>>8`; byte-exact acceptance; kern overlap handled by
   "pending darker" pixels that the next glyph must settle. Pens fall out on
   the ¼-px lattice with no layout prior;
4. **non-text objects** — near-solid column runs (redaction boxes, rules) are
   detected, masked, and reported instead of hallucinated into glyphs;
5. **spaces are measured** — gap = pen gap − advance; the one-space width is
   self-calibrated from the document's own gap histogram. Narrow "styled"
   spaces stop being model errors and become measurements;
6. **`--verify` certificate** — every clean line is re-rendered through real
   MuPDF (font-aware `render_hypotheses.py`) at the recovered pens and
   byte-compared against the page. A line either re-renders EXACTLY or it is
   flagged. This is the mechanism that makes "100% accuracy" an honest claim
   at scale: the system never silently guesses.

Glyph sets are pure fontgen renders (`export_glyphs.py`, zero corpus pixels),
now exported at all 4 x-phases × both y-phases; times16 / arial16 / georgia16
are checked in as regenerable artifacts.

## Results

**v3.pdf, all 34 pages, zero layout knowledge:**
- 1758/1758 lines **byte-exact re-render certificates** (boxes excluded as
  reported objects).
- vs v3.txt: 1733 rows letter-exact, 1726 also space-exact. Every "differing"
  row is on **page 1 — which v3.txt never transcribed at all** (0 non-empty
  rows). The blind reader read it and MuPDF certified every line, i.e. it
  strictly exceeds the historical pipeline's coverage. The handful of
  space-count differences elsewhere are the narrow-space rows SPACE_REVIEW
  already disputes — and inspection settles them in the blind reader's favor:
  v3.txt carries collapses like "customersusetheAmericanExpress…" and dropped
  spaces before trailing '=' soft-breaks where the pixels draw real (narrow)
  gaps. The blind transcription is the pixel-true one; v3.txt inherited the
  old fitter's failures on those rows.
- The styled-row problem of the old model **does not exist here**: pens are
  measured, so the 14% of rows that violated the measureText grid read (and
  verify) like any other row.
- Redaction boxes: detected and reported (they initially read as "HHHR8k…"
  glyph chains hiding inside solid black — the verify certificate caught it,
  and box detection + a pending-fraction cap fixed it).
- ~1.5–2 s/page in un-optimized node.

**Hostile pages** (MuPDF's own string layout — its advances, not our
measureText model; random per-line margins 31–83 px; non-integer pitch
19.7/21.1/22.2 px; ½-px baselines; three fonts, auto-detected):

| page | read | verify |
|---|---|---|
| hostile_times | 10/10 letter+space exact | 10/10 byte-exact |
| hostile_arial | 10/10 letter+space exact | 10/10 byte-exact |
| hostile_georgia | 10/10 letter+space exact | 10/10 byte-exact |

**big.pdf, all 340 pages, zero layout knowledge:**
- 18,300 lines · **1,338,400 glyphs** · 13 unreadable clusters (□) · 989 s
  (2.9 s/page naive).
- **18,288/18,293 lines byte-exact re-render certificates** (99.97%; the 5
  failures + 7 unverified □-lines are FLAGGED, exact coordinates known — the
  operating model working as intended).
- vs big.txt: 18,263 rows letter-exact (18,160 also space-exact), 37 differ —
  again dominated by **page 1, which big.txt never transcribed** (0 non-empty
  rows: "Hey Bossman,=20 … Sent from my iPhone"), plus lines split around
  redaction boxes. Space diffs are the same pixel-true corrections as on v3
  (one cosmetic issue found: gaps spanning a masked box are emitted as spaces
  — should be suppressed).

## 2026-07-11 update — page-level objects + v3.txt page 1 filled in

- New page-level object pass (`detectObjects`): long near-solid horizontal
  runs → thin (≤4 rows) = rules/underlines, tall = redaction boxes; padded
  don't-care mask feeds banding, scanning, and the verify compare. Underlined
  link text now reads normally; box-only and rule-only bands produce reported
  objects instead of □/hallucinations. This unlocked three more P1 lines
  ("Brice cell:", "> Date: August 2, 2013 3:46:17 PM EDT", "link to view your
  trip details: =").
- **Why the old reader saw page 1 as empty, solved:** v3 P1 baselines sit at
  53+18r — shifted +2 px from the 51+18r grid of every other page. The
  fixed-grid template reader looked 2 px off and matched nothing. The blind
  reader measures the grid per band and doesn't care. (One line, "> =", is
  even 1 px off P1's own grid at y880 — byte-verified there.)
- **corpus/v3.txt updated**: 40 page-1 rows written from the blind read
  (39 byte-certified; the "> From:" line's `<` sliver half-under the
  redaction box is dropped as unreadable — everything else on that line is
  glyph-byte-matched). Full-doc re-read vs the updated file: 1774 rows
  letter-exact (from 1733), 11 differ — ALL remaining diffs are P5/P6
  link-area rows where v3.txt is still incomplete (incl. the documented
  P5 L13 truncation), i.e. further fix candidates of the same kind, held
  back pending review because they overlap the SPACE_REVIEW disputes.
- `--json` output added: per line baseline/y-phase/font/text/verified/fails +
  page objects — the structured "product" output for real use.

## 2026-07-11 — Auto OCR in the main app (browser port)

`blindocr.js` (DOM-free, loaded by training.html) is the browser port of the
scanner: same object detection, band/baseline/font pinning, composite scan and
measured spaces, running on the engine's own page buffer. The **"Auto OCR"**
toolbar button (`CanvasViewer.blindOcrPage`) maps results into the normal row
model: measured bands become rowBands, glyph boxes sit at the MEASURED pens
(`rowPens` branch in boxesForRow — hover/edit/double-click-extract all work on
arbitrary layouts), redaction boxes/rules draw as magenta/amber overlays, and
the info line reports lines / byte-clean count / detected font / measured
space width. Editing a row or touching grid settings exits blind mode for
that row/page; the grid "OCR Page" path is untouched (regression-checked).

In-app certificate: no Python in the app, so instead of the MuPDF re-render
the port certifies a line as **byte-clean** when every non-object ink pixel
of its band was explained byte-exactly through the blend law (fails = 0,
residual = 0) — the same composition the bench cross-checks against real
MuPDF. Glyph sets are fetched from `bench/glyphs_*.json` (any exported set
joins the auto font pick).

Headless test (`bench/test-blind-app.mjs`, real training.html + viewer):
v3 P1 40 rows / 39 byte-clean (the □-flagged From-line shown honestly),
v3 P2 54/54 rows byte-clean and exact vs v3.txt, hostile arial page 10/10
byte-clean with arial auto-detected and space self-calibrated to 4.42 px
(true: 4.445).

## What this establishes

- The document-specific layer of the project (grid constants, startX,
  measureText spacing model) was scaffolding, not foundation. The durable
  asset — byte-exact renderer physics + glyph rasters + the blend law — reads
  arbitrary layouts and multiple fonts with no per-document tuning.
- Accuracy is **certified, not sampled**: byte-identical re-render per line.
  For millions of documents the operational model is: read → verify →
  byte-exact lines are DONE (proven correct against the pixels), flagged
  lines (unknown glyphs □, unverifiable, odd gaps) go to a queue with exact
  coordinates. Errors cannot pass silently; only unmodeled objects can cost
  coverage.

## Known limits / next steps for the millions-of-docs goal

1. **Renderer family**: byte-exactness holds for MuPDF-96dpi-gray output (all
   3 corpus docs + anything from that producer). Other rasterizers (pdfium,
   Ghostscript) need their own identification pass — same methodology that
   unmasked MuPDF (RENDERER_IDENTIFIED.md); match-rate collapse makes
   mismatches self-announcing, never silent.
2. **Fonts/sizes**: adding one = one fontgen run (`fontgen.py <ttf> <px>` +
   `export_glyphs.py`). Auto-pick already works per band; a first-band font
   census per document would prune the candidate list for speed. Sizes other
   than 16 px and bold/italic variants (timesbd/timesi npz already exist)
   are the immediate next exports.
3. **Speed**: ~2 s/page naive is ~8 days/million pages on one core — already
   parallelizable to days on a small machine pool. The scan is embarrassingly
   optimizable (candidate indexing by first-column profile, the strided-match
   tricks from the 144s→21s dump-ocr work); 10–20×/core is realistic.
4. **Mode-2 (RGB) pages** (email.pdf hyperlink blue): loader currently
   requires mode 1; extend with the sum/3 reduction + exact color handling.
5. **Unknown glyphs** (non-ASCII, em-dashes, ligature fonts): today → honest
   □ + unverified line. The fix is bigger charsets in fontgen exports.
6. **Multi-column / tables / graphics**: bands are full-width today; x-gap
   segmentation within bands is straightforward and flagged-not-silent until
   built.

Reproduce:
`node bench/blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt --verify`
· hostile pages: `python ..\ocr\tools\make_hostile.py <dir>` then
`--raster <dir>/hostile_arial.gray.gz --glyphs glyphs_times16.json,glyphs_arial16.json,glyphs_georgia16.json`.

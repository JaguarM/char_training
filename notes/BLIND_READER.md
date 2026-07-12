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

## 2026-07-11 PM — report.pdf: first foreign-producer document (tolerant mode)

`corpus/report.pdf` (7 pages, from report.docx via Word-era tooling) is NOT
from the corpus renderer, and the blind reader now reads it:

- **Same architecture, different PAGE COMPOSITOR (producer identified).**
  Same 816×1056 gray pages, integer baselines, and the same ¼-px pen lattice
  (every glyph phase ∈ {0,16,32,48}/64). Body = Times 12pt (the docx default
  style size — never in the explicit size list), headings = Times bold.
  The "older FreeType" hypothesis was DISPROVEN by direct test (FT 2.6.5,
  2.7.1, 2.8.1, 2.13.2 render bit-identically; old mutool 1.2–1.11 are worse,
  1.14+ identical): the producer rasterizes glyphs with modern MuPDF (≥1.14)
  — our fontgen rasters are ITS rasters — but composites the page itself with
  plain integer alpha blending. Verified byte model (0/110 singles, 512
  ¼-phase sliding hits, 0/499 on double-overlap pixels): single glyph
  `page = g+1` for g∈128..254 else g; overlaps composite multiplicatively in
  255-space with floor, +1 per contributing "light" glyph. Implemented as
  `linear`-flagged glyph sets (glyphs_timeslin16 / timesbdlin16 /
  timesilin16 / tnr8lin16 / tnr8lin10) — the per-band auto-pick chooses the
  compositor model like it chooses the font.

  **Exact "light glyph" semantics** (settled 2026-07-11, hunt session): the
  map lives in RAW MuPDF byte space — a pixel is light iff its raw
  single-on-white MuPDF byte ∈ [128, 254] (raw 127 is unreachable on white;
  raw 255 = no ink). The producer adds +1 to exactly those pixels, so
  linear-set bytes are raw+1 there, i.e. gb ∈ [129, 255] — and gb = 255
  (raw 254, coverage ~1/255) is erased to white and drops out of the ink
  mask entirely. The reader's `gb >= 129 && gb !== 255` is therefore exactly
  "raw ∈ [128, 254] and the pixel still carries ink"; `gb − 1 = raw` is
  valid precisely on [129, 254]. Prose "128..254" (raw space) and code
  "≥129" (linear space) are the same set, one representation apart. The
  renderer hunt itself is documented in the `..\ocr` workspace
  (REPORT_RENDERER_HUNT — that session works from `C:\Users\yanni\Desktop\ocr`).
- **`--tol N` mode** (bench + app): glyph-ink pixels match within ±N (double
  on composite pixels — two curves' deviations compound at junctions like
  f-hook ∩ i-dot), the anchor scan and canvas bookkeeping stay exact, and
  ≤3-pixel unexplained residues that are faint or hug explained ink are
  absorbed as junction/rasterizer dust. Three real tolerance-mode bugs were
  found this way (anchor slip on faint leading AA, composite-pixel
  "stealing", compound junction deviations) — all fixed; **tol 0 semantics
  are untouched** (v3/big/hostile still byte-exact, regression-checked).
- **Charset extension**: fontgen DEFAULT_CHARS now includes ‘’“”–—…•§¶© and
  the ﬁ/ﬂ ligatures (the report pipeline LIGATES — readers transcribe ﬁ→"fi").
  All exported sets regenerated at 107 chars × 8 phases.
- **Vertical rules** (table/quote borders) detected as objects, same as
  horizontal rules/boxes.
- **Result: 220 lines, 12.8k glyphs, 10 □ · 210/220 lines are exact
  substrings of the docx text** — and every remaining diff is a PROVEN
  docx-vs-page revision difference, not a read error: the docx contains
  "Subject Devide-23/-25" typos, "on the floor on the dining room",
  lowercase "first floor" where the page prints "First Floor", a serial
  number the docx lacks, and a sentence naming SARAH KELLEN that the page
  version dropped. The pixel-true transcription out-audits its own ground
  truth, again.
- **App**: blindocr.js carries the linear compositor (per-set flag, same as
  the bench) and Auto OCR escalates tol 0 → 1 → 2 → 10, keeping the
  lowest-tolerance / fewest-failures read and labelling results honestly
  ("byte-clean" vs "clean@±N · tolerant mode"). Headless tests: report P1 =
  33/33 lines clean@±2 (plus one honest □ band); v3 regression unchanged
  (39/40 + 54/54 byte-clean at tol 0, no escalation).
- **App modernized to Auto-OCR-first** (same day): "Auto OCR All" +
  "Download .txt" now run the blind reader over the whole document
  (`CanvasViewer.blindOcrDocument`, page-provider based and headless-testable),
  and a new ".json" export carries per-line baseline / font / certificate /
  tolerance plus detected objects — the structured product output. The legacy
  grid/template tools (Load Templates, Grid OCR Page, row-grid and font
  settings) moved into a collapsed "Legacy" panel: still functional (bench
  dump-ocr drives those code paths), templates now load on demand instead of
  at startup. Reader.js/ocr.js internals untouched.
- Bench with linear sets: 210/220 docx-matching lines at **tol 1** (was ±10
  before the compositor was identified) — same accuracy, far stronger
  certificate.

Open on this document: ~10 □ clusters (superscript ordinals and similar
small-size glyphs need per-size sets — tnr8lin10 exists, more sizes as
needed) and the last ±1 rounding stragglers in the linear model fit.

## 2026-07-11 evening — positions everywhere + SOURCE RECREATION certificate

The ultimate goal is recreating the source, so glyph positions are now a
first-class output and there is a tool that PROVES the output is lossless:

- **Per-glyph ¼-px pens in every export**: bench `--json` (added by the hunt
  session) and the app's `.json` download both carry `glyphs: [[ch, pen], …]`
  per line alongside baseline / y-phase / font / certificate. A page is fully
  described by (glyph, pen, baseline, font, compositor) + objects.
- **`bench/recreate.mjs`** — the round-trip certificate: reads a positions
  JSON, re-renders every page (mupdf-model lines through real MuPDF via the
  worker; linear-model lines composed in pure JS with the fitted producer
  law), and byte-compares against the cached truth outside objects/□ masks.
  Results: **v3 P2 byte-exact recreation (0 stray px)**; **report.pdf 5/7
  pages byte-exact** with only the documented one-sided composite-slack
  pixels (2–15/page) — pages 5–6 differ exactly at the hunt doc's root-caused
  reader object-handling issues (over-masked box, false vrule), i.e. the
  recreation tool independently confirms that diagnosis.
- **App parity + speed**: the one-sided composite slack is ported to
  blindocr.js (report P2 in-app: 34/34 byte-clean at tol 0, linear set
  auto-picked); readPage now fast-paths each band with the previous band's
  winning (font, y-phase) and only falls back to the full sweep on a miss;
  blindOcrDocument learns the winning tolerance from page to page (ties
  prefer the lower tolerance, so certificates never weaken without cause).

## 2026-07-12 — exact box extents (the "and ███" fix)

Three compounding `detectObjects`/scan defects made words beside redaction
boxes vanish (report.pdf "…including ███ ~~and~~ GHISLAINE MAXWELL", v3 P5
link rows). Fixed in blind-read.mjs and ported to blindocr.js:

1. **Bridged rows stretched the box bbox.** Per-row dark runs jump the ≤1px
   AA gap between a box edge and the next word's first letters, so the
   merged bbox ran ~10px past the solid edge and the ±2 mask swallowed
   "an" of "and". A real box edge is CONSTANT across its rows while bridges
   vary, so each box is now split into row segments of near-constant raw
   extent (short burst segments between agreeing neighbours are absorbed)
   and each segment's edge is the MODE of its rows. This also splits
   **stacked different-width redactions** (v3 P5 has 9px- and 61px-offset
   pairs previously merged into one bbox — the 9px pair defeated simpler
   solid-core trimming) into exact per-box segments.
2. **False vrule from descender + box.** A 'g' stem touching a box top
   merges with the box's own dark column into one 40px+ vertical run; the
   fake vrule's mask ate the g. Vrules whose length is >60% covered by box
   segments (coverage summed across segments) are dropped.
3. **□ absorption ate words behind boxes.** The fail-absorption loop counted
   masked object ink as ink, so a □ next to a box absorbed every word
   sharing columns with the box ("the" of "concerning the identity").
   Masked pixels are now don't-care there too.

Regression (all improved, nothing lost): report.pdf 34 lines / 2031 glyphs /
**2 □** (was 5; both remaining are pre-existing: the tol-1 hex junction pixel
+ the small-size footer digits). v3 all 34 pages: 1785 lines, □ 12→**2**,
letter-exact 1773→**1779**, +101 glyphs (P5's "may apply…visiting" and
href rows now read fully — old code stopped at the fake vrule); **MuPDF
verify: P1 40/40, P5 54/54 byte-exact re-renders** (P1 was 39/40 — the '<'
sliver beside the box now reads). big.pdf all 340 pages: 18,307 lines,
1,338,822 glyphs (+422), □ 13→**4**, letter-exact 18,263→**18,271**, differing
rows 37→36 (all remaining are the documented big.txt-untranscribed P1 rows).
App headless test: v3 P1 40/40 + P2 54/54 byte-clean, document API 94/94
unchanged.

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

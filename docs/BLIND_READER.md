# Blind reader — self-calibrating byte-exact OCR, no layout constants

> This file is chronological (newest sections at the BOTTOM). Docs map +
> regression gate: [README.md](README.md).

## Current state (2026-07-12)

`tools/blind-read.mjs` (browser port `blindocr.js` = the app's Auto OCR) is
THE reader. Capabilities: measured bands/baselines/fonts (per-band auto-pick
across glyph sets), byte-exact composite-aware scan, measured spaces,
non-text objects (mode-voted box extents, rules, vrules), strike-through
voiding, mode-2 color pages (neutral-sum reading + colored-ink flood),
`--union` mixed-font lines, `--tol N` for unidentified rasterizers,
`--quant` for palette-quantized producers, `--verify` MuPDF re-render
certificates, `--json` positions export (round-trip-proven by
`tools/recreate.mjs`).

| Document | Producer / mode | Result (2026-07-12) |
|---|---|---|
| v3.pdf (34 p) | corpus MuPDF, tol 0 | 1785 lines · 122,865 glyphs · 2 □ · 1779 rows letter-exact vs truth |
| big.pdf (340 p) | corpus MuPDF, tol 0 | 18,307 · 1,338,822 · 4 □ · 18,271 letter-exact |
| report page | eDiscovery linear law, tol 0, `*lin*` sets | 34 lines · 2031 glyphs · 2 □ (both root-caused; PDF lives on only as raster cache a42927acc2aaca91) |
| v4.pdf (1 p) | palette-quantized, tol 0 `--quant --union` | 28 lines · 823 glyphs · 3 □ (2 separator bands + 1 struck-line fragment); blue/struck spans deliberately blank |

Known limits: superscript/small-size glyphs need per-size sets; blindocr.js
lacks union/mode-2/strike/quant; multi-column bands; other rasterizer
families (pdfium/Ghostscript) unidentified — mismatches self-announce as
match-rate collapse, never silent errors.

---

## 2026-07-10 — the original design

`tools/blind-read.mjs`: the generalization step. The main reader assumes the
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
MuPDF. Glyph sets are fetched from `assets/glyphs/glyphs_*.json` (any exported set
joins the auto font pick).

Headless test (`tools/test-blind-app.mjs`, real training.html + viewer):
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
- **`tools/recreate.mjs`** — the round-trip certificate: reads a positions
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

## 2026-07-12 PM — corpus/v4.pdf: color pages, mixed fonts per line, strike-through

v4.pdf (1 page, an email print: Times 16px, MuPDF-family but ±2/px off our
rasters — reads at `--tol 2`) exercised three new reader capabilities
(tools/blind-read.mjs only; not yet in blindocr.js):

- **Mode-2 (color) raster support** in `readGray`: pages are u16 R+G+B sums.
  Achromatic ink (plain black text) has sum ≡ 0 (mod 3) at every pixel, so
  gray = sum/3 is exact there; colored ink (hyperlink blue) is non-neutral at
  least on its AA edges. Every ink component connected to a non-neutral pixel
  is whitened before reading — blue link text (and anything fused to it, e.g.
  a strike bar that continues over black words) simply disappears and the
  plain text reads normally.
- **`--union`**: merges all given glyph sets into one candidate pool with a
  per-glyph compositor flag, so a single line can mix fonts — v4's header
  lines are bold "From:/To:/Date:/Subject:" labels + regular values, which
  the per-band single-font pick could never read. Opt-in; per-band detection
  (and --verify) unchanged without it.
- **Strike-through suppression**: a `rule` object crossing a line's x-height
  ([baseline−10, baseline−2], underlines don't match) that is NOT vertically
  adjacent to a box (box top/bottom edge segments also land there) voids the
  struck span: glyphs overlapping it and □s inside it are dropped, and the
  line carries a `struck` field in the JSON. Struck text is deliberately not
  transcribed.

Result: every plain-text line reads (headers, body, disclaimer); blue
addresses/links and struck spans come out blank; the two remaining UNREAD
bands are decorative separators (a tiny "=" mark and a row of ~8px
asterisks). Regression: v3 1785/122865/2□/1779 exact, report.pdf (via cached
raster a42927acc2aaca91 — the PDF left corpus/) byte-identical to the morning
run, big.pdf unchanged.

Repro: `node blind-read.mjs --pdf ../corpus/v4.pdf --tol 0 --quant --union
--glyphs glyphs_times16.json,glyphs_timesbd16.json,glyphs_timesi16.json`

**Same evening — v4 solved to tol 0 (`--quant`).** The ±2 deviations turned
out to be PALETTE QUANTIZATION, not a foreign rasterizer. The byte-proven
model (this paragraph is the full record):

1. The rasterizer is plain modern MuPDF — our fontgen Times rasters are its
   rasters (75% of single-glyph ink pixels byte-exact before modeling step 2).
2. v4's page image is an `/Indexed /DeviceRGB 255` XObject, 816×1056 native
   (no rescale; 612×792 MediaBox → exactly 96 dpi); its 256-entry palette
   keeps only **172 neutral (R=G=B) levels** plus the hyperlink blues.
3. The law: `page = Q(orig)`, `Q(v)` = nearest neutral palette level, **ties
   toward darker** — fitted per byte value over 566 glyphs / ~23k
   single-glyph pixels, all 254 observed values conform (4 apparent
   exceptions were colored-ink sums ≡ 0 mod 3 polluting the availability set).
4. pdf.js is lossless here: the mode-2 raster cache (key `5df5c985891500ac`)
   is byte-identical to decoding the palette image directly — 0 mismatches
   over 861,696 pixels.

`--quant` implements it with NO per-document fitting: the available-gray set
is read off the (color-flooded) page histogram — every actual page byte is
present by construction, and palette grays are fixpoints of Q — and every
prediction-vs-page compare routes through Q while the scan canvas stays in
ORIGINAL space (the producer composited first, quantized once at the end).
Composite kern-junction pixels: MuPDF blend, then Q; no extra slack. Rule of
thumb this adds: a document reading "almost but ±1" against a proven
rasterizer = **check for a palette before hunting renderers** (`/Indexed` in
the PDF, or a gappy gray histogram). Palettized page images are common in
eDiscovery pipelines, so this should generalize far.

Open: the app port (blindocr.js) lacks mode-2/union/strike/quant — the app
sees the engine's (R+G+B)/3 buffer, but has canvas RGBA available so per-pixel
R==G==B would be even cleaner there.

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
`node tools/blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt --verify`
· hostile pages: `python ..\ocr\tools\make_hostile.py <dir>` then
`--raster <dir>/hostile_arial.gray.gz --glyphs glyphs_times16.json,glyphs_arial16.json,glyphs_georgia16.json`.

## 2026-07-12 (late) — email.pdf reads 0 □; Auto OCR reaches bench parity

Session prompt: [EMAIL_VRULE_PROMPT.md](EMAIL_VRULE_PROMPT.md). The confirmed
quote-bar root cause was real but email.pdf hid three more; all four fixes
landed in BOTH `tools/blind-read.mjs` and `blindocr.js` (kept in sync), and
the app port closed the whole feature gap (color pages, `--quant`, `--union`,
strike suppression) — the "Open:" item of the previous section is done.

**1. Light-constant rules** (`detectObjects`, both readers). The blockquote
quote bar is column 56, gray 204 constant, 982 rows, exactly 1 px wide with NO
AA columns (measured on all 36 pages; single bar, no nesting; no light
horizontal separators in email). New rule alongside the dark-run rule: a
strictly-contiguous run of near-constant light gray (len ≥40, min ≥160,
max−min ≤8) is a rule regardless of darkness — text can't fake it (blank
inter-line rows break column runs; glyph AA never holds one value for 40 px).
Applied to rows AND columns, feeding the existing merge/segment/mask pipeline,
so light runs merge into their dark neighbours: the underline AA rows that v3
(27) and big (13) carry at constant gray 187 simply thicken their rule objects
by a row and stay inside the ±2 mask padding — v3/report gate numbers
unchanged. The bar comes out as a reported `vrule` object (app draws it).

**2. email P1 is palette-quantized** (the v4 producer family). After bands
split, P1 still failed with the signature "page byte exactly 1 darker than
prediction" (98 vs 99, 96 vs 97, 215 vs 216) — the physics rule "±1 off a
proven rasterizer = check for a palette first" paid off immediately: `--quant`
took P1 from 311 □ to clean. P1 and P36 are mode-2 (hyperlink blue, colored
ink flooded); the palette map is read off the flooded page, and quant is a
no-op on the mode-1 pages 2–35 (byte-identical reads with/without).

**3. Detached-ink bands are not □s** (`readPage`, both). Two shapes: (a) a
line with '_' but no descenders — the '_' strokes (baseline+2..3) sit below a
blank row, so findBands makes them their own 2-row band although the line's
scan window (baseline+maxDesc) already read and reported them; (b) an 'i' dot
split from its stem, where the donor line comes AFTER the band. Fix: an
`explained` page mask records every ink pixel the accepted scans reproduced
byte-exactly; bands with no fresh ink are skipped, and unread bands are
re-checked against the final mask before being counted (□ only if some ink
was never explained by any line).

**4. Baseline below the band bottom** (`readPage`, both). A band of only
'-' or '*' glyphs (separators: `--` signature line, `****…` divider) has ALL
its ink above the baseline; the true baseline lies below the band's last ink
row, outside the probe range. On probe failure only, a second sweep tries
yb ∈ (bot, bot+maxAsc]. This also un-□'d v4's two "decorative separator
bands" — they were never decorations but a `--` line and a `*…*` line, and
now read as text (v4: 28→30 lines, 823→884 glyphs, 3→1 □; the 1 is the
struck-fragment, deliberate).

**email.pdf certified** (tol 0 + quant, glyphs_times16 only):
`1908 lines, 113,599 glyphs, 0 □` · vs `email.txt`: 1898 letter-exact, 10
differ — all classified, none a reader error: 5 truth char-drops (the known
exporter defect: "reuested", "ofers", "Epress", "sofware", "coying", a lost
','), 1 truth truncation (P32 base64 line ends mid-stream like v3.txt P5L13),
4 hyperlink rows (colored spans deliberately blank / truth flows the URL text
differently). Quoted lines carry real '>' glyphs at a larger margin, as
predicted; space calibration unaffected.

**App parity port** (`blindocr.js` + `training.js` + `ocr.js`):
- `BlindOCR.whitenColored(page, rgba?)` — colored-ink flood; exact per-pixel
  R≠G≠B when the canvas RGBA is available (`engine.pageRGBA`), fractional-gray
  fallback (the bench's sum%3 signal) for seeded cache pages.
- `BlindOCR.quantMap` / `unionSets` + per-glyph compositor (`g.lin ?? lin`),
  quant-aware scan/probe/residual, strike suppression, fixes 1/3/4 — all
  line-for-line the bench logic.
- Auto OCR escalation ladder is now passes, not tolerances: `{0}`,
  `{0,quant}`, `{1}`, `{2}`, `{0,union}`, `{0,quant,union}`, `{10}` — fewest
  fails wins, ties to the earliest (weakest-machinery) pass, previous page's
  winner tried first; certificates labelled (`byte-clean`, `·palette`,
  `·mixed-font`), never silently weakened.
- `test-blind-app.mjs` now also runs email P1 (color+palette+boxes) and P2
  (quote bar), letters-only truth compare (email.txt spacing differs):
  `v3 P1 40/40 byte-clean · v3 P2 54/54 · email P1 54 lines byte-clean,
  48/54 letter-exact (6 = the classified truth rows) · email P2 54/54
  letter-exact` — the app reads email.pdf as cleanly as the bench.

Gate after this session (update docs/README.md when these move):
v3 `1785 / 122,865 / 2 □ / 1779 letter-exact` (unchanged) · big `18,308 /
1,338,823 / 4 □ / 18,271 letter-exact` (+1 line +1 glyph: P211's clipped
base64 "ix" row — an unread □ band before — now pins its baseline via fix 4
and reads the 'i'; same 4 □, verified by old-vs-new full-text diff = that
single line) ·
report-raster `34 / 2031 / 2 □` (unchanged) · v4 `30 / 884 / 1 □` (improved,
see fix 4; regress via `--raster raster-cache/5df5c985891500ac/page-0001.gray.gz`
— the PDF left corpus/) · email `1908 / 113,599 / 0 □ / 1898 letter-exact`
(new).

## 2026-07-12 (courier) — courier_1/2.pdf read byte-exact; grouped union pools; small-box rule; v4 retired

New corpus docs from the user: `courier_1.pdf` (25 p) and `courier_2.pdf`
(76 p) — the document family the ORIGINAL char_training-main project (grid +
NCC, 7×11 px templates, hardcoded xStart 60 / pitch 7.8026 / rowHeight 15)
was built for: email headers in Times 16px (bold labels, redaction boxes)
with the body — including pages of dense quoted base64 — in **Courier New
13px em** (advance 7.8 px, row pitch 15; the old grid constants are exactly
this font's metrics). Same corpus MuPDF producer: the Times header read
byte-exact at tol 0 before any new work.

**Courier glyph set.** `fontgen.py C:/Windows/Fonts/cour.ttf 13` +
`export_glyphs.py` → `glyphs_cour13.json` (gitignored, like all sets; also in
the app's loadSets defaults). With it, the body reads byte-exact at tol 0 —
zero per-document tuning, as designed.

**Union pools must be GROUPED.** First attempt fed one global `--union` pool
(times trio + cour13): the body lost glyphs — `Cont□□t-Type`, a dash gone —
because a Times sliver byte-matched a fragment of the Courier 'e'/'-' at a
nearby pen, got accepted (pending-tolerance let it), and left one unexplained
pixel that □-absorbed its neighbours. Cross-SIZE pools are the hazard; fonts
that genuinely mix within a line share their size. Fixes:
- bench: `--glyphs a.json+b.json,c.json` — `+` joins into one pool, `,`
  separates per-band-pick sets ([a∪b, c]); `--union` (merge all) kept.
- app: the union pass groups sets by `sizePx` into pools automatically.
- app ladder reordered — ALL byte-exact passes (`{0}`, `{0,quant}`,
  `{0,union}`, `{0,quant,union}`) before any tolerance pass; previously the
  tol-2 early-stop could end escalation before union was ever tried.

**Small solid boxes** (`detectObjects`, both readers). courier_2 P1 has an
inline redaction only 23 px wide — under the 40 px dark-run threshold, so it
was never masked and each of the two text lines it crosses lost a word to □
absorption. New rule: a stack of ≥8 rows whose strictly-contiguous dark runs
(10–39 px) share one x-extent (±1) is a filled box — glyphs can't fake it
(letter interiors break contiguity; no glyph stack holds a constant extent
for 8 rows — x-height spans ~7). Words beside the box now read; +4 glyphs on
courier_2, byte-identical everywhere else.

**Certified** (tol 0, `glyphs_times16+timesbd16+timesi16,cour13`):
courier_1 `1552 lines / 114,816 glyphs / 1 □` · courier_2 `4899 / 374,461 /
1 □`. Each doc's □ is the redacted `From:` line on P1: the '>' after the
address box is partially OVERLAPPED by the box, and glyph pixels composited
with box ink can't byte-match glyph-on-white — honest, root-caused, the
covered pixels are unrecoverable by construction. `corpus/courier_1.txt` /
`courier_2.txt` are the reader's own certified transcriptions (no external
truth exists for these docs). Byte-exactness matters most exactly here: the
base64 payload has zero redundancy — one glyph confusion corrupts the
decoded attachment, which is why the old NCC confidence approach was risky.

**App**: courier_1 P1 in-app = 57 rows, 57/57 letter-exact vs the certified
transcription, via the sizePx-grouped union pass (16px pool + cour13);
`test-blind-app.mjs` runs it as a standing case.

**v4 retired from the gate** — raster cache removed at user request (the PDF
had already left corpus/); last certified numbers recorded in
docs/README.md. Full gate after this session: v3 `1785 / 122,865 / 2 □` ·
big `18,308 / 1,338,823 / 4 □` · email `1908 / 113,599 / 0 □` · report-raster
`34 / 2031 / 2 □` · courier_1 `1552 / 114,816 / 1 □` · courier_2 `4899 /
374,461 / 1 □` — all green, expected numbers in docs/README.md.

## 2026-07-13 — 15–50× speedup, byte-identical: big.pdf in 72 s

User priority: Auto OCR speed on large documents (vs the legacy grid path's
53 ms/page; blind was ~3 s/page). Profile first: 83% of wall time was the
scanLine candidate-trial loop — not the baseline probing (4%). Three
constant-factor changes plus one structural, in BOTH readers, with the page
bytes' verdict that nothing changed but time:

1. **Incremental unexplained tracking.** A per-column count of
   page≠q(canvas) pixels, maintained on every canvas write; nextUnexplained
   becomes a pointer walk instead of re-scanning the band window after every
   accepted glyph.
2. **Hot-loop precomputation.** Each glyph raster carries inkC/inkR/inkB
   arrays (column, row, byte per ink pixel) built at load — the trial loop
   drops its per-pixel div/mod/lookups and closure calls for direct indexing.
3. **Fresh-canvas fast path.** On white canvas every e ∈ INV[gb] reproduces
   gb by construction (the raster was rendered on white with the same law),
   so prediction === raster byte and the e-loop collapses to one compare —
   the overwhelmingly common case. (Bench: BR_PIX debug disables it so
   per-pixel diagnostics stay complete.) Also: anchor-inside test hoisted
   before pixel work, accepted-set string check moved after it.
4. **Bench last-winner fast path** (the app already had it): the previous
   band's (set, phy) is probed first and wins when it fully reads — the full
   sets × phy × baseline sweep now runs only on font/style changes.

Verified byte-identical, not just "still passes": every gate count AND
letter/space-exact totals unchanged on all five documents, plus full-text
`--out` byte-compare on courier_1+courier_2 against the pre-optimization
transcriptions — zero byte diffs.

| Document | before | after | |
|---|---|---|---|
| big.pdf (340 p) | 1034 s | **72 s** | 0.21 s/page, 14× |
| v3.pdf (34 p) | 96 s | **5.1 s** | 19× |
| email.pdf (36 p) | 95 s | **5.8 s** | 16× |
| courier_1 (25 p) | 190 s | **4.4 s** | 43× |
| courier_2 (76 p) | 668 s | **13.7 s** | 49× |
| report raster (1 p) | 5.1 s | **0.5 s** | 10× |

Post-profile: scanLine 32%, the rest spread over raster decode,
detectObjects, and readPage bookkeeping — no dominant hotspot left. The
app runs the identical code (test-blind-app: all cases byte-identical; the
whole 5-page suite incl. browser startup is ~10 s). At ~0.2 s/page one core
does ~430k pages/day; the earlier "~8 days/million pages" estimate is now
~2.3 days/million on ONE core, before any parallelism. Next lever if ever
needed: candidate shortlist indexed by first-ink-column signature (the
legacy hashPixels idea) — deliberately NOT done now, since it interacts
with pending/kern semantics and the constant-factor work already reached
the target.

## 2026-07-13 (later) — legacy grid/template path removed

With Auto OCR at full parity and 15–50× faster, the user retired the legacy
path. Deleted: `templates/` (1,465 PNGs) + `templates_full_synth/`,
`reader.js`, the app's Legacy panel + `matchAt` + grid-settings bindings,
`DOCUMENTATION.md`, and the grid bench tools (dump-ocr, ocr-bench,
synth-templates, trace/prune/merge-templates, measure-anchor/metrics/spaces,
compare-dump, adopt-ocr-rows, fix-spaces, dump-layout, ttf.mjs).
`launch.py` no longer serves `/api/templates`; readiness probes use
`/training.html`.

What replaced the one real dependency: **`tools/rasterize.mjs`** populates
the raster cache (PDF → pdf.js embedded-image extraction → gray() → GRY1),
which `dump-ocr.mjs` used to do as a side effect of legacy OCR. Proven
byte-identical: deleted a cached courier_1 page, regenerated it through the
new tool, `cmp` clean against the backup — existing caches stay valid (same
key, same bytes).

Slimmed survivors: `ocr.js` is now `PageEngine` (page buffer + `pageRGBA`
only — buffer semantics unchanged), `core.js` keeps stem↔char maps /
`makeRowBands` / `gray()` (the pixel-equality and hashing primitives left
with the matcher), `test.js` trimmed accordingly (3/3 pass). The `Config`
grid in `training.js` remains as the pre-OCR placeholder row model.

Post-removal gate: byte-identical across all six documents and the app test
(v3 `1785/122,865/2□/1779` · big `18,308/1,338,823/4□/18,271` · email
`1908/113,599/0□` · report `34/2031/2□` · courier_1 `1552/114,816/1□` ·
courier_2 `4899/374,461/1□`). The original standalone grid-NCC tool lives on
outside the repo in `../char_training-main/` (reference only).

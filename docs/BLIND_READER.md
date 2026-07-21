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
`--quant` for palette-quantized producers, `--json` positions export
(round-trip-proven in the 07-11 hunt session by the since-retired
`recreate.mjs`; the MuPDF `--verify` re-render certificate also retired with
the Python tooling 2026-07-15 — tag `python-era`).

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
6. **`--verify` certificate** *(retired 2026-07-15 with the Python tooling —
   tag `python-era`)* — every clean line was re-rendered through real MuPDF
   (font-aware `render_hypotheses.py`) at the recovered pens and
   byte-compared against the page; it certified v3 1758/1758. The honesty
   mechanism it provided lives on in the reader's own gray-law byte
   acceptance (a glyph is only accepted if it explains the page bytes
   exactly), which is what the whole regression gate runs on.

Glyph sets are pure fontgen renders (zero corpus pixels), exported from the
committed `assets/fonts/*.npz` at all 4 x-phases × both y-phases by
`tools/export-glyphs.mjs`; the committed sets are proven reproducible from
the committed rasters (`npm run glyphs-check`).

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
  renderer hunt itself is documented in
  [REPORT_RENDERER_HUNT.md](REPORT_RENDERER_HUNT.md) (the ocr workspace it
  ran from is retired — history in
  [archive/RENDERER_HUNT_NOTES.md](archive/RENDERER_HUNT_NOTES.md)).
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
2. **Fonts/sizes**: every proven font's rasters are committed
   (`assets/fonts/*.npz`) — a new SET from an existing .npz is one
   `tools/export-glyphs.mjs` run. Rendering rasters for a brand-NEW font/size
   needs the retired Python generator (tag `python-era`,
   `tools/fontgen/fontgen.py`). Auto-pick already works per band; a
   first-band font census per document would prune the candidate list for
   speed.
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
· hostile pages: `python make_hostile.py <dir>` (archived ocr workspace zip) then
`--raster <dir>/hostile_arial.gray.gz --glyphs glyphs_times16.json,glyphs_arial16.json,glyphs_georgia16.json`.

## 2026-07-12 (late) — email.pdf reads 0 □; Auto OCR reaches bench parity

Session prompt: [archive/EMAIL_VRULE_PROMPT.md](archive/EMAIL_VRULE_PROMPT.md). The confirmed
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

## 2026-07-14 — redaction-aware masking + box fragments (NEW/ ladder session)

NEW/times docs (FBI email efta00037366, Maxwell-case email EFTA00010016)
exposed a family of defects around redaction boxes. All fixed in
blind-read.mjs AND ported to blindocr.js; every change below is bench+app.

1. **Adaptive mask padding.** The blanket ±2 mask pad silently swallowed real
   glyphs pressed against boxes: a ',' between two boxes (byte-identical to
   the phase-0.5 raster, zero box ink on it), the ':' of v3 "Karen cell:",
   the '.' of "Bobbi C." above a black letterhead banner, the courier
   From:-line '>'. Physics: object fill AA reaches at most ONE pixel beyond
   the detected dark extent, and only as a near-CONSTANT light line (same
   coverage every row/column — sideAA test: ≥90% of the side inked, median
   ≥160, ≥60% of rows within ±3 of it; glyph composites may darken a
   minority, corners lighten one). X sides: pad 1px only when that signature
   holds. Y sides: boxes adaptive the same way; rules/vrules KEEP blanket ±2
   (underline over/under rows are a legitimate glyph∩rule composite zone —
   link rows regress if made adaptive).
2. **Box halos + box fragments.** Redactors draw boxes from x-height up, so
   ascender tips of the REDACTED text poke 1-3 rows above the box top, and a
   half-swallowed trailing glyph pokes a few px past the side ('>' apex).
   Unexplained ink confined to a box's ±4-col/±3-row halo is now reported as
   a **box fragment** (JSON boxFrags per line, fragment-only bands dropped
   as lines, console "N box fragments"), NOT a text □: that ink is destroyed
   by the document, not unread by the reader. □ now means strictly "readable-
   in-principle text the reader could not explain".
3. **Component absorb + one □ per blob.** A fail used to absorb ink column-
   range-wise to the next blank column, eating readable glyphs that merely
   shared columns with the blob (the comma above; "Thank"/"r>" on v3 P6).
   A fail now floods the 8-connected components through the fail column;
   frag components absorb whole, fail components absorb only x ≤ col+2 so
   intact kern-connected tail letters still get tries; one □ per blob via a
   right-edge guard.
4. **Probe anchor = densest ink cluster (xp).** All baseline probes window
   [start, start+160]; a box-edge fragment at a band's left edge aimed that
   window into the box span and the whole band went unread ("Jeff Pagliuca"
   band). Probes now anchor at the start of the band's densest unmasked-ink
   cluster (gaps ≤8px bridge).
5. **0-glyph lines demote to unread bands.** With component-absorb, a
   dot-only band above a real line could pin a shifted-but-equivalent
   baseline (627/phy0 ≡ 626/phy0.5) through the probe's +20px window, then
   read zero glyphs — creating a phantom line the explained-by-below filter
   never saw (email P1 'i'-dot of "services."). Any line with zero glyphs is
   now pushed as an unread band so the filter judges it.

Gate (2026-07-14 final, docs/README.md updated): v3 1785/122,878/**1 □**/1
frag (□ = P6 y303 blob head; "</a>&", "r>Thank", "Karen cell:" all newly
read — the colon is truer than the truth file) · big 18,308/1,338,832/**3
□**/1 frag (P211 clipped-base64 'i' row + P339 mailto tail characters poking
past their redaction crossed by its underline rules; the old 4th is now a
frag) · email 1908/113,599/0□/1898 UNCHANGED · report 34/**2032**/2□/1 frag
(the x233 protrusion reclassified; +1 glyph = a newly readable glyph beside
a box) · courier_1 1552/114,817/**0□** · courier_2 4899/374,462/**0□**/2
frags — the From:-line '>' beside the redaction now READS on both (only the
box's own AA column is masked; truth files regenerated with the '>') · NEW
certified: efta00037366 17/544/0□ (was 2□), EFTA00010016 17/649/0□/17 frags
(was 10□ — reads ", Jeff Pagliuca <", "BOBBI C. STERNHEIM, ESQ." '.', tips
classified), EFTA00382108 1545/114,273/0□ (glyph-tip frag), EFTA00434905
305/22,796/0□ · app test byte-clean everywhere, courier_1 P1 57/57
letter-exact.

## 2026-07-14 PM — mode-3 rasters (true colorness), JPEG jitter, French accents

The times/ mode-2 color docs (EFTA00756043/928083/954445/10037/9865) exposed
two information limits and a family of scan-order defects. All fixed in
blind-read.mjs AND blindocr.js; gate green, app test byte-clean.

1. **Mode-3 raster cache (u16 sums + u8 channel spread).** Sum-only mode 2 is
   BLIND to colors whose sum ≡ 0 (mod 3): a pure-blue (0,0,237) mailto
   underline reads as "neutral 79" and can never byte-match; and it floods
   whole letters over ±1 channel jitter. rasterize.mjs now computes per-pixel
   max−min from the canvas RGBA; rcEncodePage writes mode 3 whenever any
   spread exists. Law (readGray mode 3 / rcFetchPage / whitenColored-rgba):
   spread ≥ 4 = real color → whitening flood that spreads only through
   pixels whose channels differ AT ALL (colored AA fringes) and never
   through neutral ink — a redaction box touching a link underline survives
   while the underline vanishes. Spread 1–3 = producer JPEG jitter, NOT
   color: true gray = round(sum/3) (3g±1 rounds back exactly; two-channel
   jitter lands within --tol 1). Legacy mode-2 caches keep the old law
   byte-for-byte (certified docs untouched); the five affected docs were
   re-rasterized. Jittered docs certify at --tol 1 (same posture as the
   report-raster's tol-1 junction pixels).
2. **sideAA at any darkness.** A box's constant edge row (value 27) missed
   the ≥40px run detector by ONE corner pixel and the mode≥160 (then ≥64)
   bound refused to pad it. A ≥90%-covered ±3-constant line adjacent to a
   box cannot be text at ANY level (glyph AA never holds one value that
   long) — the darkness bound is gone.
3. **Scan-window clamp (bandTop/cTop).** The accent charset grew maxAsc past
   the 18px line pitch: scan windows reached the previous line's descenders
   and failed on their ink. Unexplained-ink accounting (unexpl, flood,
   dust, residual) now starts at the band's own top; the window bottom
   stays open ('_'-only bands below are still explained through).
4. **Skip overlay + tail recovery.** Absorbed-fail pixels used to poison
   later candidates (canvas=page ⇒ composite math): a word whose head fell
   into box residue could never read from its tail. Absorbed pixels now
   join a scan-local don't-care overlay (one combined array with the object
   mask — single load in the hot loop), so "wrote:"/"TELL ME"/"r>Thank"
   read past unexplainable heads.
5. **Deferred fail/frag classification.** At fail time the flood cannot know
   which connected ink a LATER try will read (a remnant kerned into "TELL
   ME" measures 22px; its dead survivors span 8). Final scans record the
   component and judge the survivors at line end: touches a box halo
   (rect ±2 cols/±3 rows, box top/bottom 'rule' slices count as the box)
   AND narrow (< 13px — under two glyph widths) = box fragment; touch
   chains across a remnant's disconnected letters (≤ 4px gaps). Probes
   never pass halos and keep immediate fails.
6. **Phantom-line demotion.** With flood-absorb, an 'i'-dot band above a
   real line could pin that line's baseline through the +20px window
   (627/phy0 ≡ 626/phy0.5) and "read" the line's own 'i' as a 1-glyph
   phantom (double-counting ink the explained-filter never saw). Lines
   that read nothing demote to unread bands; BELOW-band picks whose
   explained ink lies mostly below their band demote too (real below-band
   picks — separator rows, a lone '>' — explain ink inside their band).
7. **French accents.** fontgen DEFAULT_CHARS now carries Western-European
   accents (Envoyé, à — 171 chars); times/timesbd/timesi/arial 16px
   regenerated + arialbd16/timesbd17/timesbd18/times13/cour11/cour12
   exported. Existing rasters are unchanged by regeneration (grid slots
   append), but the bigger candidate set costs ~15% page time (big.pdf
   95s ≈ 0.28 s/page).

Gate (2026-07-14 PM, docs/README.md updated): **v3 0 □** (first time — P6
y303's "<br>" head reads via tail recovery) · **big 0 □**, 18,307 lines
(−1: a pre-existing phantom line left the count), 34 diff rows ·
email/courier_1/courier_2/report unchanged-or-equal · NEW certified at
tol 0: courier/EFTA00434905+EFTA00382108, times/efta00037366+EFTA00010016+
EFTA00161526 (arial16 body)+EFTA00009888; at tol 1 (JPEG jitter):
times/EFTA00756043 (60 lines, 11 frags). All seven truths round-trip
0-diff. Still open: times/EFTA00928083 (36 □) + EFTA00010037 (25 □) +
EFTA00009865 (68 □) — same jitter family, remaining fails not yet
root-caused; times/EFTA00954445 2 □ (big-print "From" header face
unidentified — not timesbd16/17/18/arialbd16 — and a mid-line wisp);
NEW/courier 7516xx block: DIGITAL renders (perfectly vertical constant
frames), one 816×1056 DeviceGray image per page + Courier ~8.8pt OCR
overlay, ~12px-em serif-ish digits — face unidentified (not cour11/12/13/16,
not times13), needs its own renderer hunt; calibri/ + segoe/ untouched.

## 2026-07-14 late — union font attribution + 7516xx findings (user feedback)

**Times headings displayed as Courier (and vice versa).** The multi-font
email docs read correctly, but per-line font IDENTITY was lost whenever a
union pool was involved: L.font was the pool's name and Recto's
ocrFontFromSetName took `split('+')[0]` — the first set in load order — so
every union-pass line displayed as one family. Union candidates now carry
their source set (`src`), accepted glyphs keep it, and each line's L.font
is the MAJORITY VOTE over its byte-certified glyphs. EFTA00434905 P1 now
reports timesbd16 ("From:"/"To:" are bold!), times16 (Subject/Date), cour13
(body) — and Recto shows the same (recto-test status: "timesbd16 times16
arial16"). Bench JSON `font` + per-glyph `src` updated; metadata-only, gate
numbers unchanged.

**EFTA00751637 (the framed 7516xx block).** The 2px page frame is correctly
objectified (vrules x31-33/x783-785, rules y38/y1023) and banding is fine
(72 bands, 12-13px pitch) — the block is NOT blocked on line detection.
Body advance measures 6.0009765625 px = **Courier New 10px em exactly**;
but the rasterizer is foreign: 'D' is 7 rows tall vs MuPDF-cour10's 6,
much darker (2-col stems 118+227 vs single 152). Excluded so far: MuPDF
cour10/11/12/13/16, times13, PIL hinted-freetype 10. Headings are likely
Times (per user). Next: REPORT_RENDERER_HUNT methodology at 10px (GDI,
Ghostscript, supersampled downscale, freetype hint modes).

## 2026-07-16 — anchor-column candidate index (~1.7× read speed, gate identical)

**Where the time went.** After the 07-13 speed work, scanLine was still 75%
of self time — almost all of it the candidate trial loop (every anchor
column tries every candidate of the phase, ~700 per set, ×3 back offsets).

**The index.** Candidates are now grouped ("sorted by pixels") by the
ink-row bit pattern of their first TWO ink columns: two 64-bit masks over
the band window's rows (bit = dy+row+maxAsc). At each anchor the scanner
builds the page-side mask of the anchor column (ink OR skip rows) once,
and rejects a whole group with one `AND` when the group needs ink where
the page is white. This is *provably* the same acceptance: a fresh-canvas
prediction < 255−2·TOL at a white page pixel always rejects (composite
canvas at a white page pixel is impossible outside the skip overlay, which
the page-side mask counts as ink); near-white predictions stay out of the
glyph masks. A `_i` tie-break keeps best-candidate selection independent
of group iteration order. times16: 684 candidates/phase → 133 groups → 296
subgroups. Cache per (set, phy), re-keyed on the per-page quant map.

**Certified 2026-07-16** — every gate transcript byte-identical: v3 8.8→4.5s,
big 104→62s (0.17 s/page), email 9.2→4.6s, courier_1 6.1→2.5s, courier_2
→7.0s, report-raster + EFTA00756043 (tol 1) unchanged. Ported to
blindocr.js; app test + sync-recto + recto-test green.

**Same-day experiment (why not narrower):** `--matchcols N` (blind-read
only) restricts *matching* to each glyph's middle N ink columns while still
subtracting the full raster. N=8 stays byte-identical on the whole gate;
N=7..5 misplace flat wide glyphs — `=` and `_` have all four x-phases
byte-identical in their middle 7 columns (phase identity lives in the
outermost AA columns) — 200 □ on v3; N≤4 confuses identities ('.=' swaps);
N≤2 collapses. Storage cannot be cut at all: an accepted glyph must explain
ALL its ink or the remainder floods the line with □s.

## 2026-07-16 late — cross-page baseline hints + truth-index (bench)

**User insight: "assume every page is the same as the last one."** Kept
certification-safe by making it a HINT, not an assumption: readPage now
takes a cross-page `carry` — every certified line stores its pick keyed by
BASELINE y (band tops/bottoms shift with ascender/descender content;
baselines repeat page to page), and the next page tries any stored pick
whose baseline falls inside the new band FIRST, as a single 160px probe.
Accepted only when the probe fully reads (≥3 glyphs, 0 fails) — a stale
hint costs one probe and falls back to the previous-band fast path, then
the full (set × phy × yb) sweep. `last` (set, phy) also carries across the
page break. A cached measurement, not a layout constant: every acceptance
is still byte-proven on the page it reads.

**Truth-index.** The gate's per-line `truth.find(...)` was O(rows²) —
~20s of big.pdf's run was the COMPARISON, not the reading. Now a Map from
letters-only text to first matching truth row (identical semantics,
including first-match ties).

**Certified** — whole gate byte-identical transcripts: big 61.9→33.4s
(pure read ~33s, 0.09 s/page; was 104s this morning), v3 4.5→3.5s, email
4.6→3.9s, courier_1 2.5→~2.4s, courier_2 7.0→6.5s, report + EFTA00756043
(tol 1) unchanged.

**Label drift (known, accepted).** The y-phase 0.5 rasters are dy-shifted
byte-duplicates of phase 0, so (yb, phy 0) and (yb−1, phy 0.5) are the SAME
read with two names. The full sweep always lands on one canonical label;
a hint propagates whichever label the previous page certified — 1682 v3
lines / 6 big lines carry the other name in --json (baseline ±1, phy
swapped). Text, glyph pens, fonts, fails: byte-identical. If canonical
labels ever matter, normalize at store time or drop the redundant 0.5
phase from candidate pools (would also halve them).

**App: ported same day (user: both projects must behave the same — Recto
already HAS the bulk flow, its "Read all pages" button).** readPage takes
`opts.carry`; readPageAuto takes a caller-owned per-DOCUMENT carry and
scopes it per pass config internally, so a hint can never carry one pass's
machinery (a union pool, a palette read) into a stricter pass and weaken
its certificate label. The carry also reuses the built union pools across
pages (readPage used to rebuild them — and their anchor-column groups —
every call). Wired identically in both embedders: char_training
blindOcrDocument and Recto ocrRun(allPages) create one carry per
sequential document read; the single-page buttons (training "Auto OCR" =
Recto "Read this Page") stay stateless so a page's labels never depend on
what was read before it. Parity fix found during the audit: training's
Auto OCR button re-ran the whole pass ladder on every press while Recto
remembered the winning pass — training now keeps `_blindPassHint` across
presses, reset on image load (Recto resets on document:loaded). Certified:
test-blind-app (document API runs THROUGH the carry, 94/94 byte-clean,
unchanged), sync-recto, test-recto-app PASS.

## 2026-07-16 PM — advance chaining + true-alpha (a64) storage

Two matcher-core upgrades, each certified gate-byte-identical (transcripts
AND summaries) before the next; `tools/gate.mjs` (`npm run gate`) now runs
the whole documented gate and byte-compares against a reference directory,
so "byte-identical" is one command instead of six.

**Advance chaining.** Within a word the next pen is the previous pen +
advance snapped to the ¼-px lattice (pens snap to ¼ px, layout bias
δ ∈ [0, 1/32 px] — MISSING_LETTER.md), so after every accept the scanner
probes the predicted pen and its ±1 ¼-px snap neighbours against the
pen's PHASE bucket (per phase, per dx+inkLeft — only candidates whose
first ink column can land on the anchor are walked, each carrying its own
anchor-column bitmasks) before paying for the full anchor-column scan.
94% of big.pdf's 1.43M accepts come straight off the chain. Two
byte-identity rules bought with regressions during bring-up:

- ONE candidate-trial implementation (`tryCand`) is shared by the chained
  probe and the anchor scan — acceptance physics cannot diverge.
- ALL probe pens accumulate before judging, then anchor priority
  (col > col−1 > col−2), score, original order. Breaking at the first
  probe with a hit read `&lt;` as `&lt,` — ',' is the bottom of ';', and a
  phase-degenerate comma byte-passed at one probed pen before the true
  semicolon at the neighbouring pen was ever tried (big grew 5 □,
  email 1 □; both gone with accumulation).

A background run is a natural resync: chained candidates whose first ink
column misses the anchor simply don't apply (styled rows justify spaces to
2.4–2.8 px — the space advance is never trusted). Any fail resets the
chain. ±2 probes were tried and are unreachable (error bound: pen snap
1/8 + δ 1/32 < ¼); the wider window only slowed the walk.

**True-alpha storage.** export-glyphs.mjs now stores, beside each raster's
gray-on-white window, the true rasterizer alpha derived through the set's
law, and every set carries a law tag (standard | linear). Standard:
gb = (255·(256−e))>>8 with e = cov+(cov>>7) inverts to a canonical
coverage — the ONLY collision is gb 0 (cov 254/255), and both predict page
byte 0 at every canvas value, so one prediction is byte-identical by
construction. Linear: alpha = the producer's raw byte (gb − sh). The
matcher's composite path is now a single prediction from inkA (no INV
e-loop; INV itself is gone). The fresh-canvas fast path and the linear
composite-1-lighter allowance are untouched.

**Certified.** Gate 6/6 byte-identical after each stage (v3, big, email,
report-raster, courier_1/2 — transcripts and summaries), test-blind-app
green (email P1 48/54 vs defect truth, courier_1 57/57), glyphs-check
30/30, NEW/ spot checks (EFTA00382108 1545/114,273/0□/1 frag,
EFTA00434905 305/22,796/0□/1 frag — the frag is pre-existing, verified
against the stashed pre-change engine; its truth round-trips 0-diff),
sync-recto + test-recto-app PASS. Speed: big.pdf 34.6 → ~31.5 s
(~0.09 s/page), v3 3.8 → ~3.3 s; chaining is most of the win, a64 is
mostly a precision/format change (the e-loop was already short).

**Keyed lookup (planned stage 3) — NOT built.** Its trigger was "only if
1+2 leave search as the bottleneck". Post-change profile of big.pdf:
candidate search (chain walk + fallback scan) ≈ 3.2 s (10%), behind
detectObjects ≈ 8.4 s (26%) and the winner's own pixel certification
≈ 5.6 s (17%, irreducible physics). Remaining cheap-ish levers if speed
matters later: fuse/row-major detectObjects' five full-page sweeps
(~24 ms/page on every page), de-closure scanLine's pageAt/canAt in the
init loops (~2 s), and the per-band window init (~1.7 s, paid by every
probe).

## 2026-07-16 late — one glyph bundle + committed gate reference

**glyphs.bin.** The 30 per-set JSONs are gone: every glyph set now lives in
ONE committed binary bundle, `assets/glyphs/glyphs.bin` (raw gray +
true-alpha planes, per-set directory with lazy slices; layout documented in
`tools/glyph-bundle.mjs`, the node reader — the browser reader is
`blindocr.js` parseBundleDir/materializeSet). export-glyphs.mjs builds it
from the .npz rasters through an EXPLICIT name → npz manifest (the old
fuzzy filename matching is gone); `--check` byte-compares the committed
bundle against an in-memory rebuild. Loaders keep every name spelling
working (`--glyphs times16` = `--glyphs glyphs_times16.json`); the app's
DEFAULT_SETS list (12 names) is unchanged and deliberate — Recto's
index.json now lists just `glyphs.bin`, and a bare .bin entry loads every
set in the bundle (Recto shipped all 30 before, same behavior). Candidate
insertion order (char × phx) is preserved exactly — it is
tie-break-significant. Honest numbers: set loading was ~30 ms/run and is
dominated by the ink-list precompute, not JSON parsing — the win is one
file, one fetch, no name guessing, not milliseconds. The parked
`glyphs_tnr8lin16_OFF.json` stays as JSON provenance, outside the bundle.

**tools/gate-ref/ (committed) = the expected numbers.** `npm run gate` now
byte-compares against it by default; re-record with
`node gate.mjs --out gate-ref --ref none` only after an INTENDED output
change. The hand-maintained expected-numbers prose in docs/README.md shrank
to root-cause notes — counts live in the reference summaries.

**Certified** (whole chain, bundle + gate-ref): gate 6/6 byte-identical vs
the pre-bundle reference, test-blind-app green, glyphs-check green, npm
test green, sync-recto (bundle replaces the 30 JSONs in Recto's static
dir) + test-recto-app PASS.

**Known friction NOT fixed (recommendation).** The matcher core exists
TWICE — tools/blind-read.mjs and src/blindocr.js are structural twins and
every engine change is written two times (this session included). The fix
is one shared engine consumed by both (blindocr.js is already DOM-free);
it is a half-session refactor with the gate as the safety net, best done
as its own session.

## 2026-07-19 eve — the Outside In Courier block: nimbus791 + stacked-band reading

The `NEW/courier` 7516xx/7543xx/7569xx block (11 EFTA docs, previously 0
lines anywhere) reads completely: **all 11 docs 0 □**, ~4,960 lines /
~353k glyphs, ~1 s/doc, truths beside the PDFs (round-trip letter- AND
space-exact). Two ingredients:

**The font.** The producer (Oracle Outside In) embeds a MuPDF-lineage
renderer using its built-in base-14 Courier — **URW Nimbus Mono (CFF)** at
em64 791 = 12.359375 px isotropic, unhinted FT + ftgrays, single draw,
standard blend, pens ¼-px-x / integer-y (the full hunt lives in
`ocr/FINDINGS.md`). New set `nimbus791` (phy 0 only — the engine takes
phy-0-only sets as-is): `assets/fonts/nimbus_791.npz`, generated by the new
**tools/fontgen.mjs** through the certified ftclone and certified by
`ocr/tools/check-npz.mjs` — 113/113 hunt targets byte-exact. Advance
7.415625 px (600/1000 em) sits within the chained-pen probe's ±¼ tolerance;
the 166 "composition" targets of the hunt needed nothing: neighbor-AA bleed
IS the engine's pending/composite path.

**The engine: stacked bands.** At this em the line pitch (12.36) is smaller
than maxAsc+maxDesc (11+4), so adjacent lines' ink rows interleave and
bands stop separating lines — three new pieces in ocr-engine.js, all
covered by new synthetic unit tests:

- **Band splitting** (readPage work list): a picked baseline that cannot
  reach the band's top rows (yb − maxAsc > top with fresh ink above) splits
  the band; the upper segment is read FIRST (transcript order, explained
  map filled before the lower scan judges shared rows). Symmetric
  below-window split guards any mid-band pick (a stale cross-page hint
  orphaned everything below its line — silent text loss, now impossible).
  Cross-page hints are bottom-anchored like the probe sweeps
  (yb ≥ bot − maxDesc, inclusive — the off-by-one flipped 4 email-gate
  baseline labels to their phy-equivalent siblings before the ≥).
- **cTop/cBot symmetry** (scanLine): split-created upper segments clamp
  unexplained-ink JUDGING at the split boundary (their glyphs still blend
  and explain through it); normal bands keep the open bottom that inline-'_'
  reading requires.
- **Fail retro-check** (readPage end): every fail records its dead pixels;
  a line's own absorbed fail pixels no longer masquerade as "explained",
  and a fail whose dead ink another line fully explains (a neighbour's
  ascender tip row-glued into this band, e.g. one 241-byte '/' top pixel)
  is retracted at page end.

Gate: **6/6 byte-identical** (no re-record); npm test 22/22; app test
green; recto-test PASS — and now uploads `NEW/courier/EFTA00751637.pdf`
through the real file input instead of trusting Recto's app-side default
document (which is currently swapped to the unsolved efta00018586 for
Recto-side experiments — the plugin itself is a verbatim synced copy).

## 2026-07-21 — detectObjects fast paths + discriminating-first trial order (byte-identical speedups)

Three engine changes, all proven output-identical (experiments/fastread
glyph-stream hash on big + v3, gate 7/7 BYTE-IDENTICAL, app + Recto tests):

- **White-word fast path in the fused detector pass.** The page is viewed 4
  bytes at a time (`Uint32`); an all-white word with idle row machines (always
  true after ≤2 whites) reduces to closing open COLUMN runs, tracked in a
  per-column bitset — idle columns (margins) cost one bit test per 4 px. Runs
  close at the same (x,y) as per-pixel code; shortRuns can only close
  per-pixel (an open sS means the word wasn't all-white), so
  rows/shortRuns/vcols are identical. The same scan now also harvests RAW ink
  runs (x0/x1/minv per row) into typed arrays.
- **Dust/ghost sweep: per-pixel DFS flood → row-run connected components.**
  The flood (9 neighbour checks per ink pixel) was the single most expensive
  loop in detectObjects. Now: the harvested raw runs are split where the
  object mask covers them (per-row interval list mirroring the mask bytes;
  a truncated piece re-reads the page only to recompute its min byte), then
  union-find merges 8-connected runs; per-root n/minv/bbox accumulate in
  typed arrays. Downstream consumers (transitive keep, swarm grouping) are
  fixpoints/partitions, so component order cannot change the outcome.
- **Census-rare ink trial order** (rareOrder, applied once per pool in
  anchorGroups): tryCand's verdict is order-invariant (hard-reject iff ANY
  ink pixel fails; counts are sums), and build order (column-major) is
  pessimal because candidates anchor by their first ink column. Pixels are
  reordered rarest-(row,col,byte-bucket)-first over the pool census; wrong
  candidates die in ~3 px instead of ~9 (27.6 trials per accepted glyph
  measured on big).

Speed: big.pdf full read 26.7 → 22.6 s bench (gate doc 23.3 s), v3 3.1 → 2.4 s;
detectObjects phase 9.1 → 5.9 s on big. Measurement harness + instrumented
counters: experiments/fastread/ (temporary, deletable — everything landed
here is self-contained in src/ocr-engine.js).

**07-21 addendum — speck neighbourhood grid.** The dust logic's remaining cost
was the "is this speck near text?" comparisons: every speck walked the whole
big-blob list, restarting on each promotion, and the swarm pass compared every
lonely speck against every other. Both now run on a 16px bucket grid (bigs
padded +8 dropped into the cells they cover; specks probe only their own
cells; promotions propagate by BFS instead of restarting; swarm components
found the same way at radius 12). The keep set is a monotone closure and the
swarm groups a partition, so verdicts are identical by construction — gate
7/7 + app + Recto re-verified. Pages with zero specks skip every allocation.
Synthetic residue page (2,400 letters + 800 specks): detectObjects
210 → 8.7 ms/page, identical mask.

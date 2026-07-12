# SOLVED (2026-07-11 PM): report.pdf's rasterizer identified & modeled

The hunt is over. The producer is NOT an old FreeType/MuPDF vintage — it is
**modern MuPDF glyph coverage (any build 1.14–1.27; they render bit-identically
here) composited by the eDiscovery tool's own imaging layer with plain
integer alpha blending**, then flattened to gray. Yannic's context (files
imaged 2006–2026 by an eDiscovery tool) fits: those tools embed MuPDF for
rasterization but do their own page compositing.

## The exact model (all empirical, byte-verified)

Let `g` = the byte pymupdf 1.27 (or mutool ≥1.14) renders for a glyph alone
on white at 12pt/96dpi (identical placement, ¼-px pen lattice — the lattice
is MuPDF's glyph-cache subpixel quantization, which is why it shows in the
page).

1. **Single glyph on white**: page byte = `R(g)` where
   `R: g -> g   (g <= 126 or g == 255);  g -> g+1  (128 <= g <= 254)`.
   (Single-glyph law bytes never hit 127.) Proven 0/110 on the 'T' probe
   window and byte-exact sliding matches for e o c s g at all 4 phases
   (512 exact window hits on page 1).
2. **Overlapping glyphs** (kern junctions: t-h, r-r, f-l, f-i…): glyph RAW
   bytes (`rb = g`, i.e. linear byte minus its R-shift) composite
   multiplicatively in 255-space with floor, and the page byte adds +1 per
   contributing light glyph:
   `page = floor(rb1 * rb2 / 255) + [glyph1 light] + [glyph2 light]`.
   Fitted with **922/925 exact** on every double-overlap pixel of the clean
   report.pdf lines; the 3 misses are all our-side-1-darker and best read as
   per-pixel raster variance, absorbed by a one-sided composite-only slack
   (see below). Every rival law (floor/round/ceil of the linear product,
   MuPDF's `(dst*(256-e))>>8`, alpha-channel flattens) loses by 25x or more
   on the same corpus.

### "Light glyph" threshold — exact semantics (pinning the 128-vs-129 puzzle)

"Light" is defined in **raw MuPDF byte space**: raw single-on-white byte in
**[128, 254]** (raw 127 unreachable on white, raw 255 = no ink). The
producer +1s exactly those pixels, so in **linear set bytes** the same set
is **gb in [129, 255]**, where gb = raw+1 — and gb = 255 (raw 254, cov
~1/255) is erased to white and drops out of the ink mask entirely. Hence
the reader's `gb >= 129 && gb !== 255` and the prose "128..254" describe
the SAME set, one representation apart; `gb - 1 = raw` is valid exactly on
[129, 254]. fontgen's remap `g[(g>=128)&(g!=255)] += 1` is the raw-space
statement of the identical map.

### Composite ±1 slack (deliberate, one-sided, documented)

At double-ink pixels only (`cv != 255`) the reader accepts page = pred − 1
in addition to page = pred. Rationale: 3/925 fitted junction pixels sit 1
below the law, always this sign; single-glyph pixels stay strictly
byte-exact so glyph identity is never diluted.

So: `fonts/*lin_*.npz` glyph sets = pymupdf render + `R` (fontgen.py
`--linear`); the reader composites with the law in (2) + the slack above.

## What was ruled out (measured, don't redo)

- mutool 1.2/1.3: grid-fit era geometry, way off.
- mutool 1.4–1.11: identical to each other; coverage differs from the page
  by ±2 at corners (+7 outlier) — worse than modern.
- mutool 1.12: differs from 1.14+ (2803 px on the stub) and is worse vs page.
- mutool/pymupdf 1.14, 1.15, 1.16, 1.17, 1.18, 1.27: bit-identical to each
  other on the stub; their coverage is the producer's.
- FreeType DLLs 2.6.5 / 2.7.1 / 2.8.1 / 2.13.2 via freetype-py (ctypes CDLL
  hijack, tools/ft_probe.py): all bit-identical for these glyphs — the
  "producer FT must be older than 2.9" theory was wrong.
- Pure `255-cov` linear blend, mupdf alpha channel (`254-alpha`), REMAP of
  the law canvas, per-glyph mupdf-law + shift: each fails at some verified
  overlap pixel. Only the model above survives all of them.

## Status of the tol-0 blind read (bench/blind-read.mjs, sets *lin*)

`node blind-read.mjs --pdf ../corpus/report.pdf --all --tol 0 --glyphs
glyphs_tnr8lin16.json,glyphs_timesbdlin16.json,glyphs_timesilin16.json,glyphs_timeslin16.json,glyphs_tnr8lin10.json`

220 lines, 12,751 glyphs, **5 fail events at tol 0** (was: needed tol 10
with ~10 clusters; old sets at tol 0 gave 136+). All fi/fl/ffi words,
superscript ordinals ("71st"), hex serials etc. read byte-exact. The
reader's linear-set blend law + shift canvas + slack lives in
bench/blind-read.mjs (grep `lin`).

### Remaining 5 fail events — root-caused, all reader object-handling

> **FIXED 2026-07-12 (items 1+2)** in blind-read.mjs + blindocr.js
> `detectObjects`: box extents are now per-segment MODE-voted from per-row
> runs (bridged rows lose the vote; stacked different-width redactions split
> into exact segments), vrules mostly covered by box segments are dropped,
> and the □ fail-absorption no longer counts masked object ink as ink.
> The box lines now read "…including ███ and GHISLAINE MAXWELL." and
> "…concerning the identity…" at tol 0. Item 3 still stands.

1. p6 base 695 & 748 ("… GHISLAINE MAXWELL ███"): a mid-line REDACTION BOX
   is detected fine, but its AA padding over-masks ~9 columns to its right,
   eating the first word after the box. Behind it the page CONTINUES with
   caps — "and GHISLAINE MAXWELL." (the earlier "SARAH KELLEN" guess was
   from the docx revision, not the pixels).
   Root cause: per-row dark runs bridge from the box through the next word
   across ≤1px AA gaps, stretching the box bbox (x1 367 vs solid edge 357).
2. p6 base 676 ("concernin■identity", truly "concerning the identity"):
   the 'g' stem column merges with the box edge below it into a
   false-positive vrule object (x 324-325, y 669-709) whose mask eats the
   g — and the □ absorption then ran under the solid box rows and ate "the".
3. p5 base 460 & p6 base 313 ("…b4f■e4…" hex ids): one f-b junction pixel
   each, off by 5 — beyond the ±1 slack; per-pixel variance (reads at
   --tol 1 via dust absorption). Could be pinned by testing pymupdf
   1.19–1.26 wheels on that exact pair, or just accepted as two known
   pixels.

Also: --verify (render_hypotheses.py) still renders raw law bytes — needs
R + the overlap law before per-line re-render certificates work for report.

## Ground-truth caveat (unchanged)

report.docx is a DIFFERENT REVISION with its own typos. The pixel reading is
authoritative; use the docx only as a soft cross-check. (Confirmed again:
the "fifth floor" docx guess was actually "first floor" on the page.)

## Reproduction pointers

- Cache decode + probe verify + candidate diffing: `tools/hunt_renderer.py`
  (`python tools/hunt_renderer.py verify`).
- FT DLL probes: `tools/ft_probe.py <freetype.dll>`.
- Glyph set generation: `python tools/fontgen.py <font.ttf> <size_px>
  <out.npz> --linear`, export via `tools/export_glyphs.py <npz> <bench json>`.
- Raster cache (`char_training/bench/raster-cache/fe9580296d53ee66/`) is the
  only byte-truth; never re-rasterize report.pdf.
- **2026-07-12:** corpus/report.pdf was later replaced by a SINGLE page (the
  old p6, cache `a42927acc2aaca91`) and then removed from corpus/ entirely —
  regressions run via `blind-read.mjs --raster raster-cache/a42927acc2aaca91/page-0001.gray.gz`.

# notes/ — the debugging entry point

Start here. This file is the map: the system in ten lines, the proven physics,
the regression gate, and what every other document is (and whether it is still
current). Last full revision: 2026-07-12.

## The system in ten lines

The project reads MuPDF-rendered document rasters **byte-exactly** — accuracy
is *certified per line*, not sampled. The current reader is the **blind
reader** (`bench/blind-read.mjs`, browser port `blindocr.js` = the app's
"Auto OCR"): it assumes NO layout constants, measures bands/baselines/fonts
from the pixels, and accepts a glyph only if it explains the page bytes
through the renderer's proven blend law. Unknown ink becomes an honest `□`
with exact coordinates — errors cannot pass silently. Glyph rasters come from
fontgen (zero corpus pixels). The older grid/template path (templates/ dict +
`reader.js`, see `../DOCUMENTATION.md`) still works and is regression-kept,
but new work happens on the blind reader.

## Proven physics (byte-exact facts — do not re-derive)

| Fact | Where proven |
|---|---|
| Corpus pages = MuPDF, Times NR 12pt @ 96dpi gray (16px em), 816×1056; gray = 255−coverage, no gamma | [RENDERER_IDENTIFIED.md](RENDERER_IDENTIFIED.md) |
| Pen x snaps to ¼ px (MuPDF glyph cache; boundaries .125/.375/.625/.875); y snaps to ½ px | [RENDERER_IDENTIFIED.md](RENDERER_IDENTIFIED.md) |
| Glyph overlap compositing: `dst = (dst·(256−e))>>8`, `e = cov + (cov>>7)` | [SYNTHETIC_DICT.md](SYNTHETIC_DICT.md) |
| Layout pens sit δ ∈ [0, 1/32 px] below ideal measureText positions; x0 = 45.0000 exactly; advances dyadic (1/128 px) | [MISSING_LETTER.md](MISSING_LETTER.md) |
| report.pdf-family producer: MuPDF glyphs + own integer alpha compositor (`page = g+1` for raw g∈128..254; overlaps multiply in 255-space with floor) → the `*lin*` glyph sets | [REPORT_RENDERER_HUNT.md](REPORT_RENDERER_HUNT.md) |
| v4.pdf-family producer: MuPDF glyphs + **palette quantization** (page image is /Indexed; page byte = nearest available gray, ties darker) → `--quant`; email.pdf P1 is the same family | [BLIND_READER.md](BLIND_READER.md) 07-12 PM + late |
| Color (mode-2) pages: plain black ink has R+G+B ≡ 0 (mod 3); non-neutral-connected ink components are flooded away before reading (app: exact per-pixel R≠G≠B via canvas RGBA) | [BLIND_READER.md](BLIND_READER.md) 07-12 PM |
| Light rules (blockquote quote bars, separators): contiguous near-constant light run ≥40 px (min ≥160, max−min ≤8) is an object — text can never fake it | [BLIND_READER.md](BLIND_READER.md) 07-12 late |

Rule of thumb: a new document reading "almost but ±1" against a proven
rasterizer = **check for a palette before hunting renderers**.

## The regression gate (run after any reader/template change)

```bash
cd bench
node blind-read.mjs --pdf ../corpus/v3.pdf  --all --truth ../corpus/v3.txt
node blind-read.mjs --pdf ../corpus/big.pdf --all --truth ../corpus/big.txt
node blind-read.mjs --pdf ../corpus/email.pdf --all --truth ../corpus/email.txt --quant
node blind-read.mjs --raster raster-cache/a42927acc2aaca91/page-0001.gray.gz --tol 0 \
  --glyphs glyphs_tnr8lin16.json,glyphs_timesbdlin16.json,glyphs_timesilin16.json,glyphs_timeslin16.json,glyphs_tnr8lin10.json
node test-blind-app.mjs        # the app's Auto OCR path (blindocr.js)
```

Expected (2026-07-12 late): v3 `1785 lines / 122,865 glyphs / 2 □ / 1779 letter-exact`
· big `18,308 / 1,338,823 / 4 □ / 18,271` (P211's clipped base64 "ix" row now
yields its 'i' beside the □) · email `1908 / 113,599 / 0 □ /
1898 letter-exact` (10 diff rows = truth defects + deliberately-blank
hyperlink spans) · report-raster `34 / 2031 / 2 □` ·
app test `v3 P1 40/40 + P2 54/54 byte-clean, email P1 54 byte-clean (48/54
letter-exact vs defect-carrying truth) + P2 54/54 letter-exact`.
v4 RETIRED from the gate 2026-07-12 (raster cache removed at user request;
the PDF had already left corpus/) — last certified numbers: `30 lines / 884
glyphs / 1 □` at tol 0 `--quant --union` (the struck-line fragment;
blue/struck spans deliberately blank).
The □s and diff rows are all root-caused (see BLIND_READER.md); a CHANGE in
any number is the signal, not the absolute. report.pdf exists only as its
raster cache (the PDF left corpus/); big/v3/v4 PDFs are local-only
(.gitignored), caches under `bench/raster-cache/`.
`--verify` per-line MuPDF re-render certificates need
`..\ocr\tools\render_hypotheses.py` (Desktop/ocr workspace).
Legacy template-path gate: `dump-ocr.mjs` byte-compare (see bench/README.md).

## Document map

**Living / current**
- [BLIND_READER.md](BLIND_READER.md) — the blind reader: design, chronological
  results, capabilities (objects/boxes, linear compositor, tol mode, mode-2
  color, --union, strike suppression, --quant), known limits. **The** doc for
  reader debugging; newest sections at the bottom.
- [RENDERER_IDENTIFIED.md](RENDERER_IDENTIFIED.md) — how the corpus renderer
  was pinned to MuPDF; corrections to earlier hypotheses. Physics still holds.
- [REPORT_RENDERER_HUNT.md](REPORT_RENDERER_HUNT.md) — the eDiscovery
  producer's linear law (SOLVED); its items 1–2 (box over-masking, false
  vrule) were fixed 07-12, item 3 (two ±5 junction pixels, read at --tol 1)
  stands.
- [MISSING_LETTER.md](MISSING_LETTER.md) — information-limit study: what a
  ¼-px bucket stream knows about an erased letter (L1 4.6% / L2 53% / L3
  bounded by the advance lattice). Also where δ and x0 were calibrated.
- [SYNTHETIC_DICT.md](SYNTHETIC_DICT.md) — zero-corpus-pixel template
  dictionary recipe + the snap-boundary problem. Feeds the legacy path; the
  fontgen glyph sets the blind reader uses come from the same identification.

**Historical / superseded (kept for provenance)**
- [MISSING_LETTER_PROMPT.md](MISSING_LETTER_PROMPT.md) — the session prompt
  that produced MISSING_LETTER.md (completed 2026-07-09).
- [EMAIL_VRULE_PROMPT.md](EMAIL_VRULE_PROMPT.md) — the session prompt for
  email.pdf (completed 2026-07-12: 0 □ in bench AND app; light rules, palette
  P1, detached-ink and baseline-below-band fixes — BLIND_READER.md bottom).
- [SPACE_REVIEW.md](SPACE_REVIEW.md) — 28 disputed space-placement rows from
  the grid-path era; the blind reader's measured spaces settled these in the
  pixels' favor (BLIND_READER.md 07-10). Reference only.

**Elsewhere**
- `../README.md` — repo intro + quick start (app is Auto-OCR-first).
- `../DOCUMENTATION.md` — the LEGACY grid/template app path (Config grid,
  templates/ dict, matchAt/reader.js) — still accurate for that path.
- `../bench/README.md` — every bench tool: blind reader + recreate certificate
  up top; then the grid-path tools (dump-ocr, synth-templates, tracing,
  pruning, metrics).
- `..\ocr` workspace — renderer-hunt tooling (fontgen.py, export_glyphs.py,
  render_hypotheses.py, hunt_renderer.py); see its NOTES.md.

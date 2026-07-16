# docs/ — the debugging entry point

Start here. This file is the map: the system in ten lines, the proven physics,
the regression gate, and what every other document is (and whether it is still
current). Last full revision: 2026-07-12.

## The system in ten lines

The project reads MuPDF-rendered document rasters **byte-exactly** — accuracy
is *certified per line*, not sampled. The current reader is the **blind
reader** (`tools/blind-read.mjs`, browser port `blindocr.js` = the app's
"Auto OCR"): it assumes NO layout constants, measures bands/baselines/fonts
from the pixels, and accepts a glyph only if it explains the page bytes
through the renderer's proven blend law. Unknown ink becomes an honest `□`
with exact coordinates — errors cannot pass silently. Glyph rasters come from
fontgen (zero corpus pixels). The older grid/template path (templates/ dict +
reader.js) was REMOVED 2026-07-13 — the blind reader had strictly superseded
it (BLIND_READER.md bottom sections record the removal and what replaced what).

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
| courier_1/2.pdf body = Courier New **13px em** (advance 7.8 px, row pitch 15), same corpus MuPDF render family (Times header reads byte-exact at tol 0) | [BLIND_READER.md](BLIND_READER.md) 07-12 courier |

Rule of thumb: a new document reading "almost but ±1" against a proven
rasterizer = **check for a palette before hunting renderers**.

## The regression gate (run after any reader change)

```bash
cd tools
node blind-read.mjs --pdf ../corpus/v3.pdf  --all --truth ../corpus/v3.txt
node blind-read.mjs --pdf ../corpus/big.pdf --all --truth ../corpus/big.txt
node blind-read.mjs --pdf ../corpus/email.pdf --all --truth ../corpus/email.txt --quant
node blind-read.mjs --raster raster-cache/a42927acc2aaca91/page-0001.gray.gz --tol 0 \
  --glyphs glyphs_tnr8lin16.json,glyphs_timesbdlin16.json,glyphs_timesilin16.json,glyphs_timeslin16.json,glyphs_tnr8lin10.json
node blind-read.mjs --pdf ../corpus/courier_1.pdf --all \
  --glyphs glyphs_times16.json+glyphs_timesbd16.json+glyphs_timesi16.json,glyphs_cour13.json
node blind-read.mjs --pdf ../corpus/courier_2.pdf --all \
  --glyphs glyphs_times16.json+glyphs_timesbd16.json+glyphs_timesi16.json,glyphs_cour13.json
node test-blind-app.mjs        # the app's Auto OCR path (blindocr.js)
node export-glyphs.mjs --check # every committed glyph set ⇔ its committed .npz
node sync-recto.mjs --check    # Recto's embedded engine copy still current?
node test-recto-app.mjs        # after a sync: the engine inside Recto's ocr_tool plugin
```

Expected (2026-07-14 PM — redaction-aware masking, box fragments, mode-3
rasters; see BLIND_READER.md bottom. "box fragments" = unexplained ink
confined to a box's halo, reported separately because it is the box's own
REDACTED content, not unread text):
v3 `1785 lines / 122,883 glyphs / 0 □ / 1 frag / 1779 letter-exact` (6 diff
rows incl. "Karen cell:" — the reader reads a real colon the truth file
lacks) · big `18,307 / 1,338,832 / 0 □ / 2 frags / 18,273` (34 diff rows;
line count dropped by one when a pre-existing phantom dot-band line was
demoted) · email `1908 / 113,599 / 0 □ / 1898 letter-exact` (10 diff rows =
truth defects + deliberately-blank hyperlink spans) · report-raster `34 /
2033 / 2 □ / 1 frag` (tol-1 hex junction + small footer digits; frag = a
redacted name's first-letter AA at the box's left edge) · courier_1 `1552 /
114,817 / 0 □` · courier_2 `4899 / 374,462 / 0 □` (the From:-line '>'
beside the redaction box READS; truth files regenerated 2026-07-14) · app
test `all pages byte-clean; v3 P1 38 in-truth ("Karen cell:" + pre-existing
AmEx row), email P1 48/54 letter-exact vs defect-carrying truth, courier_1
P1 57/57 letter-exact`.
NEW/ certified (truths beside the PDFs; all round-trip 0-diff): courier/
EFTA00434905 `305/22,796/0□`, courier/EFTA00382108 `1545/114,273/0□`,
times/efta00037366 `17/544/0□`, times/EFTA00010016 `17/649/0□/17 frags`,
times/EFTA00161526 `12/534/0□` (arial16 body lines), times/EFTA00009888
`6/112/0□`, times/EFTA00756043 `60/1958/0□/11 frags` at **--tol 1** (the
producer JPEG-compresses its pages — ±1 channel jitter; same tol-1 posture
as the report-raster junction pixels). Speed after the accent charset grew
the candidate sets: big.pdf ~0.28 s/page (95 s full doc).
courier_1/2 truth files (`corpus/courier_*.txt`) are the blind reader's own
certified transcriptions (no external truth exists); `glyphs_cour13.json`
derives from the committed `assets/fonts/cour_13.npz` via
`tools/export-glyphs.mjs` (rasters were generated by the retired Python
fontgen — tag `python-era`). In `--glyphs`, `+` joins sets into ONE union pool (mixed fonts on
one line), `,` separates per-band-pick sets — pool only what really mixes:
a global pool lets a foreign font byte-match glyph fragments (a times sliver
ate courier 'e's).
v4 RETIRED from the gate 2026-07-12 (raster cache removed at user request;
the PDF had already left corpus/) — last certified numbers: `30 lines / 884
glyphs / 1 □` at tol 0 `--quant --union` (the struck-line fragment;
blue/struck spans deliberately blank).
The □s and diff rows are all root-caused (see BLIND_READER.md); a CHANGE in
any number is the signal, not the absolute. Speed (2026-07-16): ~0.17 s/page —
big.pdf full doc 62 s, v3 4.5 s (anchor-column candidate index on top of the
07-13 work; BLIND_READER.md bottom).
Corpus PDFs are committed (2026-07-15); raster caches are populated once per
document with `tools/rasterize.mjs`. report.pdf exists only as its raster
cache — the one cache directory that is COMMITTED
(`tools/raster-cache/a42927acc2aaca91/`), because its source PDF is gone and
the cache is the document.
(The old `--verify` MuPDF re-render certificate retired with the Python
tooling 2026-07-15 — tag `python-era`; the reader's own gray-law byte
certification, which the whole gate runs on, is Node-only and unaffected.)

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
  dictionary recipe + the snap-boundary problem. Fed the (removed) legacy
  path; the fontgen glyph sets the blind reader uses come from the same
  identification.

**Historical / superseded (kept for provenance)**
- [RENDERER_HUNT_NOTES.md](RENDERER_HUNT_NOTES.md) — the living notes of the
  Desktop/ocr forensics workspace (2026-07-07 → 07-12): one-letter/one-template
  proofs, renderer identification, fontgen pipeline history. The workspace's
  live core now lives in `tools/fontgen/` + `assets/fonts/`; the template-era
  remainder is archived as a zip.
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
- `../Recto` — the Recto PDF editor (Django) embeds the engine as its
  `ocr_tool` plugin: verbatim copies of `src/{core,ocr,blindocr}.js` +
  glyph sets, pushed by `tools/sync-recto.mjs` (`npm run sync:recto`),
  smoke-tested end-to-end by `tools/test-recto-app.mjs` (`npm run
  recto-test`). THIS repo is the only place the engine is edited; the
  Recto-side adapter and plugin docs live in `Recto/guide/plugins/ocr-tool/`.
- `../tools/README.md` — every bench tool: blind reader, rasterizer, glyph
  exporter, static server, app test. (The legacy grid-path tools and their
  DOCUMENTATION.md were removed 2026-07-13 with the rest of that path; the
  Python half — fontgen generator, MuPDF re-render worker, launch.py — was
  retired 2026-07-15, tag `python-era`.)
- `assets/fonts/*.npz` — the committed glyph rasters every set derives from
  (renderer-hunt provenance in
  [RENDERER_HUNT_NOTES.md](RENDERER_HUNT_NOTES.md)). The rest of the old
  Desktop/ocr workspace is archived as a zip (deleted 2026-07-13).
- `../char_training-main/` — the ORIGINAL grid-NCC project this repo grew out
  of (courier base64 docs, 7×11 px templates, hardcoded grid: xStart 60,
  pitch 7.8026, rowHeight 15). Read `char_training-main/char_training/`
  (readable version); the top-level `batch_ocr.html` has all templates baked
  in as base64 and is enormous. Reference only — the blind reader now reads
  those documents byte-exactly (courier gate lines above).

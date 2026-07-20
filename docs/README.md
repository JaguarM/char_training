# docs/ — the debugging entry point

Start here. This file is the map: the system in ten lines, the proven physics,
the regression gate, and what every other document is (and whether it is still
current). Last full revision: 2026-07-20.

## The system in ten lines

The project reads MuPDF-rendered document rasters **byte-exactly** — accuracy
is *certified per line*, not sampled. The current reader is the **blind
reader**: one shared matcher core, `src/ocr-engine.js` (ink bands, baseline
pinning, the composite-aware scan, object detection), consumed by both the
Node CLI (`tools/blind-read.mjs`) and the browser/Recto app (`blindocr.js` =
the app's "Auto OCR"). It assumes NO layout constants, measures bands/baselines/fonts
from the pixels, and accepts a glyph only if it explains the page bytes
through the renderer's proven blend law. Unknown ink becomes an honest `□`
with exact coordinates — errors cannot pass silently. Glyph rasters come from
fontgen (zero corpus pixels). The older grid/template path (templates/ dict +
reader.js) was REMOVED 2026-07-13 — the blind reader had strictly superseded
it (BLIND_READER.md bottom sections record the removal and what replaced what).

## Proven physics (byte-exact facts — do not re-derive)

**The consolidated rendering reference is [../ocr/RENDERING.md](../ocr/RENDERING.md)**
— every proven glyph pipeline, post-law, pen lattice, and family config in
one place (machine-readable mirror: `ocr/families.mjs`). The table below
maps each fact to the document that proves it.

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
| NEW/courier 7516xx/7543xx/7569xx block (11 docs) = MuPDF-lineage renderer with its builtin Courier = **URW Nimbus Mono CFF @ em64 791** (12.359375 px), ¼-px-x/int-y pens, single draw, standard blend → set `nimbus791`; pitch < maxAsc+maxDesc ⇒ stacked-band split/retro machinery. (The producing *program* — "Oracle Outside In" per font resource names — is an unverified guess; only the render law is proven) | `ocr/FINDINGS.md` + [BLIND_READER.md](BLIND_READER.md) 07-19 eve |
| NEW/calibri family = **Calibri VERSION 1.02** (installed 6.2x has different drawings) through the **"mid" law**: byte = t+(t>>7)−((255−t)>>7), t=255−cov (127/128 spectral hole = fingerprint); colored/gray runs srcover byte = 255−round(cov·(255−C)/255); per-(doc,page) ±1-2 wobble ⇒ harvested sets at --tol 2 + union ladder pass | `ocr/FINDINGS-calibri.md` |
| EFTA00039208 serif family = builtin URW NimbusRoman/NimbusSans (em64 1024/983/1194/1536) + embedded real-TNR subset, then **linear law on [128,254]** (+1; raw 254 → 255, the pixel vanishes) then a **per-page /Indexed palette** (RGB-nearest over the full palette, ties darker) — read with `blind-read --palette` (true per-page LUT from the PDF) at tol 0; gate doc `nimbusrom` | `ocr/FINDINGS-nimbusrom.md` |
| EFTA01150379 ("times" 2427-pager) hunt CLOSED — page images stretched+rerendered, face was Cambria not Times: byte-identification unwinnable by construction. Check stretch/resample signatures + verify face from glyph shapes BEFORE any engine hunt | `ocr/RENDERING.md` (closed-families section) |

Rule of thumb: a new document reading "almost but ±1" against a proven
rasterizer = **check for a palette before hunting renderers**.

## The regression gate (run after any reader change)

```bash
npm test                       # FIRST: fast unit suite (~30 ms) — engine primitives
                               # (scanLine, detectObjects, readPage, quant/TOL/composite
                               # physics) on synthetic pages; test/engine.test.js
npm run gate                   # 7 reader docs, byte-compared vs tools/gate-ref/
cd tools
node test-blind-app.mjs        # the app's Auto OCR path (blindocr.js)
node export-glyphs.mjs --check # committed glyphs.bin ⇔ the committed .npz rasters
node sync-recto.mjs --check    # Recto's embedded engine copy still current?
node test-recto-app.mjs        # after a sync: the engine inside Recto's ocr_tool plugin
```

**The expected output IS `tools/gate-ref/`** — committed transcripts +
count summaries per gate doc (v3, big, email --quant, report-raster tol 0,
courier_1/2, nimbusrom `223/13,034/38□` — the 38 are the unsolved red
footer legend + P1 seal graphic, ocr/FINDINGS-nimbusrom.md); the gate
byte-compares against them, so a CHANGE is the
signal, not the absolute. Re-record only after an INTENDED output change:
`node tools/gate.mjs --out gate-ref --ref none` (each doc's exact reader
command line lives in gate.mjs DOCS). Everything that still differs from
truth is root-caused in BLIND_READER.md: v3's 6 diff rows and big's 34 are
truth-file defects ("Karen cell:" reads a real colon the truth lacks),
email's 10 are defects + deliberately-blank hyperlink spans, report's 2 □
are the tol-1 junction + small footer digits. "Box fragments" = unexplained
ink confined to a box's halo — the box's own REDACTED content, not unread
text. App test expects: all pages byte-clean; v3 P1 38 in-truth, email P1
48/54 letter-exact vs defect-carrying truth, courier_1 P1 57/57.

NEW/ certified (truths beside the PDFs, all round-trip 0-diff; current
folder layout + per-doc status: `NEW/MANIFEST.md` — NEW/ is untracked and
temporary, folders come and go):
courier-ez/EFTA00434905 `305/22,796/0□`, courier-ez/EFTA00382108
`1545/114,273/0□`, times/efta00037366 `17/544/0□`, times/EFTA00010016
`17/649/0□/17 frags`, times/EFTA00161526 `12/534/0□`, times/EFTA00009888
`6/112/0□`, times/EFTA00756043 `60/1958/0□/11 frags` at **--tol 1** (its
producer JPEG-compresses pages — ±1 channel jitter). 2026-07-19 eve: the
whole courier 7516xx/7543xx/7569xx block — **all 11 docs 0 □** with
`--glyphs nimbus791` (~4,960 lines / ~353k glyphs, ~1 s/doc; per-doc table
in NEW/MANIFEST.md). 2026-07-19 late: NEW/calibri both docs 0 □ (tol 2 +
union ladder pass, app/Recto parity verified — `ocr/FINDINGS-calibri.md`).

Facts that live nowhere else: courier_1/2 truths are the reader's own
certified transcriptions (no external truth exists). In `--glyphs`, `+`
joins sets into ONE union pool (fonts that mix on a line), `,` separates
per-band-pick sets — pool only what really mixes, or a foreign font
byte-matches glyph fragments (a times sliver ate courier 'e's). v4 retired
from the gate 2026-07-12 (last: `30/884/1□` tol 0 `--quant --union`).
Corpus PDFs are committed; raster caches populate once per document via
`tools/rasterize.mjs`. Whole folders (thousands of PDFs, arbitrary
location) go through `npm run batch -- --dir <folder>`
(tools/batch-read.mjs): one shared Chrome session rasterizes, page-1
probes pick the best proven family rung, the winner full-reads, and
`<out>/manifest.jsonl` records per-doc status (exact / partial / no-read)
resumably — 'partial'/'no-read' docs are the queue for new family hunts
in ocr/. report.pdf exists ONLY as its committed cache
(`tools/raster-cache/a42927acc2aaca91/`), the document itself. Speed
(2026-07-16 PM): ~0.09 s/page — big.pdf ~31.5 s, v3 ~3.3 s (advance
chaining + anchor index + cross-page hints; BLIND_READER.md bottom, incl.
the --json label-drift note).

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

**Historical / superseded — in [archive/](archive/) (kept for provenance)**
- [archive/RENDERER_HUNT_NOTES.md](archive/RENDERER_HUNT_NOTES.md) — the living notes of the
  Desktop/ocr forensics workspace (2026-07-07 → 07-12): one-letter/one-template
  proofs, renderer identification, fontgen pipeline history. The workspace's
  live core now lives in `tools/fontgen/` + `assets/fonts/`; the template-era
  remainder is archived as a zip.
- [archive/MISSING_LETTER_PROMPT.md](archive/MISSING_LETTER_PROMPT.md) — the session prompt
  that produced MISSING_LETTER.md (completed 2026-07-09).
- [archive/EMAIL_VRULE_PROMPT.md](archive/EMAIL_VRULE_PROMPT.md) — the session prompt for
  email.pdf (completed 2026-07-12: 0 □ in bench AND app; light rules, palette
  P1, detached-ink and baseline-below-band fixes — BLIND_READER.md bottom).
- [archive/SPACE_REVIEW.md](archive/SPACE_REVIEW.md) — 28 disputed space-placement rows from
  the grid-path era; the blind reader's measured spaces settled these in the
  pixels' favor (BLIND_READER.md 07-10). Reference only.

**Elsewhere**
- `../README.md` — repo intro + quick start (app is Auto-OCR-first).
- `../ocr/` — the renderer-identification LAB: for any mystery raster
  document, `ingest → harvest → identify` fingerprints the pages and tries
  every proven producer family (`ocr/families.mjs`, the machine-readable
  registry) automatically; its README is the runbook, incl. the
  found-config → glyph-set integration recipe. **`ocr/RENDERING.md` = the
  consolidated how-fonts-are-rendered reference** (all pipelines, post-laws,
  family configs, diagnosis cheat-sheet). Hunt records: `ocr/FINDINGS.md`
  (courier/Nimbus), `ocr/FINDINGS-calibri.md` (Calibri 1.02 / mid law).
  (The 2026-07-17 OUTSIDE_IN_ARIAL.md was lost, and its surviving claims
  were wrong — see RENDERING.md's open-families note on the 816×1073 trio.)
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
  [archive/RENDERER_HUNT_NOTES.md](archive/RENDERER_HUNT_NOTES.md)). The rest of the old
  Desktop/ocr workspace is archived as a zip (deleted 2026-07-13).
- `../char_training-main/` — the ORIGINAL grid-NCC project this repo grew out
  of (courier base64 docs, 7×11 px templates, hardcoded grid: xStart 60,
  pitch 7.8026, rowHeight 15). Read `char_training-main/char_training/`
  (readable version); the top-level `batch_ocr.html` has all templates baked
  in as base64 and is enormous. Reference only — the blind reader now reads
  those documents byte-exactly (courier gate lines above).

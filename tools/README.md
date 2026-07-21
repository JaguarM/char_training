# tools/ — headless tooling

The blind reader family — the whole system since the legacy grid/template
tools were removed (2026-07-13; history in
[../docs/BLIND_READER.md](../docs/BLIND_READER.md)). The map of proven
physics and the full regression gate: [../docs/README.md](../docs/README.md).

---

# Blind reader — `blind-read.mjs` (the current OCR)

Self-calibrating byte-exact reader with **no layout constants**: ink bands,
per-band baseline/y-phase/font pinning, then a left→right composite-aware
scan that accepts a glyph only if it explains the page bytes through the
producer's blend law (advance-chained: each accept predicts the next pen on
the ¼-px lattice and probes it first; the anchor-column scan is the
fallback — BLIND_READER.md 07-16 PM). Spaces are measured (pen gap vs advance, width
self-calibrated); redaction boxes / rules / vrules are detected, masked, and
reported as objects; strike-through spans are voided; unknown ink = honest
`□` with exact coordinates. Glyph sets come out of the one committed bundle
`assets/glyphs/glyphs.bin` (fontgen rasters, zero corpus pixels; `*lin*`
sets carry the eDiscovery producer's linear compositor).

The scanning physics above live in ONE place, `../src/ocr-engine.js` — a
DOM-free module this CLI and the browser app (`../src/blindocr.js`) both
import. `blind-read.mjs` itself only owns what's CLI-specific: GRY1 raster
loading, the glyph-bundle Buffer reader, arg parsing, and truth-diff/text/JSON
output. Edit the scan itself in `ocr-engine.js`, not in either caller —
that's the whole point of the split (2026-07-16: the two callers used to
carry independent copies of this code).

```
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt
node blind-read.mjs --pdf ../corpus/email.pdf --all --quant \
  --glyphs times16,timesbd16,timesi16
node blind-read.mjs --raster raster-cache/<key>/page-0001.gray.gz --glyphs …
```

| Flag | Meaning |
|---|---|
| `--pdf` / `--raster` | document (pages come from `raster-cache/`; populate it once with `rasterize.mjs`) or a single cached page |
| `--page <n>` / `--all` | page selection |
| `--glyphs a,b` | set names from the bundle (legacy `glyphs_a.json` spellings still accepted); the per-band auto-pick chooses font AND compositor. `+` joins sets into ONE union pool (`a+b,c` = [a∪b, c]) — pool only fonts that mix within a line; a global pool lets a foreign font byte-match glyph fragments and steal pixels |
| `--union` | merge ALL sets into one candidate pool so a single line may mix fonts (bold labels + regular values); opt-in, superseded by `+` groups for multi-size documents |
| `--tol N` | per-pixel tolerance for near-identical rasterizers (0 = byte-exact; keep 0 unless a producer is unidentified) |
| `--quant` | palette-quantized producers (v4-family): snap every prediction to the page's available gray levels |
| `--truth <txt>` | per-row letters/spaces comparison |
| `--out` / `--json` | clean text / structured output (baselines, fonts, per-glyph ¼-px pens, objects, struck spans) |

Mode-2 (color) pages: neutral ink (R=G=B) is read byte-exactly via sum/3;
ink components connected to non-neutral pixels (hyperlink blue) are flooded
away before reading. Debug envs: `BR_DEBUG=1` (fail pixels), `BR_LINE=<baseline>`
(accept trace), `BR_PIX=<col>` (per-pixel rejection detail).

# App Auto-OCR test — `test-blind-app.mjs`

Headless test of the browser port (`blindocr.js` + `CanvasViewer.blindOcrPage`
/ `blindOcrDocument`) through the real `training.html`: v3 P1+P2, email P1+P2
(color + palette), courier_1 P1 (mixed sizes) vs truth, plus the
document-level API. Run after touching `blindocr.js` or `training.js` — the
port carries the full bench feature set (union pools, color, strike, quant).

# Erased-letter information limit — (tool retired 2026-07-21)

The research behind [../docs/MISSING_LETTER.md](../docs/MISSING_LETTER.md)
was completed 2026-07-09; its tool, `guess-letter.mjs`, was removed from the
tree 2026-07-21 (the findings — L1 4.6% / L2 53% / L3 advance-lattice-bound,
plus the δ/x0 calibration — live in the doc). Resurrect from git history if
the experiment ever needs re-running.

# Static server — `serve.mjs`

Zero-dependency HTTP server behind `npm run serve`: serves the repo root
(app, glyph sets, raster caches, corpus), redirects `/` to
`src/training.html`, picks a free port if the preferred one is taken.
`--port N`, `--no-browser` (used headless by `rasterize.mjs` and
`test-blind-app.mjs`).

# Regression gate runner — `gate.mjs`

`npm run gate` — runs every gate document (docs/README.md "The regression
gate") through the reader and byte-compares transcript + count summary per
doc against the COMMITTED reference `tools/gate-ref/` (the expected numbers
ARE those files). Re-record only after an intended output change:

```
npm run gate                            # certify vs tools/gate-ref
node gate.mjs --out gate-ref --ref none # re-record the reference
```

# Glyph bundle build — `export-glyphs.mjs`

Builds `assets/glyphs/glyphs.bin` — THE glyph dictionary, every set in one
committed binary file — from the committed fontgen rasters
(`assets/fonts/*.npz`, zero corpus pixels). Per raster it stores the raw
MuPDF gray window AND the true rasterizer alpha derived through the set's
compositor law (standard blend vs the eDiscovery linear law — each set is
law-tagged; the matcher predicts composites straight from the alpha plane,
BLIND_READER.md 07-16 PM). The explicit name → npz manifest lives at the
top of the file (a new font = one new line); binary layout is documented in
`glyph-bundle.mjs` (the node reader — the browser reader is in
`blindocr.js`).

```
node export-glyphs.mjs              # (re)build glyphs.bin
node export-glyphs.mjs --check      # bundle ⇔ .npz rebuild (npm run glyphs-check)
```

# Glyph raster generator — `fontgen.mjs`

Renders a font file into an `assets/fonts/*.npz` raster set (the exact
layout the retired Python fontgen produced — tag `python-era`) at every
¼-px x-phase, through `ocr/tools/ftclone.mjs`: the certified pure-JS clone
of the mupdf glyph pipeline (FT 26.6 unhinted + ftgrays + FZ_BLEND;
re-certify anytime with `node ocr/tools/ftclone.mjs` — 0 byte diffs vs the
wasm). mupdf itself is used only for char→gid and design-unit advances and
is resolved from `ocr/node_modules` (`cd ocr && npm install` once) — the
main repo stays dependency-free.

```
node tools/fontgen.mjs --font ocr/fonts/NimbusMonoPS-Regular.cff \
     --em64 791 --phases-y 0 --out assets/fonts/nimbus_791.npz
node tools/fontgen.mjs --font path/to/face.ttf --size 16    # em64 = trunc(size·64)
```

`--em64` is the sharp identifier of a render config (sizePx = em64/64);
`--phases-y 0` builds integer-baseline-only sets (the builtin-Courier /
nimbus791 family) and is the only producer-certified mode. The default
`0,0.5` fills the corpus-era 8-phase slot layout but renders TRUE
fractional-y pens — the legacy committed sets' `_1` rasters came through a
y-rounding pipeline instead, so do NOT regenerate a legacy set with this
generator expecting byte-identity; new sets should pass `--phases-y 0`.
`ocr/tools/check-npz.mjs` certifies a generated set against the hunt's
byte-exact page targets (nimbus_791: 113/113). Proven rasters stay
committed in `assets/fonts/` (plus `TimesNewRomanXP.ttf`, the tnr8 source
face). Finding the CONFIG for a new mystery producer in the first place is
`ocr/`'s job — the renderer-identification lab (`ingest → harvest →
identify` tries every proven family in `ocr/families.mjs` automatically;
`ocr/README.md` is the runbook).

# First-look page diagnosis — `inspect-raster.mjs`

Run on a cached page BEFORE the reader when a new document won't read: prints
dims + mode (2 = color source), the gray-level histogram (palette producer?
fractional grays?), and the ink-band list with pitch (bands present but
nothing pins ⇒ wrong font size — compare pitch to the glyph set's em).

```
node inspect-raster.mjs raster-cache/<key>/page-0001.gray.gz
```

# Rasterize a PDF into the cache — `rasterize.mjs`

Populates `raster-cache/<sha16>/page-NNNN.gray.gz` for a PDF, byte-identical
to live in-app extraction (same pdf.js embedded-image extraction, same gray()
reduction). Pages already cached are skipped. Run once per new document; every
other tool then works from the cache without the PDF.

```
node rasterize.mjs --pdf ../corpus/doc.pdf            # all pages
node rasterize.mjs --pdf ../corpus/doc.pdf --page 3   # one page
```

# Recto plugin sync — `sync-recto.mjs`

The engine also runs inside the **Recto PDF editor** (`../Recto`) as its
`ocr_tool` plugin. This repo stays the ONLY place the engine is developed;
Recto receives verbatim copies. After any engine change (and its corpus
gate), push them over:

```
npm run sync:recto                 # src/{core,ocr,blindocr}.js + assets/glyphs/*.json
node sync-recto.mjs --check        # report staleness only (exit 1 if stale)
node sync-recto.mjs --recto <dir>  # non-default Recto location
```

Copies into `Recto/ocr_tool/static/ocr_tool/{engine,glyphs}/` (plus a
`glyphs/index.json` listing and content-hash cache-busters in the plugin's
`tool.py`; `*_OFF.json` sets are skipped). The plugin's Recto-side adapter
(`ocr-tool.js`) is owned by Recto — see `Recto/guide/plugins/ocr-tool/`.

# Recto plugin smoke test — `test-recto-app.mjs`

End-to-end certificate that the SYNCED engine reads inside Recto: boots the
Django app headless, waits for its bundled default document (Times-family
eDiscovery raster), runs the plugin's Auto OCR on P1, and asserts byte-clean
`ocr` boxes rendered into the unified text box system. Run after every sync
and after Recto adapter edits.

```
npm run recto-test                 # or: node test-recto-app.mjs --recto <dir>
```

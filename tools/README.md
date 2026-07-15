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
producer's blend law. Spaces are measured (pen gap vs advance, width
self-calibrated); redaction boxes / rules / vrules are detected, masked, and
reported as objects; strike-through spans are voided; unknown ink = honest
`□` with exact coordinates. Glyph sets are fontgen exports
(`glyphs_*.json`, zero corpus pixels; `*lin*` sets carry the eDiscovery
producer's linear compositor).

```
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt
node blind-read.mjs --pdf ../corpus/v4.pdf --tol 0 --quant --union \
  --glyphs glyphs_times16.json,glyphs_timesbd16.json,glyphs_timesi16.json
node blind-read.mjs --raster raster-cache/<key>/page-0001.gray.gz --glyphs …
```

| Flag | Meaning |
|---|---|
| `--pdf` / `--raster` | document (pages come from `raster-cache/`; populate it once with `rasterize.mjs`) or a single cached page |
| `--page <n>` / `--all` | page selection |
| `--glyphs a.json,b.json` | glyph sets; the per-band auto-pick chooses font AND compositor. `+` joins sets into ONE union pool (`a.json+b.json,c.json` = [a∪b, c]) — pool only fonts that mix within a line; a global pool lets a foreign font byte-match glyph fragments and steal pixels |
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

# Erased-letter information limit — `guess-letter.mjs`

The stress-test tool behind [../docs/MISSING_LETTER.md](../docs/MISSING_LETTER.md)
(erase one glyph, infer it back at evidence levels 1–2; also `--calibrate`
for the δ/x0 physics numbers). The former level 3 — full-line re-render
through real MuPDF — went with the Python tooling; its recorded result
("L3 ≈ L1", advance-lattice bound) stands in the doc.

# Static server — `serve.mjs`

Zero-dependency HTTP server behind `npm run serve`: serves the repo root
(app, glyph sets, raster caches, corpus), redirects `/` to
`src/training.html`, picks a free port if the preferred one is taken.
`--port N`, `--no-browser` (used headless by `rasterize.mjs` and
`test-blind-app.mjs`).

# Glyph-set export — `export-glyphs.mjs`

Exports a fontgen GlyphSet (`assets/fonts/*.npz` — committed, zero corpus
pixels) to the JSON the node/browser readers consume
(`assets/glyphs/glyphs_*.json`, committed):

```
node export-glyphs.mjs ../assets/fonts/cour_13.npz ../assets/glyphs/glyphs_cour13.json
node export-glyphs.mjs --check      # every committed set ⇔ its .npz (npm run glyphs-check)
```

`--check` regenerates every committed set in memory and deep-compares —
proof the JSONs are pure derivations of the .npz rasters (the port itself
was certified identical against the Python exporter's output, 31/31).

The GENERATOR that renders a new font/size into an .npz (PDF text at
size·0.75 pt → MuPDF 96 dpi gray at all 4×2 subpixel phases, exact FreeType
advances) was Python (pymupdf + freetype-py) and was retired 2026-07-15 with
the rest of the Python tooling — tag `python-era` has `fontgen/fontgen.py`
if a NEW font raster set is ever needed; every proven font's rasters are
already committed in `assets/fonts/` (plus `TimesNewRomanXP.ttf`, the tnr8
source face).

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

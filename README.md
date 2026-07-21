# char_training

Byte-exact OCR for MuPDF-rendered document rasters. Accuracy is **certified,
not sampled**: a line is accepted only when its glyphs explain the page's
pixels exactly through the renderer's proven blend law; anything unexplained
is an honest `□` with exact coordinates. **Start with
[docs/README.md](docs/README.md)** — the map of the proven physics, the
regression gate, and all documentation.

The reader is the **blind reader** — no layout constants; bands, baselines,
fonts, spaces and non-text objects (redaction boxes, rules, strike-throughs)
are measured from the pixels. Headless: `tools/blind-read.mjs`; in the app:
the **Auto OCR** button (`blindocr.js`). Handles multiple fonts/compositors
per document, color pages, and palette-quantized producers, at ~0.2 s/page.
The same engine ships inside the Recto PDF editor (`../Recto`) as its
`ocr_tool` plugin — synced verbatim with `npm run sync:recto`, smoke-tested
with `npm run recto-test`; the engine is developed only here.
(The original grid/template path this project grew out of was removed
2026-07-13 — history in [docs/BLIND_READER.md](docs/BLIND_READER.md); the
original standalone tool survives outside the repo in `../char_training-main/`.)

Everything runs on stock **Node** (and a browser) — no npm install, no
Python, no native dependencies. The last Python tooling was retired
2026-07-15 (tag `python-era` marks the final revision that carried it).

## Files

| Path | Purpose |
|---|---|
| `src/training.html` · `training.js` · `training.css` | Browser UI: PDF viewing + Auto OCR overlay + .txt/.json export (viewer-only since 2026-07-21 — the manual editing/extraction era lives in git history) |
| `src/blindocr.js` | Browser port of the blind reader (Auto OCR / Auto OCR All / .txt + .json export) |
| `src/ocr.js` | PageEngine: whole-page grayscale buffer + RGBA access the reader works from |
| `src/core.js` | DOM-free logic (stem↔char maps, geometry, the gray() page law); unit-tested in Node (`npm test`) |
| `tools/serve.mjs` | Local static HTTP server (UI, glyph sets, raster cache, corpus) — `npm run serve` |
| `assets/` | `glyphs/` glyph-set JSONs (committed; app + tools) · `fonts/` the .npz rasters they derive from · `vendor/pdf.min.js` |
| `tools/` | Headless tooling — blind reader, rasterizer, glyph exporter, app test: [tools/README.md](tools/README.md) |
| `test/` | Node unit tests for `core.js` (`npm test`) |
| `corpus/` | Test documents (PDFs committed) + certified transcriptions (`*.txt`) |
| `docs/` | Research record: proven physics, producer laws, session results — index in [docs/README.md](docs/README.md) |

## Quick start

```
npm run serve                   # http://localhost:8765, opens the browser
# or:  node tools/serve.mjs
```

Open a PDF (**Pick PDF**), hit **Auto OCR** (or **Auto OCR All** + **Download
.txt/.json**). Measured bands, per-glyph pens, detected objects and per-line
byte-clean certificates come back without any layout setup. Headless
equivalent:

```
cd tools
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt
```

The headless reader works from per-page raster caches. On a fresh clone,
build a document's cache once (the only step that needs anything beyond bare
Node — puppeteer-core + a local Chrome/Chromium/Edge, auto-detected or
`CHROME=<path>`):

```
cd tools && npm install
node rasterize.mjs --pdf ../corpus/v3.pdf
```

Glyph rasters are committed as ONE bundle (`assets/glyphs/glyphs.bin`, every
set) derived from the committed `assets/fonts/*.npz` fontgen rasters —
rebuild with `node tools/export-glyphs.mjs`; `npm run glyphs-check` proves
the bundle reproducible from the .npz (see `tools/README.md`).

> Glyph-crop saving (double-click a box) uses the File System Access API —
> Chrome/Edge.

## Verification discipline

Any reader change is gated on re-reading the full corpus and comparing against
the certified transcriptions — the exact commands and expected numbers live in
[docs/README.md](docs/README.md).

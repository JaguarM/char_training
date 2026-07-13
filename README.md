# char_training

Byte-exact OCR for MuPDF-rendered document rasters. Accuracy is **certified,
not sampled**: a line is accepted only when its glyphs explain the page's
pixels exactly through the renderer's proven blend law (optionally re-rendered
through real MuPDF as an independent certificate); anything unexplained is an
honest `□` with exact coordinates. **Start with [docs/README.md](docs/README.md)**
— the map of the proven physics, the regression gate, and all documentation.

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

## Files

| Path | Purpose |
|---|---|
| `src/training.html` · `training.js` · `training.css` | Browser UI: PDF viewing, Auto OCR, text editing, glyph extraction |
| `src/blindocr.js` | Browser port of the blind reader (Auto OCR / Auto OCR All / .txt + .json export) |
| `src/ocr.js` | PageEngine: whole-page grayscale buffer + RGBA access the reader works from |
| `src/core.js` | DOM-free logic (stem↔char maps, geometry, the gray() page law); unit-tested in Node (`npm test`) |
| `launch.py` | Local static HTTP server (UI, glyph sets, raster cache, corpus) |
| `assets/` | `glyphs/` fontgen glyph sets (gitignored; shared by app + tools) · `vendor/pdf.min.js` |
| `tools/` | Headless tooling — blind reader, rasterizer, recreation certificate, app test: [tools/README.md](tools/README.md) |
| `test/` | Node unit tests for `core.js` (`npm test`) |
| `corpus/` | Test documents (PDFs .gitignored — local only) + certified transcriptions (`*.txt`) |
| `docs/` | Research record: proven physics, producer laws, session results — index in [docs/README.md](docs/README.md) |

## Quick start

```
python launch.py                # serve on http://localhost:8765 and open the browser
# or:  npm run serve            # same, via the root package.json
```

Open a PDF (**Pick PDF**), hit **Auto OCR** (or **Auto OCR All** + **Download
.txt/.json**). Measured bands, per-glyph pens, detected objects and per-line
byte-clean certificates come back without any layout setup. Headless
equivalent:

```
cd tools
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt
```

Glyph rasters come from fontgen exports (`assets/glyphs/glyphs_*.json`, gitignored) —
regenerate with `tools/fontgen/export_glyphs.py` from the committed
`assets/fonts/*.npz` rasters (see `tools/README.md`).

> Glyph-crop saving (double-click a box) uses the File System Access API —
> Chrome/Edge.

## Verification discipline

Any reader change is gated on re-reading the full corpus and comparing against
the certified transcriptions — the exact commands and expected numbers live in
[docs/README.md](docs/README.md).

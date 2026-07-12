# char_training

Byte-exact OCR for MuPDF-rendered document rasters. Accuracy is **certified,
not sampled**: a line is accepted only when its glyphs explain the page's
pixels exactly through the renderer's proven blend law (optionally re-rendered
through real MuPDF as an independent certificate); anything unexplained is an
honest `□` with exact coordinates. **Start with [notes/README.md](notes/README.md)**
— the map of the proven physics, the regression gate, and all documentation.

The reader is the **blind reader** — no layout constants; bands, baselines,
fonts, spaces and non-text objects (redaction boxes, rules, strike-throughs)
are measured from the pixels. Headless: `bench/blind-read.mjs`; in the app:
the **Auto OCR** button (`blindocr.js`). Handles multiple fonts/compositors
per document, color pages, and palette-quantized producers, at ~0.2 s/page.
(The original grid/template path this project grew out of was removed
2026-07-13 — history in [notes/BLIND_READER.md](notes/BLIND_READER.md); the
original standalone tool survives outside the repo in `../char_training-main/`.)

## Files

| File | Purpose |
|---|---|
| `training.html` / `training.js` / `training.css` | Browser UI: PDF viewing, Auto OCR, text editing, glyph extraction |
| `blindocr.js` | Browser port of the blind reader (Auto OCR / Auto OCR All / .txt + .json export) |
| `ocr.js` | PageEngine: whole-page grayscale buffer + RGBA access the reader works from |
| `core.js` | DOM-free logic (stem↔char maps, geometry, the gray() page law); unit-tested in Node (`node test.js`) |
| `launch.py` | Local static HTTP server (UI, glyph sets, raster cache, corpus) |
| `bench/` | Headless tooling — blind reader, rasterizer, recreation certificate, app test: [bench/README.md](bench/README.md) |
| `corpus/` | Test documents (PDFs .gitignored — local only) + certified transcriptions (`*.txt`) |
| `notes/` | Research record: proven physics, producer laws, session results — index in [notes/README.md](notes/README.md) |

## Quick start

```
python launch.py                # serve on http://localhost:8765 and open the browser
```

Open a PDF (**Pick PDF**), hit **Auto OCR** (or **Auto OCR All** + **Download
.txt/.json**). Measured bands, per-glyph pens, detected objects and per-line
byte-clean certificates come back without any layout setup. Headless
equivalent:

```
cd bench
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt
```

Glyph rasters come from fontgen exports (`bench/glyphs_*.json`, gitignored) —
regenerate with the `..\ocr` workspace's `fontgen.py` + `export_glyphs.py`.

> Glyph-crop saving (double-click a box) uses the File System Access API —
> Chrome/Edge.

## Verification discipline

Any reader change is gated on re-reading the full corpus and comparing against
the certified transcriptions — the exact commands and expected numbers live in
[notes/README.md](notes/README.md).

# char_training

Byte-exact OCR for MuPDF-rendered document rasters. Accuracy is **certified,
not sampled**: a line is accepted only when its glyphs explain the page's
pixels exactly through the renderer's proven blend law (optionally re-rendered
through real MuPDF as an independent certificate); anything unexplained is an
honest `□` with exact coordinates. **Start with [notes/README.md](notes/README.md)**
— the map of the proven physics, the regression gate, and all documentation.

Two reading paths:

- **Blind reader** (current) — no layout constants; bands, baselines, fonts,
  spaces and non-text objects (redaction boxes, rules, strike-throughs) are
  measured from the pixels. Headless: `bench/blind-read.mjs`; in the app: the
  **Auto OCR** button (`blindocr.js`). Handles multiple fonts/compositors per
  document, color pages, and palette-quantized producers.
- **Grid/template path** (legacy, regression-kept) — manual row bands + a
  hand/synth-harvested `templates/` dictionary, exact-pixel matching
  (`ocr.js` + `reader.js`). Documented in [DOCUMENTATION.md](DOCUMENTATION.md);
  in the app it lives in the collapsed "Legacy" panel.

## Files

| File | Purpose |
|---|---|
| `training.html` / `training.js` / `training.css` | Browser UI: PDF viewing, Auto OCR (primary), glyph extraction, legacy grid tools |
| `blindocr.js` | Browser port of the blind reader (Auto OCR / Auto OCR All / .txt + .json export) |
| `ocr.js` / `reader.js` | Legacy path: template matching engine + grid line reader |
| `core.js` | DOM-free logic (stem↔char maps, geometry, pixel math & hashing); unit-tested in Node (`node test.js`) |
| `launch.py` | Local HTTP server; serves the UI, `/api/templates`, and the raster cache |
| `templates/` | Legacy glyph dictionary (PNG per variant + `template_metrics.json`) |
| `bench/` | All headless tooling — blind reader, recreation certificate, dumps, benchmarks, template tools: [bench/README.md](bench/README.md) |
| `corpus/` | Test documents (PDFs .gitignored — local only) + certified transcriptions (`v3.txt`, `big.txt`) |
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

> Glyph saving (legacy path) uses the File System Access API — Chrome/Edge.

## Legacy template workflow

Set up row bands + font in the Legacy panel, drag each line's purple anchor,
type or Grid-OCR the line, double-click a character box to save it as a
template PNG. Filename stems map to characters via `STEM_TO_CHAR` in
`core.js` (`A_UPPER.png` → `A`, `eq.png` → `=`, `_2`/`_3` variants per subpixel
slot; names containing `unmatched` are skipped). Details, layout model, and
matching internals: [DOCUMENTATION.md](DOCUMENTATION.md).

## Verification discipline

Any change to a reader or template set is gated on re-reading the full corpus
and comparing against the certified transcriptions — the exact commands and
expected numbers live in [notes/README.md](notes/README.md). For template-set
changes additionally byte-compare whole-document dumps (`bench/dump-ocr.mjs`,
see [bench/README.md](bench/README.md)).

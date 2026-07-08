# char_training

A small, browser-based tool for building a **glyph-template dictionary** from scanned
document pages — for any font and page layout. You lay text-line bands over a page by hand,
drag each line's start anchor to where it begins, type (or OCR) the line, and double-click
any character to save it as a reference PNG. Character widths come from the chosen font's
advance metrics (default **Times New Roman**), so variable-width fonts line up without a
fixed grid.

## Files

| File | Purpose |
|---|---|
| `training.html` / `training.js` / `training.css` | The browser UI (plus `matchAt`, the glyph-picking loop) |
| `ocr.js` | Matching engine (`TemplateEngine`): template loading, hash index, whole-page buffer, crops; loaded between `core.js` and `reader.js` |
| `reader.js` | Line reader — position-guided row reading & per-glyph alignment — mixed onto the viewer; loaded between `ocr.js` and `training.js` |
| `core.js` | DOM-free logic (stem↔char maps, geometry, pixel math & hashing); loaded before `training.js`, unit-tested in Node |
| `test.js` | `node:test` smoke tests for `core.js` — `node test.js` |
| `launch.py` | Local HTTP server; serves the UI and the `/api/templates` manifest |
| `templates/` | The glyph dictionary — one PNG per character variant at natural size, plus `template_metrics.json` (measured per-template metrics the reader uses to place glyphs) |
| `bench/` | Headless tooling: OCR benchmark, whole-document text dump, false-match tracing, template pruning, metrics measurement — see [bench/README.md](bench/README.md) |
| `DOCUMENTATION.md` | Technical reference for the layout and OCR models |

## Quick start

```
python launch.py                # serve on http://localhost:8765 and open the browser
python launch.py --port 9000    # custom port
python launch.py --no-browser   # don't auto-open
```

> Saving glyphs uses the File System Access API, so use **Chrome or Edge**. Other browsers
> fall back to plain downloads.

## Workflow

1. **Pick a PDF** — *Pick PDF* extracts the embedded raster image of each page (pdf.js).
   Navigate with the `<` `>` buttons or the page dropdown.
2. **Set up the lines** — in the **Settings** panel, adjust the **Horizontal Lines**
   (first row Y, row height, line pitch, row count) until the blue bands sit on the text,
   and the **Font** (family, size) until the character boxes match the print.
3. **Place each line's start** — drag a row's **purple anchor** to where that line begins.
   The row becomes active.
4. **Fill the line** — type into the *Line text* box (or run **OCR Page**). A box is drawn
   per character, its width taken from the font's advance metrics.
5. **Extract glyphs** — double-click any character box. A modal shows the crop, pre-filled
   with the character; press **Enter** to save. The first save prompts for a folder (pick
   `templates/`); later saves write there silently.

## Template filename conventions

Glyphs are matched by filename stem:

| Pattern | Character |
|---|---|
| `0.png`, `0_2.png`, … | `0` (and variants) |
| `a.png`, `a_2.png`, … | `a` |
| `A_UPPER.png` | `A` |
| `eq.png` `slash.png` `plus.png` `minus.png` … | `=` `/` `+` `-` (see `STEM_TO_CHAR` in `core.js` for the full symbol map) |

Variants (`_1`, `_2`, …) are all loaded and matched. At a given font size a glyph only
renders in a handful of distinct **subpixel slots**, and each variant covers one of them —
the numbering is kept in ascending slot order (then by the template's measured anchor) by
the bench tooling, so `t_1 … t_N` reads left-to-right across the pixel. Files with
`unmatched` in the name are skipped.

## Reading & accuracy

Matching is exact pixel equality, hash-indexed so each probe is a Map lookup rather than a
scan over the dictionary. When `templates/template_metrics.json` is present (regenerate with
`node bench/measure-metrics.mjs` after adding, cutting, or deleting templates), the reader
*places* each next glyph from the previous one's measured fractional advance and anchor and
rejects candidates whose measured position contradicts the prediction — without the file it
falls back to ink-width stepping. Changes to templates or the reader are verified by dumping
the whole document (`node bench/dump-ocr.mjs --all --out out.txt`) before and after and
comparing the files byte-for-byte.

Layout is fully manual (the `Config` class in `training.js`): rows from `rowBase` /
`rowHeight` / `rowPitch` / `rowCount`, character widths from `measureText` on
`fontFamily` / `fontSize`. See [DOCUMENTATION.md](DOCUMENTATION.md) for details.

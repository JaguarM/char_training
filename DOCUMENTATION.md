# char_training — Technical Reference

A browser tool for building a glyph-template dictionary from scanned pages. You open a PDF,
the tool extracts each page's embedded raster image and overlays manually configured
horizontal text-line bands. Each row has a draggable start anchor; drag it to where the line
begins, then type the line (or run **OCR Page**). A per-character box is drawn whose width
comes from the chosen font's advance metrics (`measureText`), so variable-width fonts work
without a fixed grid. Double-click a box to crop that glyph at its natural size and label it.

```
training.html   DOM structure, toolbar, settings panel, label modal
training.css    Styles
core.js         DOM-free core: stem↔char maps, constants, geometry, pixel math, pixel hashing
ocr.js          Matching engine: TemplateEngine (template loading, hash index, page buffer, crops)
reader.js       Line reader: position-guided row reading & per-glyph alignment (ocrRow + helpers)
training.js     Config, CanvasViewer, matchAt (glyph picking), PDF image extraction
test.js         node:test smoke tests for core.js
launch.py       HTTP server: serves the UI + /api/templates manifest
templates/      Glyph dictionary — one PNG per character variant + template_metrics.json
bench/          Headless tools: benchmark, text dump, tracing, pruning, metrics (bench/README.md)
```

---

## Layout model

Layout is manual, held in `Config` and editable live from the **Settings** panel.

**Horizontal lines (rows)** — `Config.makeRowBands()` returns `rowCount` bands `{ y0, y1 }`
with `y0 = rowBase + i*rowPitch` and `y1 = y0 + rowHeight`:

| Field | Default | Meaning |
|---|---|---|
| `rowBase` | `40` | Y of the first row's top edge |
| `rowHeight` | `15` | Height of each row band |
| `rowPitch` | `18` | Vertical distance between consecutive rows |
| `rowCount` | `54` | Number of rows |

**Character widths (font)** — there is no vertical character grid. After a row's start X is
set and its text typed, `boxesForRow()` walks the font's cumulative advance widths to produce
one variable-width box per character:

| Field | Default | Meaning |
|---|---|---|
| `fontFamily` | `Times New Roman` | Font whose metrics drive cutout widths |
| `fontSize` | `16` | Size in image-space px — tune until boxes track the print |

`charX(startX, text)` is the single layout rule: `startX + measureText(text).width`.
Character *i*'s box runs from `charX(startX, text.slice(0, i))` to `charX(startX,
text.slice(0, i+1))`, so kerning is respected. Because `fontSize` is in image-space pixels
and boxes are drawn inside the image transform, measured widths map directly to image pixels.

---

## OCR & matching (`ocr.js`, `reader.js`, `matchAt` in `training.js`)

The OCR code is split in two: `ocr.js` holds the matching engine (`TemplateEngine`) and the
template-loading glue (`CanvasViewerTemplates`); `reader.js` holds the line reader
(`ocrRow`, `ocrAllRows`, re-scoring, plus the `_nextInk` / `_matchNear` / `_span` helpers, in
`CanvasViewerReader`). The glyph-picking loop itself (`matchAt`) lives on `CanvasViewer` in
`training.js`. Both mixins are `Object.assign`'d onto `CanvasViewer.prototype` at the bottom
of `training.js`; the line and font **settings** (`Config`) stay in `training.js`.

Templates load at their **natural size** (`{char, filename, w, h, pixels, metric}`).
Matching is **exact pixel equality**, never a fuzzy best-guess: an unknown glyph is left
blank for you to teach rather than mislabelled as a look-alike.

- **Whole-page grayscale buffer**: the page is read into one grayscale `Float32Array` *once*
  (`_pageFor`, a single `getImageData`, cached by image identity), and every crop then just
  indexes into that buffer (`cropPixels`) instead of doing a `drawImage` + `getImageData`
  per probe. A 1:1 blit of the full image is byte-identical to blitting any sub-rectangle,
  so crops stay pixel-exact (same `round(sx/sy)`; off-page pixels read as `0`).
- **Hash-indexed matching**: templates are grouped by distinct `w×h` (`_sizes`) and, within
  a group, indexed by a hash of their pixel bits (`hashPixels` in `core.js`) — one exact map
  and one *poke-tolerant* map whose hash skips col 0 of row 0. `matchAt(sx, sy)` crops the
  source once per size group, hashes the crop, and looks up the candidates (usually 0–1)
  instead of comparing against every template of the size; `pixelsEqual` /
  `pixelsEqualPokeTolerant` then confirm, so a hash collision can never produce a false
  match. The **widest exact match wins** (a narrow template can equal a slice of a wider
  glyph); when nothing matches exactly, the poke-tolerant pass allows col 0 of row 0 to
  differ (uppercase `T V W Y` can poke 1px further left than their cut, changing that one
  anti-aliased pixel) — exact always beats poke. No match anywhere returns the placeholder
  `{char: '□', score: 0}`.
- **Position-guided reading** (`templates/template_metrics.json`): the engine auto-loads the
  metrics file next to the templates (regenerated by `bench/measure-metrics.mjs`; see
  `bench/README.md`). When its `fontSpec` matches the live `Config`, each template carries
  its measured **anchor** — the fractional displacement `matchColumn − x0` between where its
  pixels sit and the glyph's layout position — plus the char's fractional `advanceWidth`. A
  match then pins the glyph's true fractional x0 (`x0 = column − anchor`), and the next
  glyph is *placed* at `x0 + advanceWidth + kern(pair)` (pair kerns measured live,
  cached per font) instead of guessed from ink width. Candidates found by the search are
  **position-gated**: one whose own anchor puts it more than `OCR_POS_TOL` (widened by the
  template's measured anchor spread) from the prediction is rejected — a slid or stray match
  sits ~a whole column off, so the gate separates cleanly. When *nothing* in reach passes
  the gate, the reader falls back to the nearest ungated exact match, so guided reading
  never reads less than unguided. Templates without metrics — or a metrics file measured
  under another font — degrade to the unguided behaviour, wholesale.
- `ocrRow(r)` walks a row from its anchor with a **local pen**: the next cell-left is
  predicted from the current glyph (the metric pen above when available, else
  `cellLeft + w + INTERGLYPH` off its real matched position and ink width), and a short
  nearest-first search (`_matchNear`, ±`OCR_MIDWORD_SEARCH`, widened once to
  ±`OCR_MIDWORD_RESYNC` on a miss) absorbs the residual; the matched column re-seeds the pen
  so nothing accumulates. Every accepted match is resolved to its full column span
  (`_span`): the leftmost matching column is the glyph's true cell-left, and the rightmost
  floors the next search, so a thin glyph matching several adjacent columns reads once, not
  twice. Blank cells (per-pixel std-dev below `BLANK_STDDEV`, tested on the band minus
  `POKE_CROP` rows at top and bottom so a neighbour's descender or poke-out can't register
  as ink) are walked with `_nextInk` and the next word re-anchored on its own column —
  **gaps are skipped silently; no space characters are emitted**. The first inked column
  with no acceptable match stops the line with a single `□`; the stop column is recorded
  (`rowStopX[r]`) so `boxesForRow` pins that `□` to the glyph's real ink column — it sits on
  the glyph, so a double-click captures it cleanly.
- **OCR Page** (`ocrAllRows`) reads every row and reports `read / to fill` counts.
- **Saving a glyph** auto-refreshes the page (`refreshOcrAfterSave`): OCR'd rows are re-read,
  and hand-typed rows are re-scored in place (`rescoreManualRow`) — their text is preserved,
  but any character that now matches a template exactly is upgraded to green. No typed words
  are lost.

Crops are read/saved `TEMPLATE_LEFT_CROP` (1) px to the right of the advance origin and 1px
narrower — the *canonical cut*, columns `[x0+1, x0+round(advance)−2]` — so adjacent crops
never share a pixel column and a saved template still aligns pixel-for-pixel with the page.

### Stem ↔ character mapping

`charToStem(label)` / `stemToChar(stem)` translate between a typed label and a filename stem:

| Character | Stem |
|---|---|
| `A`–`Z` | `A_UPPER`, `B_UPPER`, … |
| `a`–`z`, `0`–`9` | themselves |
| symbols (`=` `/` `+` `-` `(` `)` `@` …) | named, via `STEM_TO_CHAR` in `core.js` |

Variants (`_2`, `_3`, …) resolve to the base character. The mapping is mirrored server-side
in `launch.py`'s `stem_to_char`; the two must stay in sync.

---

## UI

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Pick PDF] [Load Templates] [OCR Page]  < [page ▾] >  Line text:[____]  …  │
├──────────────┬─────────────────────────────────────────────────────────────┤
│ settings     │                                                              │
│  panel       │              canvas (fills viewport)                         │
└──────────────┴─────────────────────────────────────────────────────────────┘
```

| Toolbar element | Description |
|---|---|
| **Pick PDF** | Loads a PDF and extracts each page's embedded raster image via pdf.js. |
| **Load Templates** | Folder picker for a glyph directory. Auto-loaded from `/api/templates` on startup when served by `launch.py`. |
| **OCR Page** | Reads every row, appending exact matches (green) and stopping each line at its first unknown glyph (orange `□`). |
| `<` / dropdown / `>` | Page navigation. |
| **Line text** | Transcription of the active row; typing draws a box per character. |
| Info bar | Filename/page, dimensions, row count, font. |

The **Settings** panel is live-bound to `Config`; editing any field re-derives geometry via
`CanvasViewer.applySettings()`.

### Overlays

- **Blue row bands** — hairlines at `y0`/`y1` of each band with the 1-based line number to
  the left; the active row is brighter. Line width is `1/scale`, so hairlines stay 1 screen
  pixel at any zoom.
- **Purple start anchors** — a vertical tick at `rowStartX[r]` on every row; the active row's
  is brighter and thicker. Drag one to set where that line begins.
- **Character boxes** — each character is drawn in its match colour with a yellow outline
  when hovered: **green** = exact match, **orange** = `□` placeholder, **blue** = hand-typed.
  Spaces advance the cursor but get no box.

### Extraction & saving

1. Drag a row's purple anchor to the line start (`anchorAt` hit-tests it; dragging elsewhere
   only pans). 2. Type the row's text, or run OCR. 3. Double-click any character box on any
   row — `boxAt` hit-tests every row's boxes (`allBoxes`), so you needn't select the line
   first; it flashes yellow for 150 ms and makes that row active.

The crop is rendered to an offscreen canvas at natural size (`round(box width) − 1 −
TEMPLATE_LEFT_CROP` wide × `round(row height)` tall, smoothing off). A `□` box has no glyph
width of its own, so once it's labelled the crop is re-cut to the labelled character's advance
(`measureText`), keeping placeholder captures the same one-advance width as normal boxes. The
label modal opens with a 6× pixelated preview and an input **pre-filled with the character**
(selected).
**Enter** saves; **Esc**, an empty Enter, or a backdrop click cancels.

- **File System Access API:** the first save prompts for a read-write folder
  (`showDirectoryPicker`); later saves write silently. `findAvailableFilename` probes
  `stem.png`, `stem_2.png`, … so repeats never overwrite. After writing, the dictionary
  reloads and matching re-runs.
- **Fallback:** each save triggers a browser download named `{stem}.png` (no collision check,
  no auto-reload).

### Zoom & pan

State is `tx`, `ty` (screen offsets) and `scale`, applied as `translate(tx,ty)` →
`scale(scale,scale)` each frame. Scroll wheel zooms 1.12×/tick anchored to the cursor (range
0.05×–80×); left-drag (off any anchor) pans; double-click extracts. `imageSmoothingEnabled =
false` is set before every `drawImage`, so pixels stay sharp. There is no reset-view gesture
— zoom out or reload a page.

---

## `launch.py` — server & manifest

```
GET /                  → 302 redirect to /training.html
GET /api/templates     → JSON [{ filename, char }, …] for every valid glyph in ./templates/
GET /templates/<file>  → individual glyph PNG (static)
GET /<path>            → static file from the project directory
```

`build_template_manifest()` scans `./templates/*.png`, skips names containing `unmatched`,
and resolves each stem with `stem_to_char` (the server-side mirror of the JS mapping).
Request logging is suppressed; `find_free_port` falls back to an OS-assigned port if the
preferred one is busy.

---

## Development & testing

No build step — just `python launch.py`. The genuinely DOM-free logic lives in `core.js` (the
stem↔char mapping, tuning constants, `makeRowBands`, grayscale conversion, the blank test, and
exact pixel equality), with no browser globals and no load-time side effects. It works both as
a `<script>` (attaching its exports as globals for `training.js`) and as a Node module
(`require('./core.js')`).

```
node test.js                                          # headless unit tests (node:test)
for f in core.js ocr.js reader.js training.js; do node --check "$f"; done   # syntax-check
```

`training.js` keeps all the canvas/DOM and pdf.js code, so it can't be imported in Node — but
the logic worth testing lives in `core.js`, which can.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No character boxes appear | Drag a row's anchor to set its start, then type into *Line text*. With no text a row draws nothing. |
| Boxes too wide / narrow | Tune **Font size**; if the shape is wrong, change **Font family**. |
| Row bands don't sit on the text | Adjust **First row Y**, **Line pitch**, **Row height**, **Row count**. |
| "no embedded image found" | The page has no painted raster image XObject (e.g. vector/text-only); nothing to extract. |
| Blurry at high zoom | Confirm `ctx.imageSmoothingEnabled = false` before each `drawImage` in `render()`. |

# Base64 Layout Debugger — Documentation

## Overview

`training.html` is a self-contained, zero-dependency browser tool for visually
verifying the rigid character-grid layout of scanned document images that encode
monospaced Base64 text, and for running in-browser Normalized Cross-Correlation
(NCC) template matching — the same algorithm used by the Python pipeline —
to display per-cell OCR confidence directly on the image.

Files:

```
training.html  — DOM structure, toolbar, label modal
training.css   — All styles
training.js    — Three classes: TemplateEngine, Config, CanvasViewer
```

---

## Document Layout Model

| Constant | Value | Meaning |
|---|---|---|
| `xStart` | `60` px | Left edge of the text block |
| `xEnd` | `653` px | Right edge of the text block |
| `nCols` | `76` | Characters per line |
| `charPitch` | `(653 − 60) / 76 = 7.8026…` px | Width of one character cell |
| `nLines` | `77` | Vertical divider count (column edges) |

The 77 red vertical lines mark the left edge of every column plus the right
edge of the last column:

```
line[0]  → x = 60.000   ← left edge of col 0
line[1]  → x = 67.803   ← left edge of col 1
…
line[76] → x = 653.000  ← right edge of col 75
```

`charPitch` and `nLines` are computed getters on `Config`; only `xStart`,
`xEnd`, and `nCols` need to be changed for a different document.

The `rowBands` array in `Config` is a hardcoded list of `{y0, y1}` pairs
(in image pixels) representing the vertical extent of each text line.

---

## Getting Started

### Option A — VS Code Live Server (recommended)

1. Open the folder in VS Code and click **Go Live** in the status bar.
2. The browser opens; `page_002.png` is auto-loaded if it exists in the folder.

### Option B — Direct `file://` open

Double-click `training.html`. The `page_002.png` auto-load silently fails
(browsers block `fetch()` on `file://`). Use drag-and-drop or the Upload button
instead. Template loading and cell saving still work via the File System Access
API.

### Browser requirements

Chrome 86+ or Edge 86+ are required for `showDirectoryPicker` (template loading
and cell saving). Firefox and Safari lack this API and fall back to standard
downloads for cell saving; template loading will show an error message.

---

## User Interface

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [Upload Image] [Load Templates] [Confidence: On]  ▪col ▪rows ▪▪▪  info bar │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                          canvas (fills viewport)                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Toolbar elements

| Element | Description |
|---|---|
| **Upload Image** | Opens the OS file picker; accepts any browser-supported image format. |
| **Load Templates** | Opens a folder picker for the template directory. Triggers NCC matching immediately if an image is already loaded. |
| **Confidence: On/Off** | Toggles the per-cell confidence overlay on or off. The button turns active (highlighted) when on; the confidence legend items in the toolbar show or hide accordingly. |
| Red swatch | Legend: vertical column-boundary lines. |
| Blue swatch | Legend: horizontal text-row boundary lines. |
| Green / Yellow / Orange swatches | Legend: NCC confidence tiers (appear only when overlay is on). |
| Info bar | Right-aligned status text showing filename, dimensions, row count, pitch, and — after matching — confidence summary counts. |

---

## Loading Images

Three paths all funnel into `CanvasViewer.loadURL(url, label, revoke)`:

1. **Upload button** — file picker, `image/*` filter.
2. **Drag and drop** — drop any image file onto the canvas area. Blue inset border confirms drop target. Non-image files are silently ignored.
3. **Auto-load** — `fetch('page_002.png')` on page load; works over HTTP only.

After load: the image is fit to the canvas with a 20 px margin, `matchResults`
is invalidated, and — if templates are already loaded — NCC matching runs
automatically.

---

## Visual Overlays

### Red vertical grid

77 hairlines at `x = xStart + i × charPitch` for `i = 0…76`, running the full
image height. Line width is `1 / scale` so lines stay exactly 1 screen pixel
wide at any zoom level.

### Blue horizontal row bands

Pairs of hairlines at `y0` and `y1` of each entry in `rowBands`, spanning
`xStart` to `xEnd` only.

### Confidence overlay

Drawn on top of the grid when **Confidence** is on and `matchResults` is
populated. For every non-blank cell:

| Score range | Color | Meaning |
|---|---|---|
| ≥ 0.75 | Green `rgba(0,210,70,…)` | High confidence |
| 0.50 – 0.74 | Yellow `rgba(230,185,0,…)` | Medium confidence |
| < 0.50 | Red `rgba(230,55,55,…)` | Low confidence |

Each cell gets a **semi-transparent background tint** (opacity 0.28) and a
**character label** rendered in the same color, sized to ~90% of the cell
height. When the cell is zoomed to ≥ 60 screen pixels wide, a smaller
**numeric score** (e.g. `0.83`) also appears below the character.

---

## NCC Template Matching Engine (`TemplateEngine`)

The engine is a pure-JS port of the Python `TM_CCOEFF_NORMED` pipeline in
`extract_base64.py`. It operates on 8 × 15 px grayscale cell images.

### Template directory structure

The folder must contain one PNG per character, named with the same stem
convention used by the Python saver:

| Character | Expected filename stem |
|---|---|
| `=` | `eq` |
| `/` | `slash` |
| `+` | `plus` |
| `A`–`Z` (uppercase) | `A_UPPER`, `B_UPPER`, … |
| `a`–`z`, `0`–`9` | `a`, `b`, … `0`, `1`, … |

Multiple files per character are allowed (e.g. `a_2.png`, `a_3.png`); the
engine loads only the **first file alphabetically** for each character.
Files containing `unmatched` in the name are skipped.

### Loading flow (`loadFromDir`)

1. Iterates every `.png` in the chosen directory via `dirHandle.entries()`.
2. Resolves each filename to a character using `stemToChar()`.
3. Renders each template to an 8 × 15 canvas with bilinear smoothing and
   reads back a `Float32Array(120)` of grayscale values (avg of R, G, B).
4. Pre-computes per-template **mean** and **L2-norm** (`den`) for fast NCC.
5. Returns the count of loaded characters; warns if fewer than 65.

All file loads run in parallel via `Promise.all`.

### Matching a single cell (`matchPixels`)

```
pixels  — Float32Array(120) from an 8×15 grayscale crop
```

1. Compute the pixel mean and std-dev.
2. If std-dev < 5 → classify as **blank** (pure white / empty space),
   return `{ char: ' ', score: 1, blank: true }`.
3. Otherwise run `ncc(pixels, mean, t)` against every loaded template and
   return `{ char, score, blank: false }` for the best match.

### NCC formula (`ncc`)

```
TM_CCOEFF_NORMED:
  score = Σ(aᵢ − ā)(tᵢ − t̄) / ( ‖a − ā‖ · ‖t − t̄‖ )
```

Returns a value in [−1, 1]. Returns 0 if either norm is below `1e-8`
(featureless patch).

### Full-page matching (`matchAll`)

Iterates every `{y0, y1}` in `rowBands` × every column index `0…nCols-1`.
For each cell, calls `extractCrop` (which resamples the source region to 8 × 15
with bilinear interpolation — matching the Python `cv2.INTER_CUBIC` pass) then
`matchPixels`. Returns a 2D array `matchResults[rowIdx][colIdx]`.

After matching, the info bar updates with counts:

```
Match: {high} high / {mid} mid / {low} low  ({total} cells, {rows} rows)
```

---

## Box Extraction & Classification (`Shift+Click`)

### Workflow

1. **Shift+Click** a cell that is inside a blue row band and between two red
   column lines. The cell flashes yellow for 150 ms to confirm the hit.
2. The **label modal** opens with:
   - A **6× upscaled pixelated preview** of the extracted cell on a white canvas.
   - A text input **pre-filled with the NCC prediction** (if templates are loaded
     and the cell is non-blank). The text is selected so you can instantly
     overwrite it by typing.
3. **Press Enter** to accept the label (or the pre-fill). Empty input falls back
   to `char_r{rowIdx}_c{colIdx}`.
4. **Press Escape** or click the dark backdrop to cancel.

### Filename convention (`charToStem`)

The label is converted to a filesystem-safe stem before saving:

| Label typed | Stem used |
|---|---|
| `=` | `eq` |
| `/` | `slash` |
| `+` | `plus` |
| `A`–`Z` | `A_UPPER`–`Z_UPPER` |
| anything else | label as-is |

### Collision avoidance (`findAvailableFilename`)

If `stem.png` already exists in the save directory the engine tries
`stem_2.png`, `stem_3.png`, … until it finds a free slot. This means every
Shift+Click always produces a new file, even for repeated characters.

### Output folder

- **First save:** browser prompts to pick a folder (`showDirectoryPicker`).
  All subsequent saves in the session write there silently.
- **Fallback (no File System Access API):** each save triggers a browser
  download named `{stem}.png` (no collision check).

---

## Zoom & Pan

State: `tx`, `ty` (screen-pixel offsets), `scale` (uniform zoom factor).
Applied each frame as `ctx.translate(tx,ty)` → `ctx.scale(scale,scale)`.

| Gesture | Behaviour |
|---|---|
| Scroll wheel | Zoom in/out by factor 1.12 per tick, anchored to cursor position. Range: 0.05× – 80×. |
| Left-drag | Pan. `mousemove` / `mouseup` attached to `window` so dragging outside the canvas doesn't drop the gesture. |
| Double-click | Reset to fit-in-canvas (20 px margin). |

`ctx.imageSmoothingEnabled = false` is set before every `drawImage` call so
pixels stay sharp (nearest-neighbour) at high magnification.

---

## Internal Architecture

```
training.html
├── #toolbar
│   ├── #upload-label / #file-input
│   ├── #templates-btn
│   ├── #confidence-btn
│   ├── .legend  (red, blue, green, yellow, orange swatches)
│   └── #info
├── #label-modal  (hidden by default)
│   └── #label-modal-inner
│       ├── #label-preview  (canvas, 6× upscaled char)
│       ├── #label-input
│       └── #label-hint
└── #main-content
    └── #canvas-wrap > #canvas

training.js
├── TemplateEngine
│   ├── stemToChar(stem) → char
│   ├── charToStem(label) → stem
│   ├── loadFromDir(dirHandle) → count        async
│   ├── _loadGray(url, char) → {char,pixels}  async
│   ├── _cropCtx() → CanvasRenderingContext2D  (lazy singleton)
│   ├── extractCrop(imgEl, sx,sy,sw,sh) → Float32Array(120)
│   ├── ncc(a, aMean, t) → score
│   ├── matchPixels(pixels) → {char, score, blank}
│   └── matchAll(imgEl, rowBands, config) → result[][]
│
├── Config
│   ├── xStart, xEnd, nCols  (layout constants)
│   ├── rowBands[]           (hardcoded {y0,y1} per text line)
│   ├── get charPitch()
│   └── get nLines()
│
└── CanvasViewer
    ├── constructor(canvas, wrap, infoEl, config)
    │   └── creates TemplateEngine; sets showConfidence = true
    ├── initEvents()           ResizeObserver, wheel, mouse, drag-drop
    ├── resize()               sync canvas pixel size → render
    ├── loadURL(url,label,rev) load image → resetFit → runMatching (if ready)
    ├── onDrop(e)              drag-drop handler
    ├── loadTemplates()        showDirectoryPicker → engine.loadFromDir → runMatching
    ├── runMatching()          engine.matchAll → update info bar → render
    ├── resetFit()             fit-to-canvas transform
    ├── updateInfo()           populate #info text
    ├── render()               clear → image → red grid → blue rows → confidence
    ├── renderConfidence()     tint + char label (+ score when zoomed) per cell
    ├── findAvailableFilename(stem) → filename   async, collision-safe
    ├── onMouseDown(e)         Shift+Click → extractBox; else start drag
    ├── extractBox(col,ri,y0,y1)  crop → promptLabel → save    async
    ├── promptLabel(canvas,col,ri,suggestion) → label|null      async modal
    ├── onWheel(e)             zoom toward cursor
    ├── onMouseMove(e)         pan
    └── onMouseUp()            end pan
```

---

## Troubleshooting

### `page_002.png` does not auto-load

`fetch()` is blocked on `file://`. Serve the folder over HTTP (VS Code Live
Server, `python -m http.server`, etc.) or load the image manually.

### "No valid templates found in that folder"

Check that the folder contains `.png` files named with the correct stems
(e.g. `A_UPPER.png`, `eq.png`, `slash.png`). Files must not contain
`unmatched` in their name, and must be readable images.

### Fewer than 65 templates loaded

A `Loaded X / 65 template chars` warning appears in the info bar. Characters
with missing templates will be skipped during matching and show no overlay cell.

### Confidence overlay is blank after loading templates

Make sure an image is loaded first. If the image was loaded *before* the
templates, click **Load Templates** again — matching runs automatically after
each template load.

### Grid lines appear misaligned

Edit `xStart`, `xEnd`, `nCols` in the `Config` constructor in `training.js`.

### Image is blurry at high zoom

Verify `ctx.imageSmoothingEnabled = false` is set immediately before
`ctx.drawImage(this.img, 0, 0)` inside `render()`.

---

## Quick Reference

| Action | Control |
|---|---|
| Load image | Upload button, drag & drop, or auto-load |
| Load template folder | **Load Templates** button |
| Toggle confidence overlay | **Confidence: On/Off** button |
| Extract & label cell | `Shift` + Click → type label → `Enter` |
| Accept NCC prediction | `Shift` + Click → `Enter` (input is pre-filled) |
| Cancel extraction | `Esc` or click backdrop |
| Zoom in / out | Scroll wheel |
| Pan | Left-click drag |
| Reset view | Double-click |
| Change layout grid | Edit `xStart`, `xEnd`, `nCols` in `Config` (`training.js`) |
| Change row positions | Edit `rowBands` array in `Config` (`training.js`) |

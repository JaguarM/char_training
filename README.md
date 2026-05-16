# char_training

Tools for extracting text from scanned PDFs where the content is encoded as monospaced Base64 printed on a rigid character grid.

## Target documents

The two PDFs this toolchain was built for are released FOIA productions from the Epstein investigation:

| Document | ID |
|---|---|
| EFTA00382083 | FBI Epstein production |
| EFTA00400459 | FBI Epstein production |

Both can be downloaded from the DOJ FOIA reading room:
**https://www.justice.gov/epstein/search**

---

## How it works

Each page of the scanned PDF contains a raster image. The image shows monospaced Base64 text printed on a fixed character grid:

| Constant | Value | Meaning |
|---|---|---|
| `xStart` | `60` px | Left edge of the text block |
| `xEnd` | `653` px | Right edge of the text block |
| `nCols` | `76` | Characters per line |
| `charPitch` | `≈ 7.80` px | Width of one character cell |
| `rowHeight` | `15` px | Distance between text baselines |
| `cellSize` | `7 × 11` px | Crop extracted per character for matching |

For each cell the tool runs **Normalized Cross-Correlation (NCC)** against a library of 7×11 px reference glyphs. The best match above a confidence threshold is kept; rows where the average score falls below **0.40** are discarded as noise. After all pages are processed the tool scans the output for the Base64 header marker `JVBERi0xLj` (the PDF magic bytes in Base64) and extracts everything from that point onward as the recovered payload.

---

## Files

```
batch_ocr.html        — Main OCR tool (self-contained, open in Chrome/Edge)
char_training/        — Template training tools (see char_training/README.md)
DOCUMENTATION.md      — Deep-dive technical reference for the training UI
```

---

## batch_ocr.html — Quick start

`batch_ocr.html` is fully self-contained. Open it directly in Chrome or Edge — no server required. Templates are baked in as inline Base64 by `char_training/bake_templates.py`.

### Toolbar

| Button | Action |
|---|---|
| **Pick PDF** | Load a PDF file. Pages are processed lazily — each page's embedded raster image is extracted on demand. |
| **Run OCR** | Process every page. Progress bar and live row count update during the run. |
| **Save base64.txt** | Download the recovered Base64 string as a `.txt` file. |
| **Decode PDF** | Decode the recovered Base64 directly in the browser and download the result as a `.pdf`. |

### Processing pipeline

1. **Extract** — for each PDF page, the embedded raster image is pulled from the PDF operator stream (`paintImageXObject` / `paintJpegXObject`).
2. **Auto-detect row baseline** — `autoDetectBase` sweeps the row offset from 28 to 52 px and picks the value that maximises average NCC score on the last 10 rows. Falls back to 40 px if no sweep value clears the 0.40 threshold.
3. **OCR** — each of the 65 row × 76 column cells is cropped to 7×11 px, converted to grayscale, and matched via NCC against the baked-in template set.
4. **Filter** — rows where every cell is blank are dropped; rows where the mean non-blank score is below 0.40 are dropped.
5. **Assemble** — all kept rows are joined. The tool searches for `JVBERi0xLj` and strips everything before it. All non-Base64 characters are removed.
6. **Decode** — `atob()` converts the cleaned Base64 string to binary; the result is offered as a PDF download.

---

## char_training/ — Template library

See **[char_training/README.md](char_training/README.md)** for the full workflow.

In brief: run `python char_training/launch.py`, pick one of the target PDFs in `training.html`, double-click any cell to label it, then run `python char_training/bake_templates.py` to embed the updated template set into `batch_ocr.html`.

---

## Browser requirements

Chrome 86+ or Edge 86+. The File System Access API (`showDirectoryPicker`) is required for the training tool's direct-save workflow; `batch_ocr.html` itself has no such dependency.

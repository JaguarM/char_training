# char_training

Tools for building and maintaining the glyph template dictionary used by `batch_ocr.html`.

## Overview

The OCR works by **Normalized Cross-Correlation (NCC)** matching: each character cell in the scanned document is compared against a library of 7×11 px reference glyphs stored in `templates/`. The tools here let you grow that library by labelling new examples extracted directly from a PDF.

## Quick start

```
python launch.py
```

Opens `training.html` in the browser on `http://localhost:8765`. Templates in `./templates/` are auto-loaded via the `/api/templates` API.

```
python launch.py --port 9000   # custom port
python launch.py --no-browser  # don't auto-open
```

## Workflow

1. **Pick a PDF** — click *Pick PDF* in the toolbar. The tool extracts the embedded raster image from each page and lets you navigate them.
2. **Load templates** — click *Load Templates* (directory picker) or let them auto-load via `launch.py`.
3. **Auto Grid** — click *Auto Grid* to detect the correct row baseline for every page. The current page is processed first and displayed immediately; remaining pages are queued in the background. The per-page baseline is remembered so navigating pages applies the right grid automatically.
4. **Label glyphs** — double-click any character cell to extract the 7×11 px crop. A modal shows the crop alongside the top NCC match suggestion. Press Enter to accept or type a correction, then Enter again to save.
   - If `launch.py` is running, the PNG is written directly into `./templates/` and templates reload automatically.
   - Otherwise the PNG is downloaded to your Downloads folder.
5. **Bake into batch_ocr.html** — once the template set looks good, run:

```
python bake_templates.py
```

This reads every PNG in `./templates/`, base64-encodes it, and rewrites the `// --- BAKED-IN TEMPLATES ---` block inside `../batch_ocr.html` so the OCR tool is self-contained (no server needed).

## File reference

| File | Purpose |
|---|---|
| `training.html` / `training.js` / `training.css` | Browser-based training UI |
| `launch.py` | Local HTTP server; serves `training.html` and the `/api/templates` manifest |
| `bake_templates.py` | Bakes `templates/*.png` into `../batch_ocr.html` as inline base64 |
| `templates/` | 7×11 px reference glyphs; one PNG per character variant |

## Template filename conventions

| Filename pattern | Character |
|---|---|
| `0.png`, `0_2.png`, … | `0` (multiple variants) |
| `A_UPPER.png` | `A` |
| `eq.png` | `=` |
| `slash.png` | `/` |
| `plus.png` | `+` |
| `minus.png` | `-` |

Variants (`_2`, `_3`, …) are all loaded and matched — more variants generally improve accuracy.

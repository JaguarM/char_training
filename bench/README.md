# bench/ — headless tooling

The blind reader family — the whole system since the legacy grid/template
tools were removed (2026-07-13; history in
[../notes/BLIND_READER.md](../notes/BLIND_READER.md)). The map of proven
physics and the full regression gate: [../notes/README.md](../notes/README.md).

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
node blind-read.mjs --pdf ../corpus/v3.pdf --all --truth ../corpus/v3.txt --verify
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
| `--verify` | per-line byte-exact MuPDF re-render certificates (needs `..\ocr\tools\render_hypotheses.py`) |
| `--out` / `--json` | clean text / structured output (baselines, fonts, per-glyph ¼-px pens, objects, certificates, struck spans) |

Mode-2 (color) pages: neutral ink (R=G=B) is read byte-exactly via sum/3;
ink components connected to non-neutral pixels (hyperlink blue) are flooded
away before reading. Debug envs: `BR_DEBUG=1` (fail pixels), `BR_LINE=<baseline>`
(accept trace), `BR_PIX=<col>` (per-pixel rejection detail).

# Source recreation — `recreate.mjs`

The round-trip certificate: rebuild page rasters from a blind-read `--json`
(pens + baselines + fonts + compositor law) and byte-compare against the
cached truth outside objects/□ masks — the proof that the JSON losslessly
describes the page text.

```
node blind-read.mjs --pdf ../corpus/v3.pdf --page 2 --json p2.json
node recreate.mjs --json p2.json --pdf ../corpus/v3.pdf --page 2
```

# App Auto-OCR test — `test-blind-app.mjs`

Headless test of the browser port (`blindocr.js` + `CanvasViewer.blindOcrPage`
/ `blindOcrDocument`) through the real `training.html`: v3 P1+P2, email P1+P2
(color + palette), courier_1 P1 (mixed sizes) vs truth, plus the
document-level API. Run after touching `blindocr.js` or `training.js` — the
port carries the full bench feature set (union pools, color, strike, quant).

# Erased-letter information limit — `guess-letter.mjs`

The stress-test tool behind [../notes/MISSING_LETTER.md](../notes/MISSING_LETTER.md)
(erase one glyph, infer it back at three evidence levels; also `--calibrate`
for the δ/x0 physics numbers).


# Rasterize a PDF into the cache — `rasterize.mjs`

Populates `raster-cache/<sha16>/page-NNNN.gray.gz` for a PDF, byte-identical
to live in-app extraction (same pdf.js embedded-image extraction, same gray()
reduction). Pages already cached are skipped. Run once per new document; every
other tool then works from the cache without the PDF.

```
node rasterize.mjs --pdf ../corpus/doc.pdf            # all pages
node rasterize.mjs --pdf ../corpus/doc.pdf --page 3   # one page
```

# SOLVED (2026-07-12 evening, same session): v4.pdf's byte law — palette quantization

This file began as a hunt prompt for a `Desktop/ocr` session; the hunt turned
out to be unnecessary — the law fell out of the PDF structure in ~5 probes,
all runnable from `char_training/bench`. Kept as the record.

## The exact model (byte-proven)

1. **The rasterizer is plain modern MuPDF** — our fontgen Times rasters are
   its rasters (75% of single-glyph ink pixels byte-exact before step 2 is
   modeled; FT-version differences were already ruled out by the report hunt).
2. **The producer palettized the page**: v4.pdf's page image is an
   `/Indexed /DeviceRGB 255` XObject (816×1056 native — no rescale;
   MediaBox 612×792 → exactly 96 dpi). The 256-entry palette holds only
   **172 neutral (R=G=B) levels** plus colored (hyperlink blue) entries.
3. **The law**: `page = Q(orig)` where `Q(v)` = nearest neutral palette level
   to the original MuPDF byte, **ties toward darker**. Fitted empirically per
   byte value over 566 glyphs / ~23k single-glyph pixels: all 254 observed
   values conform (the 4 apparent exceptions were the available-set being
   polluted by colored-ink sums divisible by 3 — against the true palette
   they conform too).
4. **pdf.js is lossless here**: the raster cache (mode-2 u16 R+G+B sums,
   key `5df5c985891500ac`) is byte-identical to decoding the palette image
   directly — 0 mismatches over 861,696 pixels. No color management applied.

## Reader implementation (`bench/blind-read.mjs --quant`)

- `quantMap(page)`: the available-gray set is read off the (color-flooded)
  page histogram — every actual page byte is present by construction, and
  palette grays are fixpoints of Q, so the page-derived map is self-consistent
  with the palette-derived one. No PDF parsing in the read path.
- The scan canvas stays in ORIGINAL (unquantized) space — the producer
  composited first and quantized once at the end — and every
  prediction-vs-page compare goes through Q (match test, pending test,
  unexplained-ink scan, dust check, blend absorption).
- Composite (kern-junction) pixels: original MuPDF blend, then Q. No extra
  slack needed.

## Result

```
node blind-read.mjs --pdf ../corpus/v4.pdf --tol 0 --quant --union \
  --glyphs glyphs_times16.json,glyphs_timesbd16.json,glyphs_timesi16.json
```

reads every plain-text line **byte-certified at tol 0** — identical text to
the earlier tol-2 read (two independent evidence standards agreeing). The
only flags: one □ fragment on the struck+blue "To:" line (don't-care
content), and the two decorative separator bands (tiny "=", ~8px asterisk
row — want a small-size glyph set someday). Regression: v3
(1785/122,865/2□/1779), report-via-raster (34/2031/2□), big.pdf — all
byte-identical with `--quant` off (it is opt-in).

## Why this generalizes

Palettized page images are common in eDiscovery/scan pipelines (smaller
files). The quant law needs NO per-document fitting: derive availability from
the page, snap predictions. Any future document reading "almost but ±1"
against a proven-rasterizer glyph set should be checked for a palette first
(`/Indexed` in the PDF, or a gappy gray histogram) before hunting rasterizers.

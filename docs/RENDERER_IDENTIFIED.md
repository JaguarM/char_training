# Renderer identified — MuPDF (2026-07-07)

> **Follow-up (same day):** the generalization test (item 7) was run and passed —
> a fully synthetic dictionary now OCRs the real v3.pdf letter-identically to the
> hand-curated dict. Recipe, snap-boundary findings, and pair-composite census in
> [SYNTHETIC_DICT.md](SYNTHETIC_DICT.md).

The open question behind all the rendering research ("who drew the page images?")
is answered, with byte-exact proof: **the page rasters were produced by MuPDF
rendering PDF text — Times New Roman 12 pt — at 96 dpi grayscale** (816×1056 per
US-Letter page; 12 pt @ 96 dpi = the 16 px em we measure). Reproduced locally with
PyMuPDF 1.27: 60/60 sampled glyph windows across all v3 pages byte-identical,
plus template-level and page-level proofs below. Chrome/Skia, pdfium, Quartz,
gamma-correct FreeType and hinted rendering are all ruled out by pixel values
(MAD 7–22 gray levels at the same protocol; MuPDF = 0).

Full evidence chain, tools, and proof images live in the archived ocr
workspace zip (its `NOTES.md` is preserved as
[archive/RENDERER_HUNT_NOTES.md](archive/RENDERER_HUNT_NOTES.md); `tools/one_template.py`
there recreates `B_UPPER_1.png` byte-for-byte — 0/105 pixels differ).

Minimal self-contained repro (needs `pip install pymupdf`):

```python
import fitz, numpy as np
doc = fitz.open(); page = doc.new_page(width=612, height=792)
# pen at pixel (100 + phase, 100): PDF pt = px * 0.75
page.insert_text(fitz.Point(100*0.75, 100*0.75), "B", fontsize=12,
                 fontfile=r"C:\Windows\Fonts\times.ttf", fontname="TNR")
pix = page.get_pixmap(matrix=fitz.Matrix(96/72, 96/72), colorspace=fitz.csGRAY, alpha=False)
a = np.frombuffer(pix.samples, np.uint8).reshape(1056, 816)
print(a[100-11:100+4, 102:109])   # == templates/B_UPPER_1.png byte-for-byte
```

## Corrections to earlier thinking

1. **"Probably Mac or Linux" — dead.** It is not an OS text stack at all; it is a
   PDF rasterizer. Quartz stem-darkening would have left dark-biased residuals —
   the residual analysis shows none.

2. **The Skia shape-check gap (mean |Δ| ≈ 10–40) is now fully expected.** Canvas
   / Path2D AA is simply a different filter from FreeType coverage. Importantly the
   *layout* half of the browser model survives untouched: measureText advances match
   the generator's exactly (e.g. 'A' = 1479/2048×16 = 11.5546875 px). Keep the
   measureText layout model; never use canvas *pixels* as a reference again — render
   synthetic pixels through MuPDF instead.

3. **The ¼-px pen quantization has a mechanism: MuPDF's glyph cache.** Verified by
   sweep: exactly 4 x-buckets per pixel, boundaries at .125/.375/.625/.875 (round to
   nearest quarter). The ±0.03 px "generator-side boundary jitter" is **pre-snap**:
   it lives in the layout coordinates (and in our measurement of them); the drawn
   ink itself sits exactly on the ¼ grid. Consequence: each distinct template raster
   corresponds to exactly ONE phase — B_UPPER_1 matches at phase 0 and at no other
   phase anywhere. anchorRange > 0 on merged kern variants reflects context pooling
   and pre-snap jitter, never raster ambiguity.

4. **y snaps to ½ px in MuPDF.** Corpus baselines are integer (band top + 11,
   confirmed), so integral baselines are a fact about the *source layout*, not the
   rasterizer. Expect possible half-pixel baselines in other documents from the
   same pipeline.

5. **Mode-2 pages.** At PDF storage level, every v3.pdf and (sampled) source.pdf
   page image is single-channel DeviceGray — there is no unequal-channel signal in
   the documents themselves. email.pdf pages 1/36 are DeviceRGB because they contain
   real color: anti-aliased hyperlink blue (R=G<B, e.g. 33,33,239). If the raster
   cache marks any v3/source page mode-2, that is a pdf.js decode artifact worth one
   direct check against a lossless extraction (ocr workspace `tools/extract_pages.py`).

6. **Templates are now generable, not just harvestable.** `ocr` workspace
   `tools/fontgen.py` renders any font through the proven pipeline at all 8
   producible phases (4×x, 2×y) with exact fractional advances. Census: 466/1065
   harvest templates are pure single-glyph cores and regenerate byte-exactly; the
   other 599 are kern-bleed contexts covering 1.2% of occurrences — deterministic
   compositing (page = 255·∏(1−cov)), reproducible by rendering the glyph *pair*.
   The poke-tolerance and stain-tolerance passes compensate for exactly this
   deterministic neighbour compositing; long-term they can be retired in favour of
   composite-aware exact matching.

7. **The pending "generalization test" (TRIM_HANDOFF: a fresh render the harvest
   never saw) is now cheap.** MuPDF renders new oracle pages byte-compatible with
   the corpus: lay out any text with the measureText model, draw at 12 pt / 96 dpi
   gray, and the harvest dictionary must read it at 100.000% — a true held-out test.

8. **Anchor bookkeeping caution.** The `anchor = c0 − rel` definition used by the
   reader is fine, but its integer part depends on where trim cut the window
   (B_UPPER_1's window keeps only columns 2..8 of the 10-px-wide 'B'). When
   aligning a template against a *render*, don't derive the window offset from the
   anchor — recover it by slide + byte-compare (cheap, and absolute).

## What stays valid

The 2026-07-03 research paragraph in tools/README.md was right on every measured
fact: unhinted grayscale TNR 16 px, ¼-px pen quantization, integer baseline =
band top + 11, deterministic byte-identical occurrences. The corrections above
add the *mechanism* (MuPDF/FreeType, gray = 255 − coverage, no gamma) and remove
the wrong candidate hypotheses. The remaining open question is the **layout
producer** (what generated the text PDF that MuPDF rasterized — candidate:
headless Chromium print-to-PDF; the HTML blockquote quote-bars on email.pdf p3
prove the layout stage rendered HTML).

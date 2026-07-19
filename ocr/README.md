# Task: identify the renderer of the NEW/courier block

**SOLVED 2026-07-19 — see `FINDINGS.md`.** MuPDF-lineage renderer, built-in
base-14 Courier = URW Nimbus Mono CFF, em64 791 (12.359375 px) isotropic,
single draw, ¼-px-x / integer-y pens; 113/279 targets byte-EXACT with
`tools/ftclone.mjs` + `tools/sweep-ft.mjs`, remainder pixel-proven to be
neighbor-bleed / drawn-rule composition under the same law. The sections
below describe the original hunt setup (historical).

This folder is standalone and self-contained. One question only:

> **Which rasterizer (program + font file + settings + any resample stage)
> produced the Courier glyph pixels in the 11 `NEW/courier/EFTA0075xxxx.pdf`
> documents — byte for byte?**

You are NOT building an OCR system here and NOT reading whole documents.
Success = a renderer that reproduces the rasters in `targets/` **EXACTLY**
(every byte), verified by `tools/check.mjs`. Once ~20 targets are EXACT with
one method, the method is found — write it down (program/API, font file,
size, flags, resample kernel) in `FINDINGS.md` and stop.

## Trust rule

**Pixels are the only ground truth.** Everything else can be wrong and has
been: the hidden text overlay is the producer's own OCR (misreads, Tz-
stretched word boxes); the parent repo's `NEW/MANIFEST.md` claimed the body
advance was 6.0009765625 px (Courier 10 px em) — the pixels measure
**7.418 px**. Re-derive any number you depend on from `pages/` before
trusting it, including the numbers in this file.

## Setup (once)

```
npm install        # installs the mupdf wasm package used by the JS tools
```

## The documents (established)

11 PDFs in `../NEW/courier/` (7516xx/7543xx/7569xx, 69 pages, all ingested
here). Oracle Outside In / Stellent "PDF Image Export" (`OPBaseFont0/1/2`
font resources): each page is one **816×1056 8-bit DeviceGray Flate image**
(96 DPI digital render, clean 255 background, no scan noise) plus a hidden
Courier ~8.8 pt OCR overlay. MediaBox is `[0 -18 612 792]` — 18 pt of dead
top margin; `ingest.mjs` maps overlay pt → image px through the actual
placement matrix, never assume ×4/3 of raw coords. Content: emails; the body
is a monospace Courier-like face, some header lines are proportional
(Times-like — they fail the lattice fit and are skipped); every page has a
2 px frame (vrules x≈31-33/783-785, rules y≈38/1023) which the tools mask.

## Pixel-measured facts (2026-07-19 prep, re-verifiable from pages/)

- **Cell pitch 7.418 px** (per-band ink-valley fit; q10–q90 = 7.410–7.424
  over 4769 bands, all 11 docs). If the face is Courier New (advance =
  1229/2048 em) that implies **em ≈ 12.361 px ≈ 9.27 pt @96 DPI**.
- x-height 5–6 px, caps ~7 px, stems dark 1–2.5 px (e.g. the 'r' stem is
  bytes 72/90 where unhinted MuPDF at the same em gives 152 — "stems darker
  than the raw outline", same signature the times hunt saw).
- **Partially deterministic**: ~31–43 % of body cells repeat byte-identically
  ≥3× across pages/docs. That is BETWEEN the two known Outside In variants:
  variant A (times, EFTA01150379: near-total repeats on a ¼-px lattice) and
  variant B (arial trio: zero repeats, continuous pens). Phases here are
  quantized but on a finer/other lattice than ¼ px.
- **Byte-lattice fingerprint** (`node tools/levels.mjs`): 245 distinct values,
  BUT 72.7 % of ink bytes sit on the 65-level GGO_GRAY8 lattice and 63.7 %
  even on the 17-level GGO_GRAY4 one, with strong spikes (0, 90, 94, 139,
  183, 211…). A coarse-level rasterizer **plus a resample/blend stage** that
  moves bytes off-lattice fits this; the times family (full 256, latticeless)
  does NOT — this block is a DIFFERENT pipeline from the sister hunt.
- Excluded already (parent repo, byte evidence): MuPDF cour 10/11/12/13/16,
  times13, PIL hinted-FreeType 10. This workspace's own baseline
  `candidates/mupdf` (cour.ttf @ em 12.361) scores **0/279 EXACT**, best
  misses avg ≈ 12/px.
- The sister times hunt (the previous life of this folder — full backup at
  `Desktop/standalone_proj/ocr-times-hunt-2026-07-18.zip`) pinned variant A
  laws: gray = 255−round(cov·256), post-hint ¼-px phases, CVT-fractional
  stems, ~20 engines eliminated (GGO, GDI+, WPF, Java2D, DWrite, GS, stock
  FreeType…). Same producer family, but the fingerprint differs — do NOT
  assume those eliminations transfer; the cheap re-tests are cheap.

## Layout — scales to any number of source-less documents

```
pages/<DOC>/page-NNNN.pgm         producer's raster, byte-exact (P5)
pages/<DOC>/page-NNNN.words.json  overlay word starts + text (labels/context)
pages/<DOC>/meta.json             pdf name, sha256, dims, placement matrix
targets/                          ground truth harvested from pages/
candidates/<name>/<id>.pgm        your renders (one subdir per attempt)
fonts/                            cour/courbd/couri/courbi.ttf (Win11)
```

Add a document (only its PDF needed):
`node tools/ingest.mjs path/to/DOC.pdf` — extracts the embedded page image
directly (no re-render; verified byte-identical to the parent engine's raster
cache), plus the overlay. Then `node tools/harvest.mjs` to re-mine targets.

## Ground truth: `targets/` (279 rasters, 68 chars)

Cut by `tools/harvest.mjs`, pixels-first: per band the lattice (advance AND
phase) is fitted from ink alone (autocorrelation seed → 2-D ink-valley
sweep; boundary columns are the ink minimum). Cells are trimmed to their own
ink rows + 1 white guard row. A cluster is promoted only with **≥3
byte-identical observations and ≥2 distinct neighbor labels on each side**
(word boundary counts as one kind) — diverse-neighbor byte-identity is the
pixel proof that cells abut and the cut is right.

- `ch` labels are overlay **claims** (unanimous, or ≥90 % majority): if your
  renderer matches target 'O' with its '0', believe the pixels — the label
  is wrong, not the raster.
- `index.json` per target: `id` (`<cp>_p<slot>_v<n>`), `ch`, `cp`,
  `phaseSlot` 0-3, `phx` (=slot/4, what the render tools use as pen offset),
  `variant`, `w`, `h`, `adv`, `frac` (mean sub-px cell origin), `obs`,
  `srcs` (doc/page/x/y provenance — every target is re-findable in situ).
- ~3.5 k further repeated clusters failed only the label bar (base64-wall
  overlay junk). More pixel truth to mine if char coverage runs short.

## Your loop

1. Render candidates: `candidates/<name>/<id>.pgm` (any margin, P5 gray;
   attempting a subset — e.g. only `_v1` or one phase slot — is fine).
2. Score: `node tools/check.mjs candidates/<name>` (`--verbose`, or
   `--id <id>` for a side-by-side byte dump).
3. Inspect: `node tools/view.mjs targets/<id>.pgm --num`,
   `node tools/view.mjs pages/<DOC>/page-0001.pgm --crop x,y,w,h`,
   `node tools/levels.mjs`.

## Suggested order of experiments

1. **GGO** (`powershell -File tools/render-ggo.ps1` — defaults Courier New,
   ppem 12; try 13): the lattice bias makes GDI GetGlyphOutline the prime
   *source* suspect. GGO alone can't explain off-lattice bytes or sub-px
   phases — partial shape-exactness would still be the biggest clue so far.
2. **Supersample + downsample**: render at 1.5× (em ≈ 18.54, ppem 18/19 =
   144 DPI) and downsample 2/3 with candidate kernels. Geometry fits
   (1224×1584 → 816×1056) and it explains coarse-lattice bytes getting
   smeared. The arial variant B laws (2/3 cyclostationary resample) are the
   template — but THIS block repeats, so source pens would be integer/coarse.
3. **GDI+** (`tools/render-gdip.ps1`, hints AntiAliasGridFit / AntiAlias).
4. **`tools/render-font.mjs`** knobs on `fonts/cour.ttf` (--ex/--ey embolden,
   --gamma, --q65, --scalex) — separates hinting from the coverage law.
5. `tools/render-mupdf.mjs` as the code template for any new JS candidate.
6. FreeType **bytecode-hinted** harness — rebuild with koffi + a freetype
   DLL (the times session's render-ft lived in a scratchpad and is gone).
7. Oracle **Outside In SDK** itself (OTN login needed) — the producer's own
   engine, highest-value if obtainable.

Try `courbd.ttf` for bold-looking rows, and older-generation Courier font
files if shapes come close but miss — the font FILE is a variable (the times
hunt's TimesNewRomanXP lesson).

## Notes that save time

- check.mjs EXACT tolerates faint (≥250) candidate ink hugging the window,
  flags darker stray ink. Don't fit tolerances — deterministic producer ⇒
  the answer is exact; avg-diff is only a compass.
- `pages/` and words.json are context/labels; iterate against `targets/`.
- `NEW/courier-ez/` reads 100 % with the MAIN engine already (see its
  README) — that's the solved corpus-courier family, not this task.
- `NEW/courier-other/` (2 sparse docs) and `NEW/courier-hard-scaled/`
  (EFTA02154109) are different again — ingest them only if this block's
  solution doesn't transfer.

## Files

```
targets/          279 ground-truth rasters + index.json
pages/            11 ingested docs (69 pages, PGM + overlay words)
fonts/            cour/courbd/couri/courbi.ttf (Win11)
tools/ingest.mjs  add a document: PDF → pages/<DOC>/ (byte-exact)
tools/harvest.mjs pixel-lattice miner: pages/ → targets/
tools/view.mjs    print any PGM (art / numeric / cropped)
tools/check.mjs   score a candidate dir against targets (EXACT = goal)
tools/levels.mjs  byte-lattice fingerprint of the targets
tools/render-mupdf.mjs   failing baseline + JS candidate template
tools/render-ggo.ps1     GDI GetGlyphOutline GRAY8 candidate
tools/render-gdip.ps1    GDI+ DrawString candidate
tools/render-font.mjs    outline rasterizer with embolden/gamma/q65 knobs
tools/render-outline.mjs rasterize GGO-dumped outlines (tools/dump-ggo-outline.ps1)
candidates/       your renders go here (mupdf/ = scored baseline)
```

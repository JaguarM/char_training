# RENDERING.md — how fonts are rendered (every byte-proven pipeline)

The single reference for **how glyph pixels get onto document pages**, for
every producer family this project has byte-certified. `families.mjs` is the
machine-readable mirror of this file (identify.mjs consumes it); the hunt
records named per family are the proving authority. Trust rule applies:
constants here are copies — re-derive from `pages/` pixels when in doubt.

## The shared glyph pipeline (every renderable family)

All byte-exactly-reproducible producers so far are **MuPDF-lineage**: a
FreeType-style outline scan-converter plus MuPDF's blend. The exact pipeline,
certified as a pure-JS clone in `tools/ftclone.mjs` (its self-test = the
certification, 0 byte diffs vs mupdf-wasm across TTF quads AND CFF cubics —
**re-run `node tools/ftclone.mjs` after any edit to it**):

1. **Outline → 26.6 fixed point, unhinted.** Char size 1024 pt, then
   `FT_Set_Transform` with matrix `trunc(trm·64)` (16.16) and pen
   `trunc(pen·64)` (26.6); `FT_LOAD_NO_BITMAP|FT_LOAD_NO_HINTING`. Scaling
   uses `FT_MulFix`/`FT_DivFix` rounding; implicit quad midpoints truncate
   in 26.6.
2. **Coverage AA: ftgrays** (`FT_RENDER_MODE_NORMAL`, FT_INT64 build) —
   line walker + DDA conic + cubic splitter, `area>>9`/`~`/clamp fill rule.
   Result: per-pixel coverage `cov ∈ [0,255]`.
3. **Blend onto the page** (FZ_BLEND, over white 255):
   `dst = (dst·(256−e))>>8` with `e = cov + (cov>>7)`.
   Glyphs, neighbor glyphs, and vector objects (rules, boxes) blend into the
   page **in sequence** — windows overlap at AA edges, which is why isolated
   targets can be byte-exact while page windows show neighbor spill (the
   main engine's pending/composite path handles that; judge a renderer
   config by exacts on isolated targets).
4. **Pen lattice.** x snaps to **¼ px** (round-to-nearest; boundaries
   .125/.375/.625/.875 — MuPDF's glyph-cache subpixel quantization). y snap
   is per-family: **½ px** in the corpus family, **integer** in the
   builtin-font (Nimbus courier) family. mupdf-wasm `fillText` y-snaps round-to-int, so
   it can only produce integer-y rasters ("8-phase oracle" was really 4);
   `ftclone` places pens on any 1/64 — and no proven producer has needed
   fractional y so far. Always **one fill per glyph** (double-draw refuted,
   FINDINGS.md).

The size identifier is **em64 = trunc(em_px·64)** — THE sharp config
parameter (`--scan` spikes at exactly one value for a real config, e.g.
courier at 791 and nowhere else in ±30). Advances come from the font's
design units at that em; layout pens are re-snapped per glyph.

**Rendering a set**: `node ../tools/fontgen.mjs --font <file> --em64 <N>
--phases-y 0 --out ../assets/fonts/<name>_<N>.npz` renders all 4 ¼-px
x-phases through ftclone. Only `--phases-y 0` is producer-certified;
`check-npz.mjs` proves a generated npz byte-identical to harvested page
targets (nimbus_791: 113/113). Never regenerate a legacy corpus `_1` set
expecting byte-identity — those came through the y-rounding wasm pipeline.

## Post-laws (what the producer does after — or instead of — the blend)

| law | page byte | fingerprint / notes |
|---|---|---|
| **standard** (`post: null`) | blend byte unchanged | the corpus MuPDF family and the Nimbus courier block |
| **linear** (eDiscovery) | `+1` for raw byte ∈ [128, 254]; kern overlaps multiply raw bytes in 255-space with floor, +1 per contributing light glyph; deliberate one-sided −1 slack on double-ink pixels only | `../docs/REPORT_RENDERER_HUNT.md`; the `*lin*` sets carry the law tag |
| **mid** (Calibri/Word→JPEG family) | `t + (t>>7) − ((255−t)>>7)`, `t = 255−cov` — every AA byte pushed 1 away from the 127/128 midpoint | **spectral hole at 127/128** is the family fingerprint; per-(doc,page) ±1–2 curve wobble → engine sets are page-byte HARVESTS read at `--tol 2` (`FINDINGS-calibri.md`) |
| **srcover colored/gray ink** | `255 − round(cov·(255−C)/255)`, C = ink gray | same family's gray runs (C 23 body-gray, ~127 letterhead, ~162/166 markings); keeps ±1 quirks — harvest absorbs them |
| **palette quantization** | `Q(composited page)`: nearest available neutral gray, ties darker | `/Indexed` page image / gappy histogram; reads "almost but ±1" against a proven rasterizer → **always check for a palette before hunting renderers**. Engine `--quant` (v4/email-P1 family, `../docs/BLIND_READER.md` 07-12) |
| **JPEG jitter** | true gray ±1 per channel | mode-3 rasters, spread 1–3 = jitter not color; engine `--tol 1` (times color family) |

Compositing order matters: the producer composites glyphs first, applies the
page-level law (palette/JPEG) once at the end — so the engine's scan canvas
stays in original space and only compares route through Q.

## Page model (what surrounds the glyphs)

- **Color pages**: plain black ink is neutral (R=G=B; sum ≡ 0 mod 3);
  ink components connected to non-neutral pixels (hyperlink blue, colored
  letterheads/seals) are flooded to white before reading. Mode-3 rasters
  add per-pixel channel spread: spread ≥4 = real color (flood), 1–3 = JPEG
  jitter (round(sum/3), read at tol 1).
- **Harvest from the reader's view**: whitening changes pixels — colored
  letterhead art is GONE in what the engine sees. `tools/gen-white.mjs`
  materializes that view (`pages/<doc>/white-000N.pgm`); harvest from it,
  not from the raw ingest (the lesson that cost half a calibri session).
- Rules/boxes/underscores are ordinary page objects blended in sequence —
  never a glyph-law problem; the main engine detects and masks them.

## Proven family configs (the registry, human-readable)

Machine form: `families.mjs`. em64/64 = px.

| family | font file | em64 (px) | pens x/y | law | engine set(s) | proven in |
|---|---|---|---|---|---|---|
| corpus MuPDF (Times NR 12pt @96dpi) | Windows times.ttf | 1024 (16) | ¼ / ½ | standard | times16 (+bd/i) | `../docs/RENDERER_IDENTIFIED.md` |
| corpus courier body | Windows cour.ttf | 832 (13) | ¼ / ½ | standard | cour13 | `../docs/BLIND_READER.md` 07-12 |
| eDiscovery report family | Windows times.ttf (+TimesNewRomanXP for tnr8) | 1024 (16) + a 10.667 px small-print set | ¼ / ½ | linear | timeslin16 etc. | `../docs/REPORT_RENDERER_HUNT.md` |
| courier 7516xx block (11 docs; producing program unknown — "Outside In" is an unverified resource-name guess) | NimbusMonoPS-Regular.cff (mupdf builtin base-14) | **791** (12.359375, isotropic) | ¼ / **int** | standard | nimbus791 | `FINDINGS.md` |
| Calibri/Word letterhead family | calibri[b]-jondot.ttf (**version 1.02** — installed 6.2x has different w/x drawings) | 1024, 938 (11pt floor!), 1194 (14pt bold) | ¼ / int | mid + srcover grays | calibri102mid_* + page-cut sets | `FINDINGS-calibri.md` |
| assorted probe sets (arial16, times13, cour10-16, segoe/verdana/georgia 16 …) | Windows faces | various | ¼ / ½ | standard | same names | exported 07-13/14 |

Letterhead furniture the model can't render byte-exactly (Segoe UI strings
at a 2/px model floor, Word bullets) ships as **partition-cut page-byte
sets** (`tools/harvest-band.mjs`): any consistent column partition of a
layout-constant band reproduces byte-exactly at read time — fedline_page,
hdrles_page, ftrfouo_page, bullet16/bullet16b/bulleto16.

## Families with NO byte-exact glyph render (recognize, don't hunt)

- **The 816×1073 trio** (formerly NEW/arial: EFTA02715183, EFTA02609263,
  EFTA02718884 — PDFs since removed from NEW/): **open, and largely
  UNCHARACTERIZED.** What stands: 816×**1073** pages (MediaBox
  612×804.75 pt), zero byte-identical cell repeats across sampled pages
  (⇒ not ¼-px-phase matchable as-is), and every probed pool/size read 0
  lines. What does NOT stand: the producing program is unknown (the 07-17
  "Oracle Outside In variant B" attribution was a guess — no access to
  that software to test), and the faces are **unidentified and not even
  one face**: EFTA02609263 + EFTA02715183 draw a double-story lowercase g,
  EFTA02718884 a single-story g. The 07-17 session's downsample/faux-bold
  "laws" died with its findings doc (lost, and judged wrong 07-20) —
  re-measure everything from pixels if this is ever resumed, and check the
  face identity from glyph shapes FIRST (the Cambria lesson below).
- **Stretched rerender** (EFTA01150379 — hunt CLOSED 2026-07-19, do not
  resume): the page image was stretched by an unknown amount and
  rerendered, and the body face was **Cambria, not Times** (the
  single-story ɡ gave it away). Byte-exact identification was unwinnable by
  construction — every "law" found was a property of the rerender pipeline.
  **Lesson: before any engine hunt, (1) test for resample/stretch
  signatures, (2) verify the face identity from distinctive glyph shapes
  (the g!), never from overlay/name claims.** The empirical tiling-DP
  harvest route (oitimes*_emp sets, since deleted) gave partial reads; full
  record in `Desktop/standalone_proj/ocr-times-hunt-2026-07-18.zip`.

## Fast diagnosis cheat-sheet

| symptom | first suspect |
|---|---|
| almost-reads, everything ±1 | palette quantization (`--quant`), then JPEG jitter (tol 1) |
| page bytes never hit 127/128 | mid law (Calibri family) |
| 0 lines at every plausible em64 of a face | wrong face/size — measure x-height & pitch from pixels; engine-probe sweep (README step 2) |
| exact hits only at fx∈{0,¼,½,¾}, fy=0 | builtin-font family (integer baselines, Nimbus courier class) |
| zero byte-identical cell repeats across pages | continuous pens (816×1073-trio class) — stop, not ¼-px matchable |
| stems 2-col where a candidate gives 1-col; no em satisfies all features | wrong font FILE (Nimbus-vs-Courier class) or a resample stage (Cambria class) |
| line pitch < maxAsc+maxDesc | not a render problem — engine stacked-band machinery (`../docs/BLIND_READER.md` 07-19 eve) |

## Integration recipe

Identified config → engine glyph set → certified reading: the step-by-step
lives in `README.md` § Integration (fontgen → check-npz → export-glyphs →
blind-read → gate).

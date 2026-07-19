# FINDINGS — NEW/courier 7516xx-block renderer IDENTIFIED (2026-07-19)

## The answer

The 11 `EFTA0075xxxx` documents' Courier body glyphs are produced by a
**MuPDF-lineage renderer** (Oracle Outside In's PDF image export embeds one)
with its **built-in base-14 Courier: URW Nimbus Mono (CFF)** — *not* Courier
New — at:

| component   | value |
|-------------|-------|
| font        | `NimbusMonoPS-Regular.cff` (mupdf 1.28 `resources/fonts/urw/` copy = `fonts/NimbusMonoPS-Regular.cff`) |
| em          | matrix coefficient trunc(em·64) = **791** → **12.359375 px** (≈ 9.27 pt @ 96 dpi), **isotropic** |
| pipeline    | FreeType unhinted: char size 1024 pt, `FT_Set_Transform(m=trunc(trm·64) 16.16, v=trunc(pen·64) 26.6)`, `FT_LOAD_NO_BITMAP\|FT_LOAD_NO_HINTING`, `FT_RENDER_MODE_NORMAL` (ftgrays, FT_INT64 build) |
| pen grid    | x snapped to **¼ px** (round-to-nearest), y snapped to **integer px** — same as mupdf 1.28 `fz_subpixel_adjust`; every EXACT hit sits on fx∈{0,¼,½,¾}, fy=0 |
| draws       | **single** fill per glyph |
| blend       | `dst = (dst·(256−e))>>8`, `e = cov + (cov>>7)`, over white 255 (FZ_BLEND / the solved-family eDiscovery law) |
| page model  | glyphs, neighbor glyphs, and vector objects (rules) each blended into the page in sequence — windows overlap at AA edges |

Advance for layout: ~7.4156 px/cell (600/1000 em · 12.359375), pens re-snapped
per cell — matches the measured 7.418 ± 0.007 valley pitch.

## Proof (pixels only)

1. **`tools/ftclone.mjs` is certified**: a pure-JS port of the exact pipeline
   (FT 26.6 scaling with `FT_MulFix`/`FT_DivFix` rounding, FT_Outline_Decompose
   with 26.6 truncated implicit midpoints, ftgrays FT_INT64 line walker + DDA
   conic + cubic splitter, `area>>9`/`~`/clamp fill rule, FZ_BLEND) — **0 byte
   diffs vs mupdf-wasm fillText** across all 68 target chars × 4 phases ×
   2 em configs, for BOTH `fonts/cour.ttf` (TTF/quads) and the Nimbus CFF
   (Type2/cubics). Run: `node tools/ftclone.mjs`.
2. **113/279 targets byte-EXACT** (full window incl. white margins + stray-ink
   border check) at em64 791: `node tools/sweep-ft.mjs --font
   fonts/NimbusMonoPS-Regular.cff --ems 791x791 --draws 1`. Neighboring ems
   789/790/792/793 (and Bold at 790–792): **0** — the em is sharp.
   Every one of the 11 docs contributes exact targets.
3. **The 166 non-exact targets are composition, not renderer error**, verified
   on page pixels:
   - *near* (36, avg<10): neighbor-glyph AA bleeding into shared edge columns.
     E.g. `110_p3_v1` 'n' matches everywhere except its corner byte 249 vs
     isolated 251 — the page shows the left neighbor's serif foot at cov 2 in
     that column, and `(251·(256−2))>>8 = 249` **exactly**.
   - *mid* (115, avg 10–60): same bleed with larger overlaps (both edges/rows).
   - *heavy* (14, avg>60): windows that swallowed **drawn black rules**
     (byte-0 bars with AA edge 187) under/over the glyph, e.g. `109_p3_v1`.
   Reaching 279/279 needs contextual rendering (glyph + neighbors + rules in
   one window) — same law, an evaluation-harness upgrade, not a new unknown.
4. This also resolves the "9 same-weight variants of '-' in one doc > 8"
   paradox: only 4 pen phases exist per glyph; extra byte-distinct variants
   come from differing neighbor spill in the harvested windows.

## Refuted along the way (byte evidence, this session)

- **Courier New (any version)**: with cour.ttf geometry the target hyphen bar
  (41/64 px thick) demands em64y≈700 while the target dot demands ≈816 —
  contradiction. Nimbus Mono satisfies both at 791. XP-era/2.76 cour.ttf
  outlines ('-', '.') are byte-identical to Win11's — font *version* was never
  the variable. (`fonts/cour276.ttf`, extracted from corefonts `courie32.exe`.)
- **Double-draw law**: the "arithmetically proven" stem pairs (152→90 etc.)
  were a coincidence — 90 is simply Nimbus Mono's single-draw stem byte where
  Courier New gives 152. All 113 exacts are single-draw.
- **Anisotropic em (Tz 103%)**: dead; 791×791 isotropic.
- **GGO/GDI, supersample+downsample, stretch kernels**: dead with the above.
- **mupdf fillText y-phases**: `fz_subpixel_adjust` y-rounds to *integer*
  pixels (the 0.5 probe boundary is round-to-int, not floor-to-half) — the old
  "8-phase oracle" was really 4 distinct rasters + shifted copies. fillText
  can therefore never render fractional-y pens; `ftclone` can (and showed the
  producer doesn't use them either: all hits at fy=0).

## Tool map (new this session)

- `tools/ftclone.mjs` — certified FT+ftgrays+blend clone; `FTClone` class
  (TTF + CFF), self-test = certification. **Edit nothing without re-running it.**
- `tools/cff.mjs` — CFF/Type2 outline extractor (gid via mupdf
  `encodeCharacter`).
- `tools/sweep-ft.mjs` — per-target EXACT/SAD hunt over em64 × 64×64 pen
  phases × draws (`--font --ems --draws --sad --sadout --report`).
- `tools/sweep-builtin.mjs` — fillText-based em64y scan with builtin fonts
  (found the 113 first). *(2026-07-19 lab cleanup: superseded one-shot
  probes — this one, probe-snap, pathrender/pathdiff, ftdebug, the GDI/GDI+
  renderers — now live in `tools/attic/`.)*
- `tools/ftres.mjs` — aligned target/candidate/diff dump for one target.
- `tools/probe-snap.mjs`, `tools/pathrender.mjs`, `tools/pathdiff.mjs`,
  `tools/ftdebug.mjs` — the probes that pinned the snap grid and the
  FT-vs-path rasterizer differences.
- `hits-nimbus-791.json` — the 113 exact (id, pen) pairs; `sad-791.json` —
  best-SAD per target at the final config.

## Integration (2026-07-19 eve) — the full reader exists

The "next session" list below became unnecessary: the MAIN engine already
was the contextual compositor. `tools/fontgen.mjs` (main repo, ftclone-
based) rendered the `nimbus791` set (phy 0 only; `tools/check-npz.mjs` here
proves it byte-identical to the 113 exact targets), and with stacked-band
support in `src/ocr-engine.js` (line pitch 12.36 < maxAsc+maxDesc 15 —
band split + judging clamps + fail retro-check, `docs/BLIND_READER.md`
07-19 eve) **all 11 docs read end-to-end with 0 □** — neighbor bleed is the
engine's pending/composite path, rules are objects, per-band pens re-derive
from pixels. Per-doc table: `../NEW/MANIFEST.md`.

Original plan, kept for provenance:

1. Contextual exact test: for each target src, render the whole band
   (all overlay glyphs at fitted ¼-snapped pens + rules) with `FTClone` and
   byte-compare the harvest window in place.
2. Line-fit: per band, fit float x0 so that snap¼(x0 + k·7.4156…) reproduces
   the observed pens (the layout engine's float pen + snap).
3. Rules/underscores are ordinary page objects — extend the compositor, not
   the glyph law.

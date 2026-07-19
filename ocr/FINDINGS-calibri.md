# FINDINGS (open) — NEW/calibri block, started 2026-07-19

Doc under study: `../NEW/calibri/EFTA00038617.pdf` (3 pages, ingested;
sisters EFTA00039797, EFTA01649149 untouched). Status: **OPEN — face, em,
phase lattice, and the byte law are PINNED; rasterizer geometry still ±1
on diagonals/curves.** Everything below is pixel-derived and
re-verifiable; per the trust rule, re-measure before building on it.

## SOLVED 2026-07-19 (session 2)

- **Face = Calibri VERSION 1.02** (Office-2007/Vista era;
  `fonts/cand/calibri-jondot.ttf`, from jondot/dotfiles github). User
  verified 12 pt → em64 1024 (16 px) at this 96 dpi raster; topology and
  probes agree. Windows 6.2x calibri has DIFFERENT drawings for w
  (narrower, SAD 2916) and x (wider); l and a carried over — folder-name
  era probes failed partly because of the WRONG FONT VERSION. Carlito
  refuted (l SAD 343 vs exact).
- **Pen lattice**: all probed glyphs sit on ¼-px x phases (fx 0,16,32),
  fy = 0 (integer baselines) — fillText-class snapping.
- **Byte law ("mid" law)**: page byte = clamp(t + (t>>7) − ((255−t)>>7)),
  t = 255 − ftgrays coverage. I.e. AA bytes move 1 AWAY from the 127/128
  midpoint. Fitted on the l anchors, then verified page-wide by its
  spectral hole: bytes 127 and 128 occur ZERO times in body text on all 3
  pages (126/129 occur hundreds of times each). The courier-era "linear
  +1 for 128..253" law is this law's bright half seen through the mupdf
  blend; boundary is really 254 (254→255 confirmed on the l).
- **'l' is byte-EXACT** (full window incl. margins, SAD 0) under
  calibri-1.02 + em64 1024 + fx0 fy0 + mid-law via ftclone coverage.
- 21 px pitch = Word 1.08 line-spacing multiple of Calibri's 1.22 em
  spacing at 12 pt (19.53 × 1.08 = 21.09) — Word-family layout.

## DETERMINISM PROVEN (repeat-check.mjs, P1)

Every (glyph, ¼-phase) occurrence on the page is BYTE-IDENTICAL to every
other: e|fx16 ×20 → 1 raster, e|fx32 ×23 → 1, o/s/w all phases → 1 each.
The ftclone+midlaw residual SAD is CONSTANT per (glyph, phase) (e≈13,
s≈8–15, w≈18–23). Producer = deterministic f(gid, fx∈{0,16,32,48}), fy=0.

⇒ **Harvest path is valid**: locate glyphs with ftclone+midlaw candidates
(SAD ≤ ~45 + white-margin check — already reliable in repeat-check), then
record PAGE bytes as the template for (gid, phase); cross-instance
agreement is the certification. 4 rasters per glyph cover the whole doc;
unharvested rare (glyph, phase) slots fall back to ftclone+midlaw
(SAD ≤ ~25) until the ±1 curve law falls. This is the Outside In
harvester precedent, but proportional and law-anchored.

## OPEN — the last gap (geometry)

At best phases, remaining SAD under mid-law: a=11, x=15, w=18 (l=0).
Residuals are ±1 coverage quanta on DIAGONAL and CURVED edges only
(verticals exact everywhere); page slightly darker on average; faintest
AA (cov 1–2) sometimes absent. Eliminated as the source, all at em64
1024 full 64×64 pen lattice: mupdf/ftclone (certified equal to real
fillText), FT 2.4.12 walkers (scanline+bisect+neg port: worse), FT
2.6–2.9 (prod+bisect+~), exact-vs-reciprocal FT_UDIV, fractional em
(±2 em64 in 1/32 steps, x and y), 26.8-direct outline precision,
poppler 24.08 splash AND cairo backends (SAD 60 on real renders of a
sweep PDF), DirectWrite natural modes (alpha textures are 6-level
quantized — cannot make the page's continuous values), GDI (integer
pens only), GDI+ AntiAlias (SAD 1116, soft), Java2D JDK-11 (integer
snapping + hinted), PDFium wasm (SAD 1645).

## Hunt tools added (attic)

- `lattice-lut-probe.mjs` — full-lattice pen sweep vs page cut, mid-law.
- `fine-scale-sweep.mjs` — fractional-em64 sweep.
- `rastold.mjs` — toggleable FT walkers (line old/prod, conic
  bisect/dda, sign neg/not, div recip/exact, prec 26.6/26.8).
- `mupdf-direct.mjs` — real fillText vs page cut.
- `pdf-sweep.mjs` + `sweep-compare.mjs` — synthetic sub-pixel sweep PDF
  for real external renderers; `png2pgm.mjs`.
- `render-dwrite.ps1` (COM glyph-run analysis), `render-gdip2.ps1`
  (private-font grid sweep) + `grid-compare.mjs`, `DrawSweep.java`.
- `stem-survey.mjs` (fringe statistics), `dump-covmap.mjs` (cov→byte
  scatter + Δcov grids), `calibri-topo.mjs`, `font-version.mjs`.
- Anchor cuts on P1: l 513,271,5,16 / a 517,274,8,13 / x 162,296,8,10 /
  w 524,274,14,13 (cps 108/97/120/119, gids 367/258/454/449).

## Established (pixels)

- Pages: 816×1056, embedded 3-component image. Colored ink ONLY in the
  letterhead band y 60–150 (banner/graphic) — NOT ClearType; body text is
  neutral (R=G=B), so the gray reduction in ingest is lossless there.
- Body: full-AA grayscale (161 distinct ink values, 8.6 % zeros — not
  hinted-black-heavy), line pitch **21 px**, ink span per line ~14 px,
  x-height ≈ 7 px, digit height ≈ 10 px ⇒ em ≈ 14–16 px. Pitch/em does NOT
  fit Calibri's default 1.22 line spacing — the layout is not the face
  default (extra leading, or a different face).
- "calibri" is a FOLDER-NAME GUESS, never verified from glyph shapes.

## Eliminated (byte evidence, engine-probe sweeps 2026-07-19)

- All 14 registered families (identify.mjs) — though note the targets used
  were proportional FRAGMENTS (see below), so only the engine probes count:
- **Windows calibri.ttf through the certified unhinted-mupdf pipeline
  (ftclone ≡ fontgen), em64 832–1120 (13.0–17.5 px), fy {0} and {0, ½},
  ¼-px x pens: ZERO lines read on P1 at every em.** Method: fontgen
  `--chars <64 common>` npz per em64 + `blind-read --page 1 --glyphs
  <npz>` (byte-exact, cannot false-positive).

## Trap logged

`harvest.mjs` is monospace-only: on this doc it emitted 130 byte-identical
clusters (`targets-calibri/`) that are glyph FRAGMENTS on a bogus 5.64 px
lattice — do not scan against them. Engine probes are the tester until a
proportional harvester exists.

## Next steps, in order (rewritten 2026-07-19 eve — steps 1–3 of the old
## list are DONE: face verified = calibri 1.02, pipeline characterized)

1. Build the proportional harvester (new tool, NOT harvest.mjs): scan all
   3 pages with ftclone(calibri-1.02)+midlaw candidates for the full
   charset × 4 phases; require white margins + cross-instance byte
   agreement; emit a (gid, fx) → page-bytes template set (npz, engine
   format). Include digits/punctuation; log unfilled slots.
2. Wire into blind-read as the calibri16-mid family: harvested templates
   first, ftclone+midlaw synthetic (exact for straight-edge glyphs like
   l/i/I/t) for unfilled slots; certify P1–P3 line counts, then the two
   sister docs (same producer assumed — verify 127/128 hole first).
3. families.mjs entry: pageLaw/renderable hybrid — font calibri 1.02
   (fonts/cand/calibri-jondot.ttf), em64 1024, fx ¼-lattice, fy [0],
   post 'mid' (cov law, NOT the old byte linA), plus harvested-template
   pointer. Note the 127/128 spectral-hole fingerprint for identify.mjs.
4. OPEN RESEARCH (nice-to-have): the ±1 curve/slant law — everything
   eliminated is in "OPEN — the last gap" below; next untried ideas:
   fit per-chord Δ against DDA t-grid phase; try FT 2.5/2.6.0 exact
   sources; check if residuals vanish at em64 2048 (32px — sisters may
   differ in size and discriminate harder).

# FINDINGS (open) — NEW/calibri block, started 2026-07-19

Doc under study: `../NEW/calibri/EFTA00038617.pdf` (3 pages, ingested;
sisters EFTA00039797, EFTA01649149 untouched). Status: **OPEN — no
renderer identified yet.** Everything below is pixel-derived and
re-verifiable; per the trust rule, re-measure before building on it.

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

## Next steps, in order

1. Verify the FACE from pixels: crop distinctive lowercase ('a' 'g' 'l'
   't' terminals) at high zoom (`view.mjs --crop --num`) and compare
   against candidate sans faces (calibri, carlito, segoeui, arial,
   tahoma, verdana renders at matching x-height). The Cambria lesson:
   folder names lie.
2. If face confirmed ≠ calibri: rerun the engine-probe em sweep with the
   right face (commands above, ~10 min).
3. If face IS calibri: the pipeline is new — suspects: hinted rasterizers
   (GDI/DWrite grayscale — attic has GGO/GDI+ probe templates),
   supersample+downsample (the variant-B law class), or a non-Windows
   calibri clone (Carlito!). sweep-ft full-lattice + --sad on hand-cut
   single glyphs is the compass.
4. Whatever falls: families.mjs entry + promote this file to the hunt's
   record (FINDINGS.md stays the courier record).

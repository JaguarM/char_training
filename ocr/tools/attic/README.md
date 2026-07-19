# attic/ — one-shot probes from finished hunts

Refuted-hypothesis renderers and single-purpose probes, kept for provenance
(FINDINGS.md references some by name). Nothing here is part of the live
pipeline; the certified path is `ftclone.mjs` + `sweep-ft.mjs` +
`identify.mjs` one level up. Highlights:

- `render-ggo.ps1` / `render-gdip.ps1` / `dump-ggo-*.ps1` / `render-outline.mjs`
  — GDI GetGlyphOutline / GDI+ candidates (refuted for the courier block).
- `sweep-builtin.mjs` — fillText-based em scan (found the 113 first;
  superseded by the full-lattice `sweep-ft.mjs`).
- `probe-snap.mjs` / `ftdebug.mjs` / `pathrender.mjs` / `pathdiff.mjs` /
  `residual.mjs` — the probes that pinned fillText's pen-snap grid
  (¼-px x, round-to-int y) and the FT-vs-path rasterizer differences.
- `render-font.mjs` + `rastlib.mjs` / `render-stretch.mjs` / `render-mupdf*.mjs`
  — embolden/gamma/stretch/mupdf hypothesis renderers.

// families.mjs — THE registry of proven producer families. Everything this
// project has byte-certified about how document rasters get made, as data:
// `identify.mjs` tries every renderable entry automatically against
// harvested targets, so a new hunt starts from all known answers instead of
// from a blank page (or from whatever a human remembers to paste in).
//
// Add a family the moment it is byte-proven; point `record` at the document
// that proves it. Constants here are COPIES for machine use — the proving
// documents remain the authority (trust rule: re-derive from pixels when in
// doubt).
//
// Two kinds of entries:
//   renderable: a glyph-level config ftclone can reproduce byte-for-byte —
//     { font, em64, fy, gid, post } (fx is always the ¼-px lattice
//     [0,16,32,48]/64; draws always 1 — double-draw was refuted, see
//     FINDINGS.md).
//     gid: 'cmap' (TTF, ttf.mjs resolves cp itself) | 'mupdf' (CFF — gid map
//     via mupdf encodeCharacter on the same bytes).
//     post: byte remap applied AFTER the blend, page-space:
//       null     — page byte = blend byte (the standard MuPDF families)
//       'linear' — the eDiscovery producer: +1 for bytes 128..253
//                  (docs/REPORT_RENDERER_HUNT.md)
//   pageLaw: no per-glyph render — a page-level transform or a producer the
//     ¼-px engine cannot match; carries the fingerprint that identifies it
//     and where the laws live.
//
// fy values are 1/64 px: [0] = integer baselines (Outside In / builtin
// Courier — the only mode fillText can even produce, y-snap is
// round-to-int); [0, 32] also tries true ½-px baselines (the corpus-era
// model). The exact test is bbox-aligned (shift-invariant), so fy variants
// only matter when they change the RASTER, not the placement.

const WIN = 'C:/Windows/Fonts';

export const FAMILIES = [
  // ---- MuPDF @ 96dpi on Windows faces (the corpus family) ----
  // Proven: docs/RENDERER_IDENTIFIED.md (v3/big = times16), BLIND_READER.md
  // 07-12 (courier_1/2 = cour13). Engine sets of the same name exist for all.
  { name: 'times16', renderable: true, font: `${WIN}/times.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'times16', record: '../docs/RENDERER_IDENTIFIED.md' },
  { name: 'times16-linear', renderable: true, font: `${WIN}/times.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: 'linear',
    engineSet: 'timeslin16', record: '../docs/REPORT_RENDERER_HUNT.md (eDiscovery +1 law)' },
  { name: 'times13', renderable: true, font: `${WIN}/times.ttf`, em64: 832, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'times13', record: 'NEW/MANIFEST.md 07-14' },
  { name: 'cour13', renderable: true, font: `${WIN}/cour.ttf`, em64: 832, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'cour13', record: '../docs/BLIND_READER.md 07-12 courier' },
  { name: 'cour16', renderable: true, font: `${WIN}/cour.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'cour16', record: 'exported 07-13' },
  { name: 'cour12', renderable: true, font: `${WIN}/cour.ttf`, em64: 768, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'cour12', record: 'exported 07-14' },
  { name: 'cour11', renderable: true, font: `${WIN}/cour.ttf`, em64: 704, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'cour11', record: 'exported 07-14' },
  { name: 'cour10', renderable: true, font: `${WIN}/cour.ttf`, em64: 640, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'cour10', record: 'exported 07-14' },
  { name: 'arial16', renderable: true, font: `${WIN}/arial.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'arial16', record: 'NEW/MANIFEST.md (EFTA00161526 body)' },
  { name: 'calibri16', renderable: true, font: `${WIN}/calibri.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'calibri16', record: 'exported 07-13' },
  { name: 'segoeui16', renderable: true, font: `${WIN}/segoeui.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'segoeui16', record: 'exported 07-13' },
  { name: 'verdana16', renderable: true, font: `${WIN}/verdana.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'verdana16', record: 'exported 07-13' },
  { name: 'georgia16', renderable: true, font: `${WIN}/georgia.ttf`, em64: 1024, fy: [0, 32], gid: 'cmap', post: null,
    engineSet: 'georgia16', record: 'exported 07-13' },

  // ---- Outside In "PDF Image Export" with mupdf builtin base-14 faces ----
  // Proven: FINDINGS.md 2026-07-19 — the 7516xx/7543xx/7569xx courier block.
  // em64 791 = 12.359375 px isotropic, ¼-px-x / INTEGER-y pens, single draw.
  // Non-exact remainders on real pages are neighbor-AA / drawn-rule
  // composition under the same blend law — the engine handles that; judge a
  // family by its exact count, not by reaching 100 % on harvested windows.
  { name: 'nimbus791', renderable: true, font: 'fonts/NimbusMonoPS-Regular.cff', em64: 791, fy: [0], gid: 'mupdf', post: null,
    engineSet: 'nimbus791', record: 'FINDINGS.md' },

  // ---- page-law families (no glyph render to try — recognize by fingerprint) ----
  { name: 'palette-quant', renderable: false,
    fingerprint: 'few distinct page bytes (<~64); reads "almost but ±1" against a proven rasterizer',
    action: 'main engine --quant (page byte = nearest available gray, ties darker); v4/email-P1 family',
    record: '../docs/BLIND_READER.md 07-12 PM + late' },
  { name: 'jpeg-jitter', renderable: false,
    fingerprint: 'mode-3 color rasters, ±1 channel jitter on ink, blue mailto links',
    action: 'main engine --tol 1 on mode-3 rasters (times color family)',
    record: 'NEW/MANIFEST.md 07-14' },
  { name: 'outside-in-arialB', renderable: false,
    fingerprint: '816×1073 pages, CONTINUOUS pen lattice (zero byte-identical cell repeats), faux-bold headers',
    action: 'NOT matchable by the ¼-px engine: 144dpi render → 2/3 cyclostationary downsample; open problem',
    record: '../docs/OUTSIDE_IN_ARIAL.md' },
];

// Plausible em64 range for --scan when nothing above matches: ~7px to ~20px
// glyphs cover every text size seen so far (spikes worth trying first:
// trunc(pt·96/72·64) for common pt sizes).
export const SCAN_DEFAULT = { from: 448, to: 1280 };

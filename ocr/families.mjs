// families.mjs — THE registry of proven producer families. Everything this
// project has byte-certified about how document rasters get made, as data:
// `identify.mjs` tries every renderable entry automatically against
// harvested targets, so a new hunt starts from all known answers instead of
// from a blank page (or from whatever a human remembers to paste in).
// Human-readable companion: RENDERING.md (the full pipeline + post-law +
// diagnosis reference this registry mirrors).
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
// fy values are 1/64 px: [0] = integer baselines (the builtin-Courier
// family — the only mode fillText can even produce, y-snap is
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

  // ---- Word→JPEG letterheads on Calibri VERSION 1.02 (Office-2007 era) ----
  // Proven: FINDINGS-calibri.md (NEW/calibri EFTA00038617 + EFTA01649149 read
  // 0 □). Face is calibri 1.02 — the installed 6.2x has DIFFERENT w/x
  // drawings — through the "mid" law: byte = t + (t>>7) − ((255−t)>>7),
  // t = 255−cov (every AA byte pushed 1 away from the 127/128 midpoint;
  // spectral hole at 127/128 is the family fingerprint). ¼-px x pens, integer
  // baselines, per-(doc,page) ±1-2 curve wobble → engine sets are page-byte
  // HARVESTS (harvest-prop.mjs) at --tol 2, synthetic mid-law fallback.
  // Colored runs use the srcover analog: byte = 255 − round(cov·(255−C)/255)
  // (C = ink gray; C 23 body-gray runs, 127 letterhead, 162/166 markings).
  { name: 'calibri102-16', renderable: true, font: 'fonts/cand/calibri-jondot.ttf', em64: 1024, fy: [0], gid: 'cmap', post: null,
    engineSet: 'calibri102mid_1024', record: 'FINDINGS-calibri.md (mid law lives in harvest-prop.mjs covLaw)' },
  { name: 'calibri102-11pt', renderable: true, font: 'fonts/cand/calibri-jondot.ttf', em64: 938, fy: [0], gid: 'cmap', post: null,
    engineSet: 'calibri102mid_938', record: 'FINDINGS-calibri.md ("Approved by" letterhead line)' },
  { name: 'calibrib102-16', renderable: true, font: 'fonts/cand/calibrib-jondot.ttf', em64: 1024, fy: [0], gid: 'cmap', post: null,
    engineSet: 'calibrib102mid_1024', record: 'FINDINGS-calibri.md (bold headings)' },
  { name: 'calibrib102-14pt', renderable: true, font: 'fonts/cand/calibrib-jondot.ttf', em64: 1194, fy: [0], gid: 'cmap', post: null,
    engineSet: 'calibrib102mid_1194', record: 'FINDINGS-calibri.md (14pt bold title)' },
  // Letterhead furniture the model can't render byte-exactly (Segoe UI
  // strings at 2/px model floor, Word list bullets): partition-cut page-byte
  // sets from harvest-band.mjs — fedline_page, hdrles_page, ftrfouo_page,
  // bullet16/bullet16b/bulleto16. Layout-constant across the family.

  // ---- MuPDF-lineage renderer with builtin base-14 faces (7516xx block) ----
  // (Producing program unidentified — "Oracle Outside In" was a guess from
  // font resource names; only the render law below is byte-proven.)
  // Proven: FINDINGS.md 2026-07-19 — the 7516xx/7543xx/7569xx courier block.
  // em64 791 = 12.359375 px isotropic, ¼-px-x / INTEGER-y pens, single draw.
  // Non-exact remainders on real pages are neighbor-AA / drawn-rule
  // composition under the same blend law — the engine handles that; judge a
  // family by its exact count, not by reaching 100 % on harvested windows.
  { name: 'nimbus791', renderable: true, font: 'fonts/NimbusMonoPS-Regular.cff', em64: 791, fy: [0], gid: 'mupdf', post: null,
    engineSet: 'nimbus791', record: 'FINDINGS.md' },

  // ---- eDiscovery serif family: builtin Nimbus + linear[128,254] + palette ----
  // Proven: FINDINGS-nimbusrom.md 2026-07-20 (EFTA00039208, 12 pages, 13034
  // glyphs read at tol 0). Pipeline: ftclone blend → linear +1 on raw byte ∈
  // [128,254] (NOT the report family's 128..253 — raw 254/cov-1 pixels become
  // WHITE) → per-page /Indexed palette: RGB-nearest entry (full palette
  // including non-neutral entries, ties darker), page gray = round(mean).
  // ¼-px x pens, INTEGER y. Unembedded base-14 → URW builtins at these em64s;
  // EMBEDDED fonts (real TNR subset: ■ bullets, curly quotes) render directly
  // at the same pens. Reader: blind-read --palette (per-page LUT from the
  // PDF), tol 0.
  { name: 'nimbusromlin1024', renderable: true, font: 'fonts/NimbusRoman-Regular.cff', em64: 1024, fy: [0], gid: 'mupdf', post: 'linear254',
    engineSet: 'nimbusromlin1024', record: 'FINDINGS-nimbusrom.md (body 12pt)' },
  { name: 'nimbusrombdlin1024', renderable: true, font: 'fonts/NimbusRoman-Bold.cff', em64: 1024, fy: [0], gid: 'mupdf', post: 'linear254',
    engineSet: 'nimbusrombdlin1024', record: 'FINDINGS-nimbusrom.md (bold + letterhead)' },
  { name: 'nimbusromlin983', renderable: true, font: 'fonts/NimbusRoman-Regular.cff', em64: 983, fy: [0], gid: 'mupdf', post: 'linear254',
    engineSet: 'nimbusromlin983', record: 'FINDINGS-nimbusrom.md (OPI/NUMBER header block)' },
  { name: 'nimbusromilin1024', renderable: true, font: 'fonts/NimbusRoman-Italic.cff', em64: 1024, fy: [0], gid: 'mupdf', post: 'linear254',
    engineSet: 'nimbusromilin1024', record: 'FINDINGS-nimbusrom.md (italic body)' },
  { name: 'nimbusrombdlin1194', renderable: true, font: 'fonts/NimbusRoman-Bold.cff', em64: 1194, fy: [0], gid: 'mupdf', post: 'linear254',
    engineSet: 'nimbusrombdlin1194', record: 'FINDINGS-nimbusrom.md ("P R O G R A M  S T A T E M E N T")' },
  { name: 'nimbussansbdlin1536', renderable: true, font: 'fonts/NimbusSans-Bold.cff', em64: 1536, fy: [0], gid: 'mupdf', post: 'linear254',
    engineSet: 'nimbussansbdlin1536', record: 'FINDINGS-nimbusrom.md (18pt cover title)' },
  { name: 'tnrlin1024', renderable: true, font: `${WIN}/times.ttf`, em64: 1024, fy: [0], gid: 'cmap', post: 'linear254',
    engineSet: 'tnrlin1024', record: 'FINDINGS-nimbusrom.md (embedded REAL TNR subset: ■ + ’ “ ”)' },
  // Sub-family #2 of the same palette container (court/ECF filings): NO
  // linear step — post: null + per-page palette. One sub-family per
  // SOURCE-document producer; body face here is Century Schoolbook.
  { name: 'censcbk1198', renderable: true, font: `${WIN}/CENSCBK.TTF`, em64: 1198, fy: [0], gid: 'cmap', post: null,
    engineSet: 'censcbk1198', record: 'FINDINGS-nimbusrom.md §sub-family 2 (EFTA00093044 brief body, EXACT)' },

  // ---- page-law families (no glyph render to try — recognize by fingerprint) ----
  { name: 'palette-quant', renderable: false,
    fingerprint: 'few distinct page bytes (<~64); reads "almost but ±1" against a proven rasterizer',
    action: 'main engine --quant (page byte = nearest available gray, ties darker); v4/email-P1 family',
    record: '../docs/BLIND_READER.md 07-12 PM + late' },
  { name: 'jpeg-jitter', renderable: false,
    fingerprint: 'mode-3 color rasters, ±1 channel jitter on ink, blue mailto links',
    action: 'main engine --tol 1 on mode-3 rasters (times color family)',
    record: 'NEW/MANIFEST.md 07-14' },
  { name: 'unknown-816x1073', renderable: false,
    fingerprint: '816×1073 pages (MediaBox 612×804.75pt), CONTINUOUS pen lattice (zero byte-identical cell repeats)',
    action: 'NOT matchable by the ¼-px engine as-is; producer AND faces unidentified (the trio mixes g-shapes: ≥2 faces) — verify face from glyph shapes before any hunt; open problem',
    record: 'RENDERING.md open-families note + NEW/MANIFEST.md §arial (07-17 findings doc lost, judged wrong 07-20)' },
  { name: 'stretched-rerender', renderable: false,
    fingerprint: 'no em64 satisfies all glyph features; stem widths CVT-fractional; face shapes contradict the overlay name (EFTA01150379: Cambria single-story ɡ under a "Times" overlay)',
    action: 'HUNT CLOSED (2026-07-19, user-verified from source): page image stretched by an unknown amount and rerendered — byte-exact identification unwinnable by construction. Recognize and STOP; empirical per-doc harvest is the only pixel route',
    record: 'RENDERING.md closed-families section; full record in Desktop/standalone_proj/ocr-times-hunt-2026-07-18.zip' },
];

// Plausible em64 range for --scan when nothing above matches: ~7px to ~20px
// glyphs cover every text size seen so far (spikes worth trying first:
// trunc(pt·96/72·64) for common pt sizes).
export const SCAN_DEFAULT = { from: 448, to: 1280 };

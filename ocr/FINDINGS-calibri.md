# FINDINGS — NEW/calibri block, started 2026-07-19

## STATUS: SOLVED 2026-07-19 (session 4) — BOTH DOCS READ 0 □

`EFTA00038617.pdf` and `EFTA01649149.pdf` (3 pages each) read **100 %:
0 unreadable clusters, 0 box fragments** at `--tol 2`, gate 6/6
byte-identical, engine unit tests 22/22. Read command (bench):

```
node tools/blind-read.mjs --pdf NEW/calibri/EFTA00038617.pdf --all --tol 2 \
  --glyphs "assets/fonts/calibri102mid_1024.npz+assets/fonts/calibrib102mid_1024.npz+assets/fonts/calibri102g23_1024.npz+assets/fonts/bullet16.npz+assets/fonts/bullet16b.npz+assets/fonts/bulleto16.npz,assets/fonts/calibri102mid_938.npz,assets/fonts/calibrib102mid_1194.npz,assets/fonts/fedline_page.npz,assets/fonts/hdrles_page.npz,assets/fonts/ftrfouo_page.npz"
```

('+' = one union pool, mirrors the app's same-sizePx auto-union; ',' = per-band
candidates.) Certified transcripts: `NEW/calibri/<doc>.txt`.

## The full content model (what 100 % required)

Per-band inventory — every item below was measured off the pixels:

| run | face / source | em64 | ink | set (assets/fonts/) |
|---|---|---|---|---|
| body text | Calibri **1.02** | 1024 | black midlaw | calibri102mid_1024 (harvested) |
| body gray runs (P2 "Bill Clinton", "On July 29" ¶) | Calibri 1.02 | 1024 | gray ≈23 srcover | calibri102g23_1024 (harvested, `harvest-prop --c 23`) |
| bold headings, "not public knowledge" | Calibri **Bold** 1.02 | 1024 | black | calibrib102mid_1024 |
| title "Epstein Investigation Summary…" | Calibri Bold 1.02 | **1194** (14 pt) | black | calibrib102mid_1194 |
| "Approved by CID A/AD…" | Calibri 1.02 regular | **938** (11 pt, FLOOR of 938.67) | black | calibri102mid_938 |
| FEDERAL BUREAU OF INVESTIGATION | **Segoe UI** 10 pt (853) | — | gray ≈127 | fedline_page (partition-cut) |
| UNCLASSIFIED//LES header | Segoe-like ~8.5 pt, model floor 2/px | — | gray ≈162 | hdrles_page (partition-cut) |
| UNCLASSIFIED//FOUO footer | same | — | gray ≈162 | ftrfouo_page (partition-cut) |
| '•' list bullets (2 phase states!) | Word bullet | — | black | bullet16 + bullet16b |
| 'o' level-2 bullet | Courier-style | — | black | bulleto16 |
| CID caps line + seal + rules | **colored** → whitened away | — | — | (invisible to reader) |
| seal residue | neutral specks/ghosts | — | — | engine dust/ghost mask |

Fonts: `fonts/cand/calibri[b|i|z]-jondot.ttf` — all four styles v1.02 fetched
from jondot/dotfiles, version strings verified. The installed 6.2x Calibri has
different w/x drawings (session-2 result); Carlito refuted.

- 21 px body pitch = Calibri 1.22 spacing × Word 1.08 default. 11 pt em64 is
  **floor**(938.67) = 938 (pinned by 'd' probe: em938 SAD 14 vs em939 SAD 77).
  14 pt bold = 1194 (23 harvest slots vs 1 at 1195).
- Byte law ("mid"): byte = t + (t>>7) − ((255−t)>>7), t = 255−cov. 127/128
  spectral hole = family fingerprint. Colored runs: srcover analog
  byte = 255 − round(cov·(255−C)/255), C = ink gray; observed C: 23 (body
  gray, with a −2 dip near full coverage: page bytes 22/24), ~127 (FEDERAL),
  ~162 (CRIMINAL, whitened anyway), ~166 (UNCLASS marks). The gray law keeps
  ±1 quirks — harvested page bytes absorb them, candidates gate at |Δ|≤4.
- Determinism stays PER (doc,page) (session 3); consensus is **midrange**
  (not median) so every instance stays within tol 2, and inked pixels never
  round up to 255 (an all-white template pixel can never explain page ink).

## Reader-view lesson (cost half a session)

**Harvest from what the READER sees.** The pages are color JPEGs; blind-read
whitens colored + flood-connected ink (mode-3). The letterhead seal, CRIMINAL
line and rules are colored → GONE in the reader view; FEDERAL/UNCLASS survive
but with jitter pixels neutralized differently than the id-lab pgm ingest.
`tools/gen-white.mjs` materializes the reader view as
`pages/<doc>/white-000N.pgm`; `harvest-band --prefix white` cuts from it.

## New tools

- `tools/harvest-band.mjs` — transcription-anchored PARTITION-CUT harvester
  for layout-constant bands (letterhead strings whose glyphs touch, bullets):
  any consistent column partition of a recurring band reproduces byte-exactly
  at read time. Boundaries: white gaps → advance-weighted cuts snapped to ink
  valleys; faint-only (≥244) lead columns attach to the PREVIOUS glyph (a
  template anchored on a faint column misaligns when the scan absorbs that
  column — the ION 'O' lesson). Repeated chars land in ¼-phase slots (≤4).
- `tools/gen-white.mjs` — reader-view pgm materializer (above).
- `tools/graylaw.mjs` — cov→byte scatter fitter for colored runs.
- `tools/attic/fy-probe.mjs` — single-glyph (em64, fx, fy, C) pen-lattice probe
  with ±3 slide; the workhorse for face/size/color identification.
- `harvest-prop.mjs` gained `--c <gray>` (srcover candidates, adaptive seed).

## Engine changes (src/ocr-engine.js — gate 6/6 byte-identical, tests 22/22)

1. **Dust & ghost mask** (detectObjects): ghost CCs (min ≥ 244, any size) and
   isolated ≤4×4 speck CCs are masked. Isolation is transitive (ellipsis dots
   chain to their word) and object-aware (a period beside a redaction box has
   only masked neighbours — the email/courier gate docs read such periods).
   Isolated DARK smalls only mask in swarms (≥4 chained ≤12 px) — a lone
   period after a whitened hyperlink stays readable.
2. **dustOnly unread bands** (readPage): an unread band whose ink is ≤12 px of
   ≤4-px runs, sparse over its bbox (or ≤2 px), is graphic residue → emit
   nothing (the honest-□ unit test's dense blob stays a □).
3. **Deeper second-chance baseline sweep**: bands whose bottom is stretched by
   sub-baseline junk (box fringe under "Jean Luc Brunel") get 3 extra rows of
   baseline probes — only after the primary sweep failed, so existing picks
   are untouched.
4. **Box-extent overhang absorb** (segment voter): a text line kerned tight
   against a box bridges EVERY x-height row (8+, over the short-burst cap);
   such a burst is a strict right-superset of its neighbours' extent and now
   absorbs at any height — "[box]Bill Clinton" reads its 'B'.
5. **tools/glyph-bundle.mjs**: COV[127] filled (the mid-law spectral hole —
   alpha was 0, blend predicted white, gray-127 stems went eternally
   unexplained; nearest-coverage predicts 128, inside the tol-2 regime).

## Open

- `EFTA00039797` (was listed under calibri/): its 1-page raster survives in
  cache 6d285189c0ea55f5 (PDF itself absent from the repo). Shares the FBI
  letterhead (9 lines read via the page-cut sets) but the body "From:" face
  matches NEITHER Calibri (any style/em) nor Segoe/Arial/Tahoma/Verdana bolds
  (best 10.6/px) — different producer, future hunt. pages/EFTA00039797/
  keeps the materialized pgm.
- Letterhead word-spacing cosmetics: FEDERAL line reads all glyphs but the
  measured per-char advances make 1-2 word gaps drift ("FE DERAL"-class
  spacing in some runs); characters and order are exact.
- The ±1 conic law (why ftclone's curves differ ±1 quantum from the producer)
  stays open as pure research — harvesting made it moot for reading.
- Session-1/2/3 history (probe eliminations, determinism proofs, per-page
  state analysis) lives in git history of this file; the constants above are
  the surviving truth.

# Fully synthetic template dictionary — proven (2026-07-07)

**Answer to "can we OCR with completely synthetic templates?": yes.**
`templates_full_synth/` (1975 templates + exact metrics) contains **no pixel
from any corpus document** — every byte is a MuPDF render of Times New Roman
12 pt @ 96 dpi gray (the identified pipeline, `docs/RENDERER_IDENTIFIED.md`).
`dump-ocr --templates templates_full_synth` on the real `corpus/v3.pdf`:

- **letter-for-letter identical to the live hand-curated `templates/` dict on
  all 1745 rows** (space-stripped comparison of the two dumps: zero differing rows);
- vs `corpus/v3.txt`: 1708/1745 rows byte-exact (97.9%), 99.70% chars, 0 truncations.
  ALL residuals are space-count-only rows (narrow styled spaces / redaction gaps —
  the rows `docs/SPACE_REVIEW.md` already holds for manual review) **except P5 L13,
  where v3.txt itself is truncated**: the page really draws
  "First time user? &nbsp;&nbsp;Refer to instructions =" and both dicts read it;
  v3.txt stops at "user" (it inherited an old reader stop at a then-missing '?').
  → v3.txt fix candidate.

## Recipe (all tooling shareable; the `render_synth_*.py` halves live in the
archived ocr workspace zip — fontgen/export_glyphs now in `tools/fontgen/`)

1. `tools/dump-layout.mjs` — kern-correct glyph lefts for every row of v3.txt via
   Chrome measureText (startX 45) → `docs/layout_v3.json`. Pure layout, no pixels.
2. `ocr/tools/render_synth_pages.py` — MuPDF-render those pages (816×1056 gray),
   write them as a raster cache keyed to a stub PDF. Direct byte-compare vs real
   pages: only 480/1836 row bands byte-exact — because of the **snap-boundary
   problem** (below), not because the pipeline is wrong.
3. Coverage copies (all appended to the same cache, source = v3.txt repeated):
   - 5 uniform pen-shift copies (0 … −0.032 px) — `render_synth_copies.py`;
   - 8 per-glyph-random shift copies — `render_synth_mixed.py` (kern pairs where
     the generator flipped one glyph's snap but not the neighbour's);
   - 150 targeted pages enumerating all 5×5 / 5×5×5 shift combos for rows that
     still failed — `render_synth_targeted.py`;
   - recovered-pen pages for narrow-space ("styled") rows — `render_synth_recovered.py`
     locates each glyph's drawn ¼-px bucket on the real page (geometry only,
     byte-locating with fontgen rasters) and renders at those pens.
4. `tools/synth-templates.mjs --pdf <stub> --source <v3.txt×N>` over the synthetic
   cache → `templates_full_synth` (the normal harvest, just fed synthetic pixels).
5. Two windows the space-fit gate kept rejecting ('?' in P5 L52, '@' in P4 L36
   after the redaction box) were composited directly from glyph rasters with the
   byte-exact blend law and **byte-verified against the page before merging**
   (`merge_tail_p4.py`; page pixels only select the pen hypothesis — the template
   bytes are still 100% synthetic renders).

Verification runs (dumps not kept — regenerate in ~15 s):
`KEEP_SPACES=1 node dump-ocr.mjs --all --pdf ../corpus/v3.pdf
--templates templates_full_synth --out ../out_fullsynth.txt` then
`node compare-dump.mjs ../out_fullsynth.txt ../corpus/v3.txt`
(reference dump: same command with `--templates templates`).

## The snap-boundary problem (the one real obstacle, now characterized)

MuPDF snaps pen x to ¼ px, and the corpus layout's pens sit **0…~0.025 px BELOW
the ideal measureText positions** (per-occurrence, not constant — a global shift
makes things worse; the deficit is presumably the layout producer's coordinate
quantization, still unidentified — Phase 2). Dyadic measureText fracs land
exactly on / a few 1/128ths above snap boundaries all the time, so ~6% of glyphs
flip a quarter-bucket relative to the naive render. A wrong-side flip is a
completely different raster → the shift-copy strategy above simply harvests both
outcomes; a dictionary may contain both, only the page decides.

Narrow-space rows drift up to −1.6 px mid-row (styled ~2.4–2.8 px spaces), so
their pens must be recovered per row (step 3d) until the styled-space layout
model exists.

## Also established this session (pair-composite census, `ocr` workspace)

- MuPDF glyph overlap compositing is byte-exactly
  `dst = (dst·(256−FZ_EXPAND(cov)))>>8` in draw order (95/95 overlap px);
  inverse from gray is effectively unique → any kern context is synthesizable
  without rendering the pair (`tools/composite_check.py`, `validate_pairs.py`).
- Of the 1065 archived harvest templates: 466 regenerate as single glyphs,
  518 as core+one-neighbour composites, 52 with two neighbours = **1036/1065,
  99.987% of source.pdf glyph occurrences**. The 29 leftovers are ~1-gray-level
  merge artifacts and windows dominated by neighbour ink (search scope), not
  render mysteries (`corpus/pair_census.json`).
- The 398 RGBA hand cuts in `templates/`: only 23 reproduce through MuPDF —
  they are browser-canvas drawings / styled-row cuts, superseded by the
  synthetic dict for everything regular-TNR16.

## Housekeeping (done 2026-07-08)

The synthetic raster caches, the verification dumps, `docs/layout_v3.json`
(regenerate with `node tools/dump-layout.mjs`, ~5 s) and the synthetic-derived
`source_spaced.txt` were deleted in the repo cleanup; everything above tells
how to regenerate them. Corpus PDFs are untracked/.gitignored — local data only.

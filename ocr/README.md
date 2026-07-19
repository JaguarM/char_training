# ocr/ — renderer-identification lab

Standalone workbench that answers ONE question for any mystery raster
document: **which rasterizer (program + font file + settings) produced these
glyph pixels, byte for byte?** — and then hands the answer to the main
engine as a glyph set. Permanent tooling, not a one-off hunt: the courier
block fell here (`FINDINGS.md`, integrated as `nimbus791` the same evening)
and the times hunt before it (zip in `Desktop/standalone_proj/`).

You are NOT building an OCR system here and NOT reading whole documents.
Success = a renderer that reproduces harvested targets EXACTLY (every
byte). Once ~20 targets are EXACT with one config, the method is found —
record it in `families.mjs` + a findings note and integrate.

## The pipeline — a new mystery document is 3 commands

```
npm install                              # once: the mupdf wasm the tools use
node tools/ingest.mjs path/to/DOC.pdf    # pages/<DOC>/: byte-exact page rasters + overlay words
node tools/harvest.mjs                   # targets/: byte-identical glyph clusters, pixel-fitted lattice
node tools/identify.mjs                  # fingerprint + try EVERY proven family automatically
```

`identify.mjs` ends in a verdict:

- **"VERDICT: <family>"** — the producer is already known; an engine glyph
  set usually exists. Jump to *Integration* below. (Sanity: on the courier
  targets it reports `nimbus791 113/279`, everything else 0, in ~1 s.)
- **"no known family matches"** — follow its numbered next steps; see
  *When nothing matches*.

## Trust rule

**Pixels are the only ground truth.** Everything else can be wrong and has
been: the hidden text overlay is the producer's own OCR (misreads,
Tz-stretched boxes); a manifest once claimed advance 6.001 px where the
pixels measure 7.418. Re-derive any number you depend on from `pages/`
before trusting it — including the numbers in `families.mjs` and every
findings file.

## The registry: `families.mjs`

Every byte-proven producer config lives there as data — font file, em64
(trunc(em·64), THE sharp identifier), pen lattice, post-law — plus the
page-law families the ¼-px engine can't render (palette quantization,
JPEG jitter, Outside In variant B) with their fingerprints. `identify.mjs`
consumes it. **Add each newly proven config the moment it is certified** —
that registry is what makes the next hunt start warm instead of cold.

## When nothing matches

1. **Known face, unknown size**: `node tools/identify.mjs --scan
   fonts/<face> [--ems 448..1280]` — exact counts per em64 at the ¼-px pen
   lattice, ~1 min. A real config is SHARP: the courier scan spikes at
   em64 791 and nowhere else in ±30.
2. **Full pen lattice**: `node tools/sweep-ft.mjs --font <face> --ems
   <a>x<b>,... --sad --report hits.json` — all 64×64 pen phases via the
   certified `ftclone.mjs` (places pens fillText can't); `--sad` is the
   compass when nothing is exact yet.
3. **Arbitrary external renderer**: render into `candidates/<name>/<id>.pgm`
   (any margin, P5) and score with `node tools/check.mjs candidates/<name>`
   (`--id <id>` for a byte dump). Refuted probes for GDI/GDI+/stretch live
   in `tools/attic/` as templates.
4. **Inspect**: `node tools/view.mjs targets/<id>.pgm --num`, `--crop
   x,y,w,h` on pages, `node tools/levels.mjs` (byte-lattice fingerprint),
   `node tools/ftres.mjs` (aligned target/candidate diff).
5. Write the findings file; `FINDINGS.md` shows what a solved hunt records.

Lessons already paid for (the hunts' scar tissue):

- The font FILE is a variable (TimesNewRomanXP; but courier 2.76 ≡ Win11 —
  version is not automatically the answer).
- "Almost but ±1" against a proven rasterizer ⇒ **check for a palette
  before hunting renderers**.
- Target `ch` labels are overlay CLAIMS: if your '0' matches a target
  labeled 'O', the label is wrong, not the raster.
- Don't fit tolerances — deterministic producer ⇒ the answer is exact;
  avg-diff is only a compass.
- Near-misses on REAL PAGES are usually composition (neighbor-glyph AA
  spill, drawn rules cut into windows) under the same blend law — judge a
  config by exacts on isolated targets, and let the main engine's
  composite-aware scan handle pages (the courier remainder needed no new
  physics).
- fillText y-snaps pens round-to-int (the "8-phase oracle" was 4 rasters);
  `ftclone` places pens on any 1/64 and is byte-certified against the wasm
  — re-run `node tools/ftclone.mjs` after ANY edit to it.

## Integration — identified config → reading documents

All in the main repo, one command each:

```
node tools/fontgen.mjs --font <file> --em64 <N> --phases-y 0 \
     --out assets/fonts/<name>_<N>.npz        # rasters via certified ftclone
node ocr/tools/check-npz.mjs assets/fonts/<name>_<N>.npz <hits.json>
                                              # npz ⇔ byte-exact page targets
# add ['<name><N>', '<name>_<N>.npz'] to SETS in tools/export-glyphs.mjs
node tools/export-glyphs.mjs                  # rebuild glyphs.bin
cd tools && node blind-read.mjs --pdf <doc.pdf> --all --glyphs <name><N>
npm test && npm run gate                      # must stay byte-identical
```

(`fontgen.mjs` details in `../tools/README.md`; the courier integration —
including the stacked-band engine work small line pitches need — is
`../docs/BLIND_READER.md` 07-19 eve.)

## Layout

```
families.mjs      the proven-producer registry (identify.mjs reads it)
FINDINGS.md       courier/Nimbus hunt record (SOLVED + integrated)
pages/<DOC>/      ingested docs: page-NNNN.pgm + .words.json + meta.json
targets/          harvested ground truth + index.json (id, ch claim, cp,
                  phaseSlot, adv, frac, obs, srcs — every target re-findable
                  in situ). Harvest promotes a cluster only with ≥3
                  byte-identical observations and diverse neighbors.
candidates/       scratch renders for check.mjs (mupdf/ = scored baseline)
fonts/            local face fixtures (cour* Win11 + 2.76 + XP, Nimbus CFFs)
hits-nimbus-791.json  the 113 exact (id, pen) pairs (check-npz input)
sad-791.json      best-SAD per target at the final courier config
tools/            ingest · harvest · identify · sweep-ft · check · check-npz
                  ftclone (+cff/ttf) · ftres · view · levels · attic/
```

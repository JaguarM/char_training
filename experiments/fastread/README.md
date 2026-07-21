# fastread — race the reader to the theoretical floor

Experimental sandbox (2026-07-21). Goal: read a document to the **byte-identical
glyph stream** in the minimum possible time, as groundwork for batch-processing
giant PDF folders (531k-doc scale) once more letter templates exist. Nothing in
here ships; candidates graduate to `src/ocr-engine.js` only after the full
gate (see Rules).

## Baseline — measured 2026-07-21, big.pdf (340 pages, 293 MB gray)

CPU profile of a real `blind-read` run (29.5 s wall, self time):

| phase | self | % | what it is |
|---|---|---|---|
| `detectObjects` | 8.4 s | 28% | fused single-pass run detectors (rules/boxes/vrules) |
| `scanLine` | 8.0 s | 27% | left→right composite-aware scan |
| `tryCand` | 4.7 s | 16% | per-candidate byte trial |
| `readPage` self | 4.6 s | 16% | band orchestration, retro checks, unexplained counts |
| GC | 1.0 s | 3.5% | |
| `colMask` | 0.8 s | 2.7% | |
| zlib+IO (decode) | ~1 s | 3% | GRY1 cache decode |

PDF decode is noise; **the matcher core is ~91% of wall time.** That is the
part this experiment races.

`bench.mjs` phase splits (rasters pre-decoded, best-of-reps, this machine):

```
sol8      0.496 s    591 MB/s    1.46 ms/page   floor: every byte once (24.6% of bytes < 255)
sol32     0.359 s    817 MB/s    1.05 ms/page   floor with white skipped word-at-a-time
detect    9.070 s     32 MB/s   26.68 ms/page
bands     0.116 s   2535 MB/s    0.34 ms/page
read     26.729 s     11 MB/s   78.61 ms/page   18307 lines / 1,338,832 glyphs / 0 □
```

**The read runs at 54× the every-byte-once floor.** A reader fundamentally
must (a) look at every byte once to find ink, and (b) compare glyph rasters
against ink bytes a small constant number of times. Everything above ~2–3
passes of the data is algorithmic waste in principle. Single-thread floor for
this doc ≈ **0.5–1.5 s**; on N worker cores pages are embarrassingly parallel,
so ÷ cores on top of that (16 threads → tens of ms/doc region — at which
point zlib decode and disk become the bottleneck, which is the right problem
to have for batch mode).

## Ranked attack plan

1. **`detectObjects` — 9.1 s at 32 MB/s.** Already a fused single pass, but
   it burns ~25 branchy state-machine ops on *every* byte, white included.
   The machines only need to wake near ink: read `Uint32` (or
   `Float64`/BigInt64) words, and while the word is `0xFFFFFFFF` just tick
   the "all-white" fast path (dark-run terminators + light-run resets are
   trivially predictable across a white span). sol32 proves the scan pattern
   sustains 800+ MB/s. Realistic: 9 s → well under 1 s. Care: the vertical
   per-column state arrays must still see white columns end their runs —
   batch-terminate over the span instead of per-pixel.
2. **`scanLine` + `tryCand` + `colMask` — 13.5 s.** The candidate-trial core.
   Levers: sharper first-ink-column indexing (anchor groups exist — measure
   candidate counts per accept), earliest-exit byte ordering inside `tryCand`
   (compare the most-discriminating ink bytes first), and a WASM/SIMD inner
   compare (perf-profile 07-16 verdicts noted WASM was judged before —
   re-measure at today's shape before trusting that).
3. **`readPage` self — 4.6 s.** Unexplained-count bookkeeping and retro
   checks; incremental updates instead of rescans.
4. **Parallelism — `worker_threads` page pool.** Pages are independent
   (cross-page `carry` hints are an optimization, not a correctness input —
   verify the stream stays identical when dropped/sharded, or shard by chunk
   like `scan-dataset --offset` runs do). This is the batch-mode multiplier:
   near-linear in cores.
5. **Batch plumbing (later, in `batch-read.mjs`):** keep pages compressed
   until a worker takes them, overlap decode with matching, reuse one warm
   process — the 1.0 s decode+load and process startup dominate small docs.

## Harness

```
node bench.mjs                                  # big.pdf, real src/ engine, record/verify baseline
node bench.mjs --pages 40 --reps 5              # quick slice while iterating
node bench.mjs --engine candidate/ocr-engine.js # race a hacked copy (start: cp ../../src/ocr-engine.js candidate/)
node bench.mjs --doc v3                         # any mode-1 (grayscale) cached doc
node bench.mjs --record                         # re-record baseline (only after an INTENDED output change)
```

The baseline hash covers every line's baseline/phy/font, every glyph `ch@pen`
(3 decimals — the ¼-px lattice), and every fail column. **A candidate that
changes the hash is wrong, not fast** — the bench exits 1.

## Rules

- Page pixels are the only ground truth; the hash check here is the inner
  loop, not the certificate.
- Graduation path for a winning candidate: identical hash on FULL big.pdf →
  copy into `src/ocr-engine.js` → `npm test` (~30 ms unit suite) →
  `npm run gate` (7 docs byte-compared) → `node tools/test-blind-app.mjs` →
  `npm run sync:recto` + recto-test (the app embeds this same file).
- `detect`/`bands` phases use fresh page wrappers so `readPage`'s per-page
  detection memo can't leak between phases; keep it that way.
- baseline.json is per (doc, pages, glyphs) key — a `--pages 40` baseline
  says nothing about the full doc.

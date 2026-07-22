# Benchmark baseline — 2026-07-21

RTX 5060 Ti, Windows 11, big.pdf corpus (340 pages, `data/pages/big/*.pgm`),
Release build of `build/gpu-ocr.exe`. Method: 1 warm-up run, then timed runs
of the full corpus; numbers below are the binary's own summary line.

## Default config (`.\build\gpu-ocr.exe`, tol 0, no crop)

5 runs — wall: 1.85 / 1.78 / 1.80 / 1.81 / 1.81 s (median **1.81 s**, 5.3 ms/page)

Phase totals (median run, ms over 340 pages):

| phase | ms | share |
|---|---|---|
| io (PGM read) | ~190 | 12% |
| h2d | ~95 | 6% |
| darklist | ~4 | <1% |
| **match kernel** | **~918** | **59%** |
| d2h | ~18 | 1% |
| assemble (CPU) | ~260 | 17% |

Output invariant: 18296 lines, 1,010,650 glyphs, 2,048,792 hits (identical
across all runs).

## Best-accuracy config (`--crop 3 11 --crop-yoff -3`)

3 runs — wall: 1.70 / 1.63 / 1.63 s (median **1.63 s**, 4.8 ms/page)

| phase | ms |
|---|---|
| io | ~160 |
| h2d | ~95 |
| darklist | ~4 |
| match | ~768 |
| d2h | ~18 |
| assemble | ~310 |

Output: 18307 lines, 1,318,685 glyphs, 2,691,628 hits.

Accuracy (tools/compare.mjs vs char_training certified transcript):
- exact line matches: 6193 / 18307 (**33.8%**)
- non-space chars emitted: 1,318,685 / 1,338,832 (**98.5%**)

## Optimization targets (largest first)

1. **match kernel ~0.9 s (59%)** — the dominant cost by far.
2. **io + assemble ~0.45 s combined** — both CPU-side and serial with the GPU
   per page; overlapping io/assemble of page N±1 with the GPU on page N could
   hide most of this behind the kernel.
3. h2d/d2h ~0.11 s — pinned memory / async copies, only worth it after (2).

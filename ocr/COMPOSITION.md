# Corpus composition — F:\_Epstein\dataset9-more-complete (2026-07-22)

THE record of what the 531,281-PDF / 300 GB dataset actually contains,
measured from PIXELS (trust rule), by seeded random sample. This is the
prioritization ground truth for the OCR frontend project: what fraction the
known families cover, and where the remaining page-mass sits.

Method: `gpu-ocr/tools/classify-sample.mjs --n 2000 --seed 42` — mulberry32
shuffle of the full folder listing, 4 interior pages per doc, mupdf-direct
decode + per-page palette LUT, one GPU launch over all 8 family rosters
(19 sets), multi-label verdicts. Raw per-doc data (incl. per-family
tallies, dims/mode/palette signatures): `gpu-ocr/sample-composition-42.jsonl`
(resumable; a bigger --n later EXTENDS this sample). Classifier validated
11/11 on the labeled confusion set before and after every threshold change.

## Headline (n=2000 docs, 4,017 pages; ±2 % at 95 % on the big shares)

| class | docs | doc % | pages | page % |
|---|---|---|---|---|
| corpusTimes | 1,229 | **61.5** | 1,958 | **48.7** |
| none (unknown) | 584 | 29.2 | 1,574 | 39.2 |
| courier13 | 105 | 5.3 | 133 | 3.3 |
| arial | 44 | 2.2 | 134 | 3.3 |
| nimbusromLin | 15 | 0.8 | 119 | 3.0 |
| nimbusromCourt | 6 | 0.3 | 108 | 2.7 |
| calibri | 22 | 1.1 | 41 | 1.0 |
| nimbus791 | 7 | 0.3 | 11 | 0.3 |
| no-image (text PDF — needs the Chrome raster path) | 8 | 0.4 | 8 | 0.2 |

**Known families: 70.4 % of docs, 60.6 % of pages.** (Classifier detection,
not certified reads — but the certified email/corpus precedents suggest the
gap is small for these classes.)

Corpus shape: the median doc is a 1–2 page EMAIL (sample mean 2.0 pp/doc ⇒
**~1.07 M pages total** — an order of magnitude smaller than page-count
folklore assumed). At the exact engine's ~60 ms/page that is ~18 h of
single-core reading for the whole readable share; at gpu-ocr's 5 ms/page,
~1.5 h. **Speed is not the binding constraint; coverage is.**

Scoring note: the original 300-glyph absolute floor missed exactly this
corpus shape — a 1-page Times email tops out below it. The short-document
rule (≥80 glyphs with 10× dominance over every other family) recovered
~300 docs into corpusTimes with the labeled matrix unchanged at 11/11.
Stored tallies rescore without re-running (`--summarize` recomputes).

## The unknown 39 % — clusters by page-mass (next-hunt ranking)

| signature | docs | pages | examples | read |
|---|---|---|---|---|
| 816×1056 mode3 palette | 121 | 472 | EFTA01098184, EFTA01168608, EFTA01132747 | **#1 hunt**: email class, TNR headers read; body = crisp SANS face, refuted at 16 px against verdana/verdanab/segoeui(b)/georgia/calibri/arial sets and NOT the jitter class (tol 0→2 moves counts by <2 %). Likely ONE producer face at an untested size — worth ~12 % of corpus pages by itself |
| 816×1056 mode1 nopal | 186 | 344 | EFTA00490646, EFTA00768385, EFTA00390734 | **#2 hunt**: grayscale emails, Times-looking bodies that PART-read (tens of glyphs incl. tnr8_16) — suspect corpus faces at other px sizes; cheap fontgen size-sweep first |
| 816×1056 mode1/3 palette | 15 | 141 | EFTA01136215, EFTA00395895 | mixed-mode cousins of #1 |
| 753×951 / 794×1122 / 820×1060 … | ~10 | ~200 | EFTA00258707 … | odd-dims long tail, triage per doc |
| 205×154 + 154×205 thumbnails | 58 | 58 | EFTA01178608 … | photo attachments — **unreadable by nature**, honest skip class |
| 1056×816 landscape | 7 | 90 | EFTA01091832 | rotated pages — classifier is orientation-blind; try rotated decode before hunting |

tnr8_16 fires 32–127 glyphs on most cluster-1/2 docs (disclaimer/small
text) — evidence these are the SAME email-producer lineage with faces/sizes
we haven't generated, not alien renderers.

## What this changes

1. The 07-22 big-candidate sweep (9/10 unknown) sampled the fat TAIL, not
   the corpus: the big palette compilations are rare. The bulk is small
   emails in already-solved families.
2. Two hunts (#1 sans body, #2 size variants) plausibly take page coverage
   from ~61 % to ~80 %. After that the residue is thumbnails, scans and a
   long tail of one-off producers.
3. The frontend/WASM investment (option 3) is justified NOW for the covered
   share — but its Phase-1 design should be validated in gpu-ocr first
   (bleed-immune core probes), and the corpus fits ~1 M pages, so even the
   exact engine can batch-read everything readable overnight.

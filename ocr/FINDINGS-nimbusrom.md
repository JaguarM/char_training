# FINDINGS-nimbusrom.md — EFTA00039208 serif family (SOLVED 2026-07-20)

**Verdict:** MuPDF-lineage renderer using its **builtin URW base-14 faces**
(like the courier 7516xx block) plus TWO page-space post steps: the
**eDiscovery linear law on [128,254]** and a **per-page /Indexed palette**.
Proving doc: `F:\_Epstein\dataset9-more-complete\EFTA00039208.pdf` (12 pages,
copied to `NEW/EFTA00039208.pdf`; sha256 81b4579f…). Full doc reads at
**tol 0: 223 lines / 13,034 glyphs / 38 □**, every remaining □ being the red
footer legend or the P1 seal graphic (below).

## The pipeline (byte-proven)

1. **Glyphs:** ftclone (FT 26.6 unhinted + ftgrays + FZ_BLEND over white),
   **¼-px x pens, INTEGER y** — identical physics to the courier block.
2. **Faces:** unembedded base-14 names are substituted with **mupdf's URW
   builtins** (overlay claims "TimesNewRomanPSMT"/"Helvetica" — lies):
   | text | face | em64 |
   |---|---|---|
   | 12pt body (+bold, letterhead "U.S. Department of Justice") | NimbusRoman-Regular/-Bold.cff | 1024 |
   | OPI/NUMBER/DATE header block | NimbusRoman-Regular.cff | **983** |
   | "P R O G R A M  S T A T E M E N T" | NimbusRoman-Bold.cff | 1194 |
   | 18pt cover title ("Searches of Housing Units…") | NimbusSans-Bold.cff | **1536** |
   Current (1.16+) and 1.12/1.14 CFF revisions render these glyphs
   identically — version is not load-bearing here.
   **EMBEDDED subset fonts render directly**: the ■ bullets and curly quotes
   (’ “ ”) are **real Times New Roman** (`C:/Windows/Fonts/times.ttf` ≡
   TimesNewRomanXP for these glyphs) at em64 1024, same pen lattice.
3. **Linear law, domain [128,254]:** page byte = blend byte + 1 for raw ∈
   [128, **254**]. The report family's sets use [128,253]; here raw 254
   (coverage 1) becomes **255** — those pixels VANISH. This was the entire
   gap between 40 % and ~100 % glyph-exactness: cov-1 AA pixels (e.g. the 'A'
   serif tips) predicted 254 where the page is white. `fontgen --linear` now
   bakes [128,254].
4. **Palette quantization, per page:** every page is an 816×1056 8-bit
   `/Indexed /DeviceRGB` Flate image with its OWN 256-entry palette (objs
   13, 42, 74, 99, 127, 152, 181, 206, 231, 263, 288, 320 for p1..p12).
   Law: nearest palette entry to (v,v,v) by **RGB distance over the FULL
   palette including non-neutral entries** (ties → darker sum); the page
   gray we read is round(mean(entry)). Non-neutral entries matter: e.g.
   post-linear 254 maps to (254,254,255) → gray 254. The engine's
   histogram `--quant` mis-breaks these cases; `blind-read --palette` builds
   the TRUE per-page LUT from the PDF and `readPage` now accepts a LUT
   directly (`opts.quant` = Uint8Array(256)).

Order matters: **blend → linear → palette** (proven: 205+1=206→207 while
Q(205)=204; 239+1=240→tie→239; 253+1=254→(254,254,255)).

## How it fell (method notes)

- Overlay/word claims lied about faces AND sizes (Tz-stretched OCR fits);
  advances measured from pixels gave em≈16 while all times16-family sets
  read 0 — the giveaway that only the FACE was wrong.
- `tools/probe-times.mjs` — single-glyph window fit over (font, em64, all
  64×64 pens) with the family law applied (`--law palette:<pdf>:<obj>`,
  `--ink C`, `--nolin`) — produced EXACT (bad=0) verdicts: d/A/N/S/U/’/■
  each pinned their face+em64 sharply (983 exact, 982/984 ≥26 bad px).
- `tools/diff-stats.mjs` re-rendered all 12k accepted glyphs and aggregated
  per-(ch,phase) deviations — the stable `254→255` column IS the [128,254]
  law; scattered rest was neighbor composition.
- Determinism check: same-phase 'd' windows at x-distances 8 AND 15 are
  byte-identical (interior) — deterministic stamps, no JPEG.

## Reading the family

```
node tools/blind-read.mjs --pdf <doc.pdf> --palette --tol 0 \
  --glyphs nimbusromlin1024+nimbusrombdlin1024+nimbusromlin983+nimbusromilin1024+nimbusrombdlin1194+nimbussansbdlin1536+tnrlin1024
```

Color pages: hyperlink blues etc. flood as usual; the palette's near-neutral
AA entries (spread 1–3) neutralize to exactly the LUT gray.

## Sub-family #2: court/ECF filings (EFTA00093044, found 07-21)

Same palette container + renderer physics (¼-px x, INTEGER y, per-page
/Indexed palette) but **NO linear step** (`post: null` + palette). Source
documents are CM/ECF court filings; each source brings its own faces:

| content | face | em64 | ink | verdict |
|---|---|---|---|---|
| brief body | **Century Schoolbook** (`C:/Windows/Fonts/CENSCBK.TTF`) | **1198** | black | EXACT 0/165 ('d' of "around", p20, pen 48/64,0) |
| single-spaced blockquotes | same face | 1198 | gray srcover **C≈26** | maxd 2 — the known srcover ±1 quirk (calibri-family precedent); read tol 2 or harvest |
| ECF banner ("Case 21-770, Document…") | Nimbus Sans | 1024 | blue → gray **118** srcover | maxd 2, same ±1 quirk |
| ornate cover ("United States Court of Appeals…") | blackletter, unidentified | — | — | untriaged |

Body reads immediately: p20 = 16 lines / 871 glyphs tol 0 with
`censcbk_1198 + censcbkbd_1198 + censcbki_1198` + `--palette`.
Lesson: the overlay claimed "Times-Roman 15.6" — advances measured from
pixels said em≈22 which fit NO Times; the wide-advance/x-height ratio was
the Century tell. **Within one container family, expect one sub-family per
SOURCE-document producer** (BOP docs = Nimbus+linear254; court briefs =
Century+no-linear; both under the same palette wrapper).

## Open

- **Red footer legend** (every page, y≈982; P1 y≈941/948): red ink
  (204,0,0) srcover — gray math verified — but NO outline face matches:
  NimbusSans (reg/bold, 3 CFF revisions), Arial (reg/bold/black), Segoe,
  Tahoma, Verdana, Franklin Heavy, Impact-class, TimesNewRomanXP, and
  double-draw synth-bold all refuted (probe-dd.mjs). Uniform two-row AA
  gradients suggest a RESAMPLED bitmap layer (Cambria-class: recognize,
  don't hunt). It is layout-constant boilerplate → if it must read, cut a
  page-byte band set (`harvest-band.mjs`, fedline_page precedent).
- **P1 DOJ seal** (x~95..135, y~158..190): graphic; bands containing it stay
  unread. Letters beside it are certified readable (U bold 1024 EXACT).
- identify.mjs knows `post: 'linear254'` but its harvest route is
  monospace-only — these entries are documentation + engine-probe warm
  start, not auto-identifiable from cell targets.
- The `nimbussanslin_938/1024` + `nimbusrombdlin_938` npz files exist but
  are UNPROVEN (nothing on these pages needed them); not registered.

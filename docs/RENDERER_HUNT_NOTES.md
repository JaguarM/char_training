# Document Rendering Forensics — corpus

> **Archived 2026-07-13.** This is the NOTES.md of the Desktop/ocr forensics
> workspace, preserved verbatim when that workspace was retired. Its live
> core (fontgen.py, export_glyphs.py, render_hypotheses.py, the .npz font
> rasters) moved into `tools/fontgen/` + `assets/fonts/`; everything else
> (template era, hunt tools, corpus duplicates) lives only in the archive zip.
> Paths below refer to the old workspace layout.

Living document. Started 2026-07-07. Goal: identify the exact method used to
create the text page images, then reproduce them byte-perfectly (multi-week,
multi-session project — see Roadmap).

## SIBLING PROJECT: char_training (2026-07-07, session 3)

`C:\Users\yanni\Desktop\char_training` is the original project (browser
training UI + Node bench harness + the synth-templates.mjs harvester the
session-1 claims came from; git repo). Findings exported there as
`notes/RENDERER_IDENTIFIED.md` (8 numbered corrections + a self-contained
PyMuPDF repro verified against their live templates/B_UPPER_1.png), with dated
pointers added in bench/README.md ("research 2026-07-03" paragraph) and
notes/TRIM_HANDOFF.md (the pending generalization test is now trivially
runnable via MuPDF-rendered fresh oracles). Changes left uncommitted for review.
Their measureText layout model + measured facts all survive; only the renderer
hypotheses and mechanism gaps were corrected.

## THE ONE-TEMPLATE PROOF (2026-07-07, session 3)

`python tools/one_template.py` — B_UPPER_1.png (the most common 'B' template,
7,004 occurrences in source.pdf) recreated from nothing: 'B', Times New Roman
12 pt, integer pen (phase 0), MuPDF 96 dpi gray, window rows baseline−11..+3,
cols pen+2..pen+8 → **byte-identical, 0/105 differing** (proof-B_UPPER_1.png).
The other three ¼-px phases match nowhere — a template pins its exact phase.
Two lessons learned doing it: (1) this top variant is trimmed INTO the glyph's
own AA ('B' ink is 10 px wide, window keeps cols 2..8), so most templates are
partial-glyph windows; (2) the metrics `anchor` field does NOT give the
window-to-pen offset the way session 1 assumed (B_UPPER_1: anchor 0.9919 but
window left = pen+2) — anchor's fractional part tracks phase/jitter, its
integer part is undeciphered. Don't trust anchor for alignment; recover
alignment empirically (slide + byte-compare), which is cheap and absolute.
v3.pdf/v3.txt moved into corpus/ (user request).

## THE ONE-LETTER PROOF (session 2)

`python tools/one_letter.py` — takes the lone 'B' on line 1 of email.pdf p3,
recreates it from nothing (fresh PDF, Times New Roman 12 pt, pen at the
recovered position x=64.0 px / baseline row 51, rasterized by MuPDF at 96 dpi
grayscale) and shows the two 13×12 pixel grids are **byte-identical, 0 differing
pixels** (see proof-B.png). That is the answer to "how was it created", proven
on the smallest possible object. Note line 1 of that page also has a vertical
quote bar = HTML blockquote left-border → the layout stage rendered HTML.

## STATUS 2026-07-07 (session 2) — FONT-GENERIC TOOLING BUILT ✅

Also this session: **tools/lineocr.py** — generative decoder prototype: peels
lines top-down, byte-matches glyph rasters, recovers text + fractional pen x
per glyph. Already reads v3 p2 lines perfectly ("> Reserved: UNITED AIRLINES
521", "> Departs: Boston, MA - BOS", …); redactions/unknown ink print as '~'.
Known gap: extreme kern overlaps ('WA' in "EDWARD") still rejected — next
session: composite-aware acceptance (divide out the neighbour's coverage)
instead of the edge-column heuristic. Pen-x sequences from lineocr are the
Phase-2 layout dataset.

The pipeline knowledge is now packaged as reusable tools (any font, not just TNR):

- **tools/fontgen.py** — renders any font file through the byte-exact pipeline
  (MuPDF 96dpi gray) at all 8 producible subpixel phases (4 x-quarters × 2
  y-halves); stores tight rasters + pen/baseline offsets + exact fractional
  advances in one `fonts/<name>_<size>.npz` (~340 KB). This *is* the "recreated
  font": templates for any face are generated, never harvested.
- **tools/fontid.py** — identifies (font, size) of any page by counting exact
  raster hits. Demo: email p2 → times@16: 2426 hits 23/23 chars, all other
  fonts 0. source p2 → times@16: 940 hits; timesbd/timesi: **0** (no styled text
  on early source pages; the "52 styled rows" remain to be located).
- **tools/validate_fontgen.py** — proof the old template dict is superseded:
  466/1065 harvest templates reproduce byte-exactly as single glyphs; the 599
  others are low-count kern/bleed context variants covering only **1.2 %** of
  source.pdf glyph occurrences (they'd regenerate from glyph-pair renders).
  Note 466 ≈ the "~450 one-core-per-(char,phase)" claim — that claim now credible.

**Corpus findings (session 2):**
- `corpus/source.pdf` = the 340-page harvest source, restored by user. Same
  wrapper style as v3.pdf (no metadata), same pipeline, same TNR 16px —
  byte-exact template hits confirmed. Has (bad) OCR text layer too.
- `corpus/email.pdf` = 36 pp, **different wrapper: Producer=PDFium, PDF 1.7**,
  same page raster pipeline (byte-exact TNR16 hits), redaction boxes, more
  base64 attachment pages. Pages 1 & 36 are DeviceRGB because they contain
  **anti-aliased hyperlink blue** (R=G<B, e.g. 33,33,239) — this fully explains
  the old "mode-2 / unequal channels" claim: real link color, not a pipeline quirk.
- `corpus/*.txt` = the PDFs' embedded OCR text layers; spaces are collapsed
  ("SentfrommyiPhone") → existing OCR is unusable; that's why this project exists.
- Templates PNG dict retired → `corpus/templates_archive.zip` (1465 entries,
  478 KB, integrity-verified); metrics/manifest JSONs kept at `corpus/`.
  Phase-1 evidence scripts → `tools/archive/` (see its README).

## STATUS 2026-07-07 (session 1) — RASTERIZER IDENTIFIED: MuPDF ✅

**MuPDF rendering Times New Roman 12 pt at 96 dpi grayscale reproduces the page
glyph pixels byte-exactly.** Census: **60/60 template occurrences byte-exact
over the full window**, 31 distinct chars, sampled across all 33 text pages of
v3.pdf (`tools/pdf_engines.py`, verified with PyMuPDF 1.27.2 / its bundled
FreeType). Competing candidates at the same protocol: pdfium MAD≈6.8,
raw freetype-py 2.13 + naive sRGB blend MAD≈0.29 (close, ±1–4 on AA edges only),
gamma-correct FreeType ≈17, Pillow-hinted ≈22. (`tools/render_probe.py`)

### The full pipeline, as established so far

1. **Content**: raw email MIME source (Apple Mail boundaries, quoted-printable
   bodies, base64 attachments) — v3.txt is the text of v3.pdf.
2. **Layout** (open question — next phase): text laid out in Times New Roman at
   16 px em (= 12 pt @ 96 dpi) with *unquantized fractional advances*
   ('A' advance = 1479/2048×16 = 11.5546875 exactly) and kerning —
   "Chrome-metric" layout. Integer-px baselines (layout-side; MuPDF's y-snap is
   ½ px so integers must come from the source). Candidate: headless
   Chromium print-to-PDF of an HTML-ish email view (16px serif = Chrome default).
3. **Rasterization**: that text PDF rendered to 816×1056 px (8.5×11" @ 96 dpi)
   grayscale page images by **MuPDF** (`mutool draw/convert -r 96` or an
   embedding tool). Fingerprints, all reproduced:
   - glyph x snapped to nearest **¼ px** (4 subpixel buckets; boundaries at
     .125/.375/.625/.875) — MuPDF glyph-cache quantization, verified by sweep
   - glyph y snapped to nearest **½ px**
   - FreeType unhinted coverage, composited **directly in sRGB bytes**
     (gray = 255 − coverage; no gamma correction, no stem darkening)
4. **Packaging**: images wrapped into a PDF (v3.pdf): DeviceGray 8-bit
   FlateDecode, `/Name /Im0` style, **no Producer/Creator/Info/XMP at all**,
   `\r\n` EOLs in original body. PDF 1.5, trailer /ID present.
5. **OCR layer**: an *incremental update* appended an invisible OCR text layer
   (non-embedded Type1 Times-Roman + Helvetica, word-fragment spans with
   size jitter 11.6–12.3) — engine not yet identified.

### Key implication (likely the point of the whole project)

The last pages' images show a **base64-encoded PDF attachment** (OCR layer on
p34 reads e.g. `MDAwNzM4OTYgMDAwMDAgbg…` = "0000073896 00000 n\r\n…", a PDF
xref table). Byte-perfect OCR of the base64 pages ⇒ reconstruct the original
attached PDF exactly. Base64 has no redundancy → this is why 100% accuracy
matters. Byte-exact MuPDF re-rendering gives us a *generative* OCR: for any
hypothesis string, render and compare bytes.

## Verification of prior-session claims (asked 2026-07-07)

| Claim | Verdict | Evidence |
|---|---|---|
| templates/ is a merged accumulation (hand cuts + harvests) | ✅ Confirmed | 1463 PNGs on disk vs 952 in synth-manifest vs 1065 in template_metrics; the 398 extras are RGBA (hand cuts), harvest files are RGB; metrics−manifest = 113 pooled from earlier harvest |
| live dict metrics are measured/pooled (anchor spread, anchorShare) | ✅ Confirmed | anchorRange mean 0.198, p95 0.477, max 1.398; anchorShare present (=1.0 throughout) |
| live dict carries neighbour-bleed columns | ⚠️ Plausible, indirect | trim=true + templateLeftCrop=1 mean windows cut into glyphs' own AA; all 38 tested occurrences had ink in flanking columns (own AA, not provably neighbour ink) |
| live dict wrong for render tests | ❌ Practically wrong | Worked fine as **locators**: byte-exact occurrences on pages + core-column scoring sidestep trim/bleed entirely; no fresh harvest needed |
| current dict is `--min-width 5` | ❌ Wrong | metrics min width = 1 |
| fresh untrimmed harvest = best test set | ➖ Superseded | reasonable, but page-occurrence protocol (above) is cleaner and needs no regeneration; also `source.pdf` (340 pp) is gone from workspace — only v3.pdf (34 pp) remains |
| unbounded trim set ~450 templates | ✅ Now credible | fontgen census: 466 distinct single-glyph (char,phase) cores among harvest templates (session 2) |
| 52 styled rows not harvested | ❓ Unverifiable here | no styled-row data in workspace |
| templates are byte-exact crops of page raster | ✅ Confirmed | top templates match v3 pages byte-exactly (22/25 with hits on pp1–3); source.pdf and v3.pdf share one pipeline |
| occurrence counts in synth-manifest usable as weights | ✅ Confirmed | `count` per entry, e.g. A_UPPER_1 = 14 573 |
| pages are 816×1056 rasters in a PDF | ✅ Confirmed | 34 images, all 816×1056 DeviceGray 8-bit FlateDecode |
| pure grayscale AA, no LCD subpixel | ✅ Confirmed | v3+source stored DeviceGray; email.pdf RGB pages explained: hyperlink-blue content (session 2), text AA is gray everywhere |
| unhinted outlines | ✅ Confirmed | unhinted FreeType matches; hinted/autohint controls much worse (MAD 14–22) |
| pen x quantized to ¼ px, ~±0.03 jitter | ✅ Confirmed + mechanism | free 1/64-phase optimizer chose exact ¼ multiples in 36/36 targets; MuPDF x-sweep shows 4 buckets/px. Jitter lives in *layout* coords (pooled anchors sit at k/4 − 0.002..0.024); raster itself is exactly snapped |
| integer baselines | ✅ Confirmed | winning dy identical (−11) across all targets; template box top = baseline − 11 (= TNR cap height 10.48 rounded up) |
| Chrome/Skia does NOT reproduce (mean Δ 10–40) | ➖ Consistent, superseded | can't re-run their Path2D harness (script gone); our gamma/hinting controls show 10–40-level misses look like; MuPDF exactness makes the Skia question moot for the raster (Skia may still be the *layout* source via Chrome print-to-PDF, which writes vector text, not Skia pixels) |
| "probably Mac or Linux" | ❌ Killed | Quartz stem darkening would give dark-biased residuals — not observed; answer is a **PDF rasterizer (MuPDF)**, OS-agnostic |
| Apple-Mail boundaries in document | ✅ Confirmed | p1: `--Apple-Mail=_19991871-70E1-4927-8209-37E2702BFAED` |
| EFTA docs = Word-2010-no-kerning family | ❓ Unverifiable here | no EFTA data in workspace |

## Workspace (after session-2 simplification)

```
v3.pdf, v3.txt  34-page image PDF + its raw quoted-printable text (has spaces!)
corpus/
  source.pdf    340-page harvest source (restored); source.txt = its bad OCR layer
  email.pdf     36 pp sibling doc, PDFium wrapper, RGB link pages; email.txt = bad OCR
  synth-manifest.json, template_metrics.json   harvest statistics (counts, anchors)
  templates_archive.zip   all 1465 old template files, frozen (delete-safe backup)
fonts/          generated glyph sets (<font>_<size>.npz via fontgen)
pages/          lossless page extractions: pNNN.png (v3), source/, email/
tools/
  fontgen.py    THE generator: any font -> byte-exact glyph rasters, 8 phases, advances
  fontid.py     which (font,size) is this page? exact-hit ranking
  validate_fontgen.py  regenerability census vs archived harvest templates
  extract_pages.py     corpus PDF -> pages/<stem>/pNNN.png (+channel check)
  archive/      retired phase-1 evidence scripts (see its README)
NOTES.md        this file
```

Facts to reuse: template box = rows (baseline−11 … baseline+3), 15 px; ascender
ink (h,k,l,i,j,d,b) reaches baseline−12 and was CLIPPED by the harvest box.
Metrics header: fontSpec "16px Times New Roman", templateLeftCrop=1,
`anchor: 45` (header field — meaning still unknown), exact=true.
Windows TNR 7.12 (`C:\Windows\Fonts\times.ttf`) outline-compatible with corpus.
fontid candidates resolve as C:\Windows\Fonts\<name>.ttf (`.ttc` not supported yet).

## Roadmap (multi-session)

**Phase 1 — rasterizer: DONE** (this session). Optional hardening: test older
MuPDF versions (1.18…1.26) for byte-drift → could date the artifact; check
AGPL mutool cmdline defaults match (`mutool draw -r 96 -c gray`).

**Phase 1b — font-generic tooling: DONE** (session 2): fontgen/fontid; template
dict retired.

**Phase 2 — layout engine** (next): reconstruct line layout of v3 pages from
v3.txt + TNR metrics: cumulative fractional advances, kerning pairs on/off,
wrap width, line pitch (baselines), margins (first ink row 71 on p1), space
width handling, tab/wrap of quoted-printable `=`-continuations. Compare against
Chrome print-to-PDF of a minimal HTML wrap (16px default serif), wkhtmltopdf,
WeasyPrint. Deliverable: layout function that predicts every pen x to ±0.03 px
pre-snap. Also: locate the "52 styled rows" in source.pdf (rows regular-TNR16
rasters fail to explain → scan with fontid per line band; timesbd/timesi sets
gave 0 hits on early pages), and email.pdf's wrapper differences (PDFium,
redactions, link-blue pages) may mean a different producer chain → compare
layouts across docs before assuming one layout engine.

**Phase 3 — full-page byte reproduction**: v3.txt → layout → MuPDF raster →
assert pages/pXXX.png byte-equality (modulo OCR-layer-only diffs). 100% = goal.

**Phase 4 — payload recovery**: byte-perfect OCR of base64 attachment pages via
generate-and-compare; decode → reconstruct original attached PDF; validate
(xref consistency, %%EOF, renders).

**Phase 5 — provenance write-up**: wrapper-writer fingerprint (`/Name /Im0`,
no-metadata style, \r\n), OCR-engine fingerprint (span pattern, Type1 base
fonts), MuPDF version window, layout-tool identity.

### Wants from user (when convenient)
- ~~source.pdf~~ ✅ restored in corpus/ (session 2).
- The old harness (`synth-templates.mjs` etc.) if it exists anywhere — not
  required (protocol re-derived), but nice for closing the Skia claim formally.
- If other documents from this production exist (other fonts?), drop them in
  corpus/ — fontid will identify their font in one command.
- If OK: corpus/templates_archive.zip is a delete-safe backup of the old
  template dict; say the word and it goes too (everything regenerates).
- Nothing needs installing; everything runs locally.

---

## 2026-07-11 PM — report.pdf renderer SOLVED (see REPORT_RENDERER_HUNT.md)

Producer = modern MuPDF glyph coverage (1.14–1.27 render bit-identically)
+ the eDiscovery tool's own alpha compositing: single glyph byte map
g→g+1 for g∈128..254 (else identity), overlap law
`floor(rb1*rb2/255) + Σ[light glyph]` — fitted 0/499 on all double-overlap
pixels. Old-mutool / old-FreeType theories ruled out by direct test
(FT 2.6.5→2.13.2 bit-identical; mupdf 1.4–1.11 worse than modern).

Deliverables landed this session:
- tools/fontgen.py `--linear` + regenerated fonts/*lin_16.npz (+ tnr8lin
  @10.667px superscript) and bench glyphs_*lin*.json exports.
- char_training/bench/blind-read.mjs: linear-set blend law + shift canvas;
  jsonLines now include per-glyph pens (for overlap harvesting).
- report.pdf blind read at **tol 0**: 220 lines, 12,751 glyphs, 41 □
  clusters left (was tol 10 / ~10 □ before; superscript ordinals like
  "71st" now read via tnr8lin10).

Remaining tail is listed in REPORT_RENDERER_HUNT.md: ~15 recurring ±1
junction pixels (harvest from failing lines via report.json pens), the
col-456/348/378 unknown glyphs, and porting R+overlap law into the
--verify re-render path.

Workspace trimmed per request: deleted mupdf/ (old builds + FT sources),
hunt/ scratch (downloads/renders — stub regenerable via tools/hunt_renderer.py),
stale phase-1 logs (handcut_census, pair_census, scan_fails), proof-B pngs,
tools/archive (superseded probe scripts). corpus/, pages/, fonts/, tools/
kept for the roadmap phases.

### 2026-07-11 late PM — overlap law finalized, tol-0 read at 5 fail events

Model J confirmed on 925 harvested double-overlap pixels (922 exact, 3 our-
side +1 -> one-sided composite slack in the reader). "Light" semantics
pinned in REPORT_RENDERER_HUNT.md (raw [128,254] == linear [129,255], gb=255
drops out of ink). Ligature theory tested and rejected (fi/fl words are
separate f+i / f+l on this page). Full doc now: 220 lines, 12,751 glyphs,
**5 fails at tol 0**, all root-caused as reader object-handling:
redaction-box over-padding (p6 695/748 — page continues "and SARAH KELLEN"
after the box!), a vrule false-positive eating a 'g' (p6 676), and two
f-b junction pixels off by 5 (p5 460, p6 313; read at tol 1).
Next: box-padding + vrule fixes in blind-read.mjs, then --verify port.

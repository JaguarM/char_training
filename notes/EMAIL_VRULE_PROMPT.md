# Prompt: email.pdf — light-gray quote bar merges all bands into one

Read `notes/README.md` first (physics + regression gate), then the
`detectObjects` sections of `bench/blind-read.mjs` and `blindocr.js` (kept in
sync — every fix lands in BOTH). Don't re-derive the root cause; it is
measured and confirmed below.

## Symptom

App: open `corpus/email.pdf`, press **Auto OCR** → every line lands in ONE
detected band (one "line"). Bench `blind-read.mjs` on the same pages will
show the same failure mode: one giant ink band per page.

## Confirmed root cause (measured 2026-07-12)

Every email.pdf page draws an HTML **blockquote quote bar**: a vertical line
at **column 56, constant gray 204, 982 contiguous rows (y 37–1018), zero
pixels darker than 160** (verified on p1–p6; expect all 36 pages, sometimes
multiple bars at increasing x for nested quotes — measure). `detectObjects`
finds objects only via dark ink (`gray < 160`), so the bar is never detected
as a vrule, never masked — and since `findBands` calls a row "inked" if ANY
unmasked ink exists, column 56 alone welds every text row and every blank
inter-line row into one band. Baseline pinning then fails or picks one row;
everything else is unexplained.

## Fix direction

Extend object detection to light rules. A safe signature: a contiguous
vertical ink run (`gray < 255`) that is **long (≥40 rows, current threshold)
and near-constant in value** (e.g. max−min ≤ 8 within the run) is a rule
regardless of darkness — text can never fake it, because inter-line blank
rows break column runs (tallest glyph stacks are ~15 rows). Keep the current
dark-run rule as-is; add the light-constant rule alongside, for vcols and —
check whether email has light horizontal separators too — row runs.
Considerations:

- Threshold interplay: the ±2 padded mask must swallow the bar's AA columns
  (measure the bar's true width; likely 1–2 px + AA).
- The vrule-in-box drop filter and box segment logic must not regress
  (report-raster + v3 P5/P6 are the sensitive regression cases).
- The bar must come out REPORTED as an object (app draws vrules as overlays).

## After bands split, expect (and handle) the rest of email.pdf

- Fonts: same corpus MuPDF family as v3 (TNR 12pt@96dpi) — `glyphs_times16`
  should read it at tol 0. `corpus/email.txt` exists as soft truth (known
  truth-defect family: its exporter drops chars — check pixels before blaming
  the reader).
- Page 1 is mode-2 (real color: hyperlink blue). Bench `readGray` already
  handles mode-2 (neutral-sum gray + colored-ink flood). **The app does not**:
  `blindocr.js` reads the engine's (R+G+B)/3 buffer, where blue text appears
  as gray ink → unexplained □s. If in-app email must read clean, port the
  color handling — the app has canvas RGBA available, so per-pixel R==G==B is
  cleaner than the bench's sum%3 trick. (The app port also still lacks
  `--union` / strike suppression / `--quant` — same porting session if time.)
- Quoted lines start right of the bar with `>` markers already in the text
  layer? No — the bar IS the quote marker; expect plain text at a larger left
  margin. Space calibration should be unaffected (measured per document).

## Harness notes

- Raster cache key `6ee8451ef0704cc4` (36 pages; p1 mode 2, rest mode 1) —
  populated, never re-rasterize. Repro of the root-cause measurement: scan
  each column for its longest contiguous sub-255 run and print runs ≥100 rows
  with their min gray (a 10-line node script against the cache).
- App path test: `bench/test-blind-app.mjs` (add an email page case once it
  reads).
- Full regression gate + expected numbers: `notes/README.md`. Update those
  numbers there if the gate legitimately changes, and append results to
  `notes/BLIND_READER.md` (newest at bottom).

## Deliverables

- Both `detectObjects` implementations detect + mask + report light rules;
  email.pdf bands split correctly in bench AND app.
- A blind read of email.pdf (all 36 pages) vs `corpus/email.txt`, honest
  numbers, divergences classified (reader error vs truth defect vs
  known-limit □).
- Regression gate green; notes updated.

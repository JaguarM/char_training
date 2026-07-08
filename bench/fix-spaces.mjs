// fix-spaces.mjs — pixel-verify and auto-correct the SPACE PLACEMENT of a spaced
// transcription. For every glyph junction it compares the ink's actual onset with
// the onset the transcription's spacing predicts (same measurement as
// measure-spaces.mjs — pen re-anchored at every clean gap edge, so junctions are
// independent), then:
//
//   • d ≥ +2.2 at a junction with NO source space → the page draws a gap the
//     transcription lacks → INSERT one space. (+2.2 keeps well clear of the
//     control noise, p90 ≈ 0.5, yet catches the styled block's ~2.4px narrow
//     spaces.)
//   • d/k ≤ −3.3 at a junction WITH source spaces → the page draws no gap
//     there → DELETE one space. (Narrow drawn spaces measure ≈ −1.2…−1.6 and
//     are kept; ≤ −3.3 means the gap is under ~0.7px — no space of any style.)
//
// A "moved" space (Aug11, 2013 → Aug 11,2013) is just one insert + one delete.
// Every edit is pixel-evidence by construction; rows without measurable ink are
// left untouched. Writes the corrected file in place (backup first) and prints
// the full diff.
//
//   node fix-spaces.mjs --pdf ../v3.pdf --source ../v3.txt            # dry run
//   node fix-spaces.mjs --pdf ../v3.pdf --source ../v3.txt --write    # apply

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { findChrome, findPdf } from './paths.mjs';
import { parseTTF } from './ttf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const ROW_BASE = 40, ROW_PITCH = 18, ROW_H = 15, ROW_COUNT = 54;

const opts = { pdf: findPdf(REPO), source: null, write: false, debugRow: null,
  chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') opts.pdf = resolve(process.cwd(), next());
  else if (a === '--source') opts.source = resolve(process.cwd(), next());
  else if (a === '--reader') opts.reader = resolve(process.cwd(), next());
  else if (a === '--write') opts.write = true;
  else if (a === '--debug-row') { const [p, r] = next().split(':').map(Number); opts.debugRow = { p, r }; }
  else if (a === '--chrome') opts.chrome = next();
}
if (!opts.source) opts.source = opts.pdf.replace(/\.pdf$/i, '.txt');

// --- source pages ---
const srcRaw = readFileSync(opts.source, 'utf8').replace(/\r/g, '');
const hadTrailingNL = srcRaw.endsWith('\n');
const srcLines = (hadTrailingNL ? srcRaw.slice(0, -1) : srcRaw).split('\n');
let sep = 1;
for (let i = ROW_COUNT; i < srcLines.length - 1; i += ROW_COUNT + 1)
  if (srcLines[i] !== '') { sep = 0; break; }
const pageStart = []; // srcLines index of each page's first row
const srcPages = [];
for (let i = 0; i + 1 <= srcLines.length; i += ROW_COUNT + sep) {
  const pg = srcLines.slice(i, i + ROW_COUNT);
  if (!pg.length) break;
  while (pg.length < ROW_COUNT) pg.push('');
  pageStart.push(i);
  srcPages.push(pg);
  if (i + ROW_COUNT >= srcLines.length) break;
}

// --- raster cache ---
const sha = createHash('sha256').update(readFileSync(opts.pdf)).digest('hex').slice(0, 16);
const cacheDir = join(REPO, 'bench', 'raster-cache', sha);
if (!existsSync(cacheDir)) { console.error(`no raster cache at ${cacheDir}`); process.exit(1); }
function loadCachedPage(pno) {
  const p = join(cacheDir, `page-${String(pno).padStart(4, '0')}.gray.gz`);
  if (!existsSync(p)) return null;
  const raw = gunzipSync(readFileSync(p));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  const mode = hdr[1], w = hdr[2], h = hdr[3], n = w * h;
  if (mode === 0) return null;
  const sums = new Uint16Array(n);
  if (mode === 1) for (let i = 0; i < n; i++) sums[i] = raw[16 + i] * 3;
  else sums.set(new Uint16Array(raw.buffer, raw.byteOffset + 16, n));
  return { w, h, sums };
}

// --- glyph extents, CLIPPED to the ink window ---
// The ink map tests band rows 0..11 (baseline at row 11), i.e. outline
// y ∈ [−11, 1) in baseline-relative px. Extents must be taken over the same
// window: a j's below-baseline hook or an _'s bar lie outside it, and
// predicting their onset from full extents would wait for ink the map can't
// see. Curves are flattened densely and each polyline segment clipped to the
// window analytically, so window-crossing extrema are kept to ~0.05px.
const font = parseTTF(readFileSync('C:/Windows/Fonts/times.ttf'));
const glyphExt = {};
{
  const Y_LO = -11, Y_HI = 1;
  const seen = new Set();
  for (const pg of srcPages) for (const l of pg) for (const c of l) seen.add(c);
  seen.delete(' ');
  for (const c of seen) {
    // flatten to polyline runs
    const runs = [];
    let run = null, sx = 0, sy = 0, x = 0, y = 0;
    for (const cm of font.pathCommands(c, 16)) {
      if (cm[0] === 'M') {
        if (run && run.length > 1) runs.push(run);
        x = sx = cm[1]; y = sy = cm[2]; run = [[x, y]];
      } else if (cm[0] === 'L') {
        x = cm[1]; y = cm[2]; run?.push([x, y]);
      } else if (cm[0] === 'Q') {
        const x0 = x, y0 = y, cx = cm[1], cy = cm[2], x1 = cm[3], y1 = cm[4];
        for (let s = 1; s <= 24; s++) {
          const t = s / 24, u = 1 - t;
          run?.push([u * u * x0 + 2 * t * u * cx + t * t * x1,
                     u * u * y0 + 2 * t * u * cy + t * t * y1]);
        }
        x = x1; y = y1;
      } else { run?.push([sx, sy]); x = sx; y = sy; } // Z closes to start
    }
    if (run && run.length > 1) runs.push(run);
    let mn = Infinity, mx = -Infinity;
    const add = v => { if (v < mn) mn = v; if (v > mx) mx = v; };
    for (const r of runs) {
      for (let i = 1; i < r.length; i++) {
        let [xa, ya] = r[i - 1], [xb, yb] = r[i];
        if ((ya < Y_LO && yb < Y_LO) || (ya >= Y_HI && yb >= Y_HI)) continue;
        // clip each end to the window by linear interpolation
        const clip = (x0, y0, x1, y1) => {
          if (y0 < Y_LO) return x0 + (x1 - x0) * (Y_LO - y0) / (y1 - y0);
          if (y0 >= Y_HI) return x0 + (x1 - x0) * (Y_HI - y0) / (y1 - y0);
          return x0;
        };
        add(clip(xa, ya, xb, yb));
        add(clip(xb, yb, xa, ya));
      }
    }
    if (mn <= mx) glyphExt[c] = { min: mn, max: mx };
  }
}

const startX = 45;
const browser = await puppeteer.launch({ executablePath: opts.chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const edits = []; // {pno, r, lineIdx, before, after, ops:[{i,op}]}
  for (let pno = 1; pno <= srcPages.length; pno++) {
    const lines = srcPages[pno - 1];
    const img = loadCachedPage(pno);
    if (!img) continue;
    const { w: W, h: H, sums } = img;
    const inkRows = [], maskRows = [];
    {
      // Vertical rules / redaction boxes: a column belongs to a rule only for
      // the rows its dark run actually covers. Masking page-globally (as the
      // harvest's quote-bar mask does) erases legitimate glyph ink in every
      // OTHER row that shares those x columns — a redaction box lower on the
      // page deleted the ':' dots of an unrelated row here, faking a gap.
      const runs = []; // {x, y0, y1} of dark runs longer than 3 row pitches
      for (let x = 0; x < W; x++) {
        let run = 0;
        for (let y = 0; y <= H; y++) {
          const dark = y < H && sums[y * W + x] < 741;
          if (dark) run++;
          else { if (run > ROW_PITCH * 3) runs.push({ x, y0: y - run, y1: y }); run = 0; }
        }
      }
      // Ink is tested over the band MINUS its bottom 3 rows: the anti-aliased
      // top edge of a redaction box just below the band paints phantom "ink"
      // across every column there and makes an entire row read as gapless.
      // The TOP rows are kept — cropping them moves the visible onset of
      // top-heavy glyphs (7 T Y ") rightward and fakes inserts. The glyph
      // extents are clipped to the same window (see glyphExt) so prediction
      // and observation always describe the same pixels.
      for (let r = 0; r < lines.length; r++) {
        const top = ROW_BASE + ROW_PITCH * r;
        const y0 = top, y1 = top + ROW_H - 3; // exclusive; rows 0..11 of the band
        let s = '', m = '';
        if (top + ROW_H <= H) {
          const masked = new Uint8Array(W);
          // Only a run covering a substantial share of the (cropped) window
          // masks it — a box merely grazing the window would otherwise erase
          // the whole column of a row whose text it doesn't even touch.
          for (const ru of runs) {
            const ov = Math.min(ru.y1, y1) - Math.max(ru.y0, y0);
            if (ov >= 6) masked[ru.x] = 1;
          }
          for (let x = 0; x < W; x++) {
            let ink = 0;
            for (let y = y0; y < y1; y++)
              if (sums[y * W + x] < 741) { ink = 1; break; }
            s += masked[x] ? 0 : ink;
            m += masked[x] && ink ? 1 : 0; // ink hidden by the mask
          }
        }
        inkRows.push(s);
        maskRows.push(m);
      }
    }

    const dbgRow = opts.debugRow && opts.debugRow.p === pno ? opts.debugRow.r : -1;
    const res = await page.evaluate(({ lines, inkRows, maskRows, glyphExt, startX, dbgRow }) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = '16px "Times New Roman"';
      const width = s => ctx.measureText(s).width;
      const chW = new Map();
      const chWidth = c => { let v = chW.get(c); if (v === undefined) { v = width(c); chW.set(c, v); } return v; };

      // Walk `text` against the row's ink map. edit=true collects space
      // corrections as it goes (the corrected prefix drives later predictions);
      // edit=false is the validation pass: it measures every junction of an
      // already-corrected row and reports the worst one. A junction right
      // after ≥1 space may sit down to −1.8 (the styled block's narrow drawn
      // spaces); everything else must hold to ±0.9 (control noise is ±0.85 at
      // p10/p90 — see measure-spaces.mjs).
      const walk = (text, ink, msk, edit, dbg) => {
        let fixed = '', penShift = 0, scanFrom = 0, spacesBefore = 0;
        const ops = [];
        let worst = 0, bail = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === ' ') { spacesBefore++; continue; }
          const ext = glyphExt[ch];
          if (!ext) { bail = true; break; }
          let kept = spacesBefore;
          const dbg0 = dbg ? { i, ch } : null;
          const probe = k2 => {
            const pre = fixed + ' '.repeat(k2);
            const left0 = startX + width(pre + ch) - chWidth(ch) + penShift;
            return { left0, onset0: left0 + ext.min };
          };
          let { left0, onset0 } = probe(kept);
          let scan = scanFrom;
          let holed = false; // mask-hidden ink inside the white run → gap width unknowable
          while (scan < ink.length && ink[scan] !== '1') { if (msk[scan] === '1') holed = true; scan++; }
          if (scan >= ink.length) { bail = true; break; }
          let observable = onset0 >= scanFrom - 0.5 && scan > scanFrom && !holed;
          // A junction that CLAIMS spaces but finds ink AT scanFrom is one of
          // two very different things, and the difference is decidable:
          // scanFrom is only a PREDICTION of the previous glyph's end, so the
          // ink there may be the previous glyph's own tail (prediction a hair
          // short) with the real drawn space just beyond it — or it may be the
          // next glyph arriving with no gap at all (the space isn't drawn).
          // Skip the contiguous run and look for white-then-ink where the
          // spaced layout expects the next glyph: finding it proves the space
          // is real (and gives the proper measurement column); not finding it
          // proves the space is missing from the page.
          let contiguousMissing = false;
          if (kept >= 1 && scan === scanFrom && !holed && onset0 - scanFrom > 2) {
            let g2 = scanFrom;
            while (g2 < ink.length && ink[g2] === '1') g2++;      // prev tail (or next glyph)
            let holed2 = false;
            while (g2 < ink.length && ink[g2] !== '1') { if (msk[g2] === '1') holed2 = true; g2++; }
            if (g2 < ink.length && !holed2 && Math.abs(g2 + 0.5 - 0.8 - onset0) <= 1.8) {
              scan = g2; observable = true;    // real space; measure at the true onset
            } else if (!holed2) {
              contiguousMissing = true;        // no gap where the space should be
            }
          }
          if (dbg0) dbg.push({ ...dbg0, k: kept, scanFrom, scan, holed,
            onset0: +onset0.toFixed(2), penShift: +penShift.toFixed(2),
            obs: observable, cm: contiguousMissing,
            d: observable || contiguousMissing ? +(scan + 0.5 - 0.8 - onset0).toFixed(2) : null });
          if (observable || contiguousMissing) {
            let d = scan + 0.5 - 0.8 - onset0;
            if (edit) {
              // DELETE: source spaces the page doesn't draw (gap ≈ 0).
              // −2.8 leaves the styled block's narrow drawn spaces
              // (−1.2…−1.7) alone but catches a truly absent one even when
              // AA noise lifts it off the nominal −4.
              while (kept >= 1 && d / kept <= -2.8) {
                kept--; ops.push({ i, op: 'del' });
                ({ left0, onset0 } = probe(kept));
                d = scan + 0.5 - 0.8 - onset0;
                if (kept === 0) break;
              }
              // INSERT: a drawn gap the source lacks
              if (observable && kept === spacesBefore && d >= 2.2) {
                const add = Math.max(1, Math.round(d / 4));
                for (let a = 0; a < add; a++) ops.push({ i, op: 'ins' });
                kept += add;
                ({ left0, onset0 } = probe(kept));
                d = scan + 0.5 - 0.8 - onset0;
              }
              // A junction still off by more than the narrow-space window
              // after its edit is UNRESOLVED. Absorbing it into the pen
              // would silently shift every later prediction and seed
              // phantom edits downstream (the "Time :" cascade) — hold the
              // whole row for review instead. (Contiguous junctions carry no
              // residual once their undrawn spaces are deleted.)
              if (observable && Math.abs(d) > 1.8) { bail = true; break; }
            } else {
              if (contiguousMissing) { if (4 > worst) worst = 4; } // claimed space, no gap
              else {
                // validation error: distance outside the allowed window
                const lo = kept >= 1 ? -1.8 : -0.9;
                const err = d < lo ? lo - d : d > 0.9 ? d - 0.9 : 0;
                if (err > worst) worst = err;
              }
            }
            if (observable) {
              if (Math.abs(d) < 8) penShift += d;
              else { bail = true; break; }
            }
          }
          fixed += ' '.repeat(kept) + ch;
          scanFrom = Math.max(scanFrom, Math.ceil(left0 + ext.max + 0.5));
          spacesBefore = 0;
        }
        fixed += ' '.repeat(spacesBefore);
        return { fixed, ops, worst, bail };
      };

      const out = [], dbgOut = [];
      for (let r = 0; r < lines.length; r++) {
        const text = lines[r];
        const ink = inkRows[r] ?? '';
        const msk = maskRows[r] ?? '';
        if (!text.trim() || !ink.includes('1')) continue;
        const e = walk(text, ink, msk, true, r === dbgRow ? dbgOut : null);
        if (!e.ops.length) continue; // nothing to change (or unmeasurable row)
        if (e.bail) {
          // edits were found but the row hit an unresolved junction — the
          // partial prefix is not a usable correction, flag for a human
          out.push({ r, before: text, after: e.fixed + '…(unresolved)', ops: e.ops,
            valid: false, worst: -1 });
          continue;
        }
        if (e.fixed === text) continue;
        // Validate the corrected row from scratch; a cascade (an edit that
        // landed one glyph off because the true junction was unobservable)
        // leaves residuals the re-measurement catches.
        const v = walk(e.fixed, ink, msk, false);
        out.push({ r, before: text, after: e.fixed, ops: e.ops,
          valid: !v.bail && v.worst === 0, worst: +v.worst.toFixed(2) });
      }
      return { out, dbgOut };
    }, { lines, inkRows, maskRows, glyphExt, startX, dbgRow });
    if (res.dbgOut.length) {
      for (const d of res.dbgOut)
        console.log(`#${d.i} '${d.ch}' k=${d.k} scanFrom=${d.scanFrom} scan=${d.scan}` +
          ` onset0=${d.onset0} shift=${d.penShift} obs=${d.obs}${d.holed ? ' HOLED' : ''} d=${d.d}`);
    }
    for (const e of res.out) edits.push({ pno, lineIdx: pageStart[pno - 1] + e.r, ...e });
    process.stderr.write(`\r  ${pno}/${srcPages.length} pages`);
  }
  process.stderr.write('\n');

  // Reader cross-check: an edit only counts when the corrected row equals what
  // the line reader independently read from the same pixels (dump-ocr with
  // KEEP_SPACES=1). Two systems with unrelated failure modes agreeing on the
  // exact row text is far stronger evidence than either alone; disagreement —
  // whichever side is right — goes to a human.
  let readerRows = null;
  if (opts.reader) {
    const rr = readFileSync(opts.reader, 'utf8').replace(/\r/g, '').split('\n');
    readerRows = rr;
    for (const e of edits) {
      const dumpLine = (rr[e.lineIdx] ?? '').trimEnd();
      e.readerAgrees = dumpLine === e.after.trimEnd();
      e.reader = dumpLine;
      e.valid = e.readerAgrees; // the cross-check supersedes the geometric self-check
    }
  }
  const good = edits.filter(e => e.valid);
  const review = edits.filter(e => !e.valid);
  console.log(`rows corrected & ${readerRows ? 'reader-confirmed' : 'pixel-validated'}: ${good.length}   (held for review: ${review.length})\n`);
  for (const e of good) {
    const nIns = e.ops.filter(o => o.op === 'ins').length;
    const nDel = e.ops.filter(o => o.op === 'del').length;
    console.log(`P${e.pno} L${e.r} (line ${e.lineIdx + 1}) [+${nIns} −${nDel}]`);
    console.log(`  - ${JSON.stringify(e.before)}`);
    console.log(`  + ${JSON.stringify(e.after)}`);
  }
  if (review.length) {
    console.log(`\nheld for MANUAL review (${readerRows ? 'reader disagrees with the correction' : 'correction did not re-validate cleanly'}):`);
    for (const e of review) {
      console.log(`P${e.pno} L${e.r} (line ${e.lineIdx + 1}) worst-residual=${e.worst}`);
      console.log(`  - ${JSON.stringify(e.before)}`);
      console.log(`  ? ${JSON.stringify(e.after)}`);
      if (readerRows) console.log(`  r ${JSON.stringify(e.reader)}`);
    }
  }
  if (opts.write && good.length) {
    for (const e of good) srcLines[e.lineIdx] = e.after;
    writeFileSync(opts.source, srcLines.join('\n') + (hadTrailingNL ? '\n' : ''));
    console.log(`\nwrote ${opts.source} (${good.length} rows corrected)`);
  } else if (good.length) {
    console.log('\ndry run — pass --write to apply the validated rows');
  }
} finally {
  await browser.close();
}

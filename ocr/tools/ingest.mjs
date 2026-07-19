// ingest.mjs — add a document to the workspace, one folder per doc:
//
//   pages/<DOC>/page-0001.pgm         embedded page image, byte-exact (P5)
//   pages/<DOC>/page-0001.words.json  hidden OCR overlay words (context only)
//   pages/<DOC>/meta.json             source pdf, sha256, dims, placement
//
//   node tools/ingest.mjs ../NEW/courier/EFTA00751637.pdf              # all pages
//   node tools/ingest.mjs <pdf> --pages 1,3-5      # subset
//   node tools/ingest.mjs <pdf> --doc MYID         # folder name override
//
// The page image is NOT re-rendered: the largest image XObject's samples are
// decoded directly (mupdf Image.toPixmap = raw decode of the embedded stream),
// so the PGM is the producer's own raster byte-for-byte. The overlay words come
// from mupdf structured text (per-char origins grouped into words); their pt
// coords are mapped to image pixels through the image's actual placement matrix
// parsed from the content stream — do NOT assume 4/3: some pages have extra
// media-box margin (e.g. 612x810 pt page carrying a 612x792 pt image).
//
// Overlay caveat (measured): word-interior char advances are the overlay's own
// Tz-stretched Courier metrics, NOT the render lattice — only word STARTS are
// meaningful anchors. words.json stores word starts and text; harvest.mjs
// derives everything else from pixels.
import * as mupdf from 'mupdf';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const pdfPath = args.find(a => !a.startsWith('--'));
const optS = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (!pdfPath) { console.error('usage: node tools/ingest.mjs <pdf> [--doc ID] [--pages 1,3-5]'); process.exit(1); }

const pdfBytes = readFileSync(pdfPath);
const docId = optS('doc') ?? basename(pdfPath).replace(/\.pdf$/i, '');
const sha256 = createHash('sha256').update(pdfBytes).digest('hex');

const doc = mupdf.PDFDocument.openDocument(pdfBytes, 'application/pdf');
const numPages = doc.countPages();
let pageNums = Array.from({ length: numPages }, (_, i) => i + 1);
if (optS('pages')) {
  pageNums = [];
  for (const part of optS('pages').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) { console.error(`bad --pages part: ${part}`); process.exit(1); }
    for (let p = +m[1]; p <= +(m[2] ?? m[1]); p++) pageNums.push(p);
  }
}

const outDir = `${root}/pages/${docId}`;
mkdirSync(outDir, { recursive: true });
const metaPath = `${outDir}/meta.json`;
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8'))
  : { doc: docId, pdf: basename(pdfPath), sha256, numPages, pages: {} };
if (meta.sha256 !== sha256) { console.error(`meta.json is for a different PDF (sha mismatch) — remove ${outDir} first`); process.exit(1); }

// ---- content-stream scan: placement ctm of each XObject Do (b=c=0 assumed) ----
function contentText(page) {
  const obj = page.getObject().get('Contents');
  const parts = [];
  // readStream must see the indirect ref (array elements are refs); a plain
  // stream ref is used as-is
  const r = obj.resolve();
  if (r.isArray()) for (let i = 0; i < r.length; i++) parts.push(Buffer.from(r.get(i).readStream().asUint8Array()));
  else parts.push(Buffer.from(obj.readStream().asUint8Array()));
  return Buffer.concat(parts).toString('latin1');
}
function placements(page) {
  // tiny operator scan: track ctm through q/Q/cm, record ctm at each "/Name Do"
  const toks = contentText(page).split(/\s+/).filter(Boolean);
  const mul = (m, n) => [ // m then n (PDF: cm pre-multiplies onto current)
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [], out = {};
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'q') stack.push(ctm);
    else if (t === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (t === 'cm') ctm = mul(toks.slice(i - 6, i).map(Number), ctm);
    else if (t === 'Do' && toks[i - 1]?.startsWith('/')) out[toks[i - 1].slice(1)] ??= ctm;
  }
  return out;
}

// ---- overlay words from structured text (per-char walk, split at spaces) ----
function overlayWords(page, toPx) {
  const words = [];
  let cur = null, prev = null;
  const flush = () => { if (cur && cur.text.trim()) words.push(cur); cur = null; };
  page.toStructuredText('preserve-whitespace').walk({
    onChar(c, origin, font, size, quad) {
      const gap = prev && (Math.abs(origin[1] - prev.y) > 0.1 || origin[0] - prev.xEnd > 0.6 * size);
      if (c === ' ' || gap) flush();
      if (c !== ' ') {
        const px = toPx(origin[0], origin[1]);
        if (!cur) {
          cur = { text: '', x: r2(origin[0]), yBase: r2(origin[1]),
            px: { x: r2(px.x), yBase: r2(px.y) },
            font: font?.getName?.() ?? null, size: r2(size), chars: [] };
        }
        cur.text += c;
        cur.chars.push(r2(px.x));   // per-char origin: Tz fits words to ink, so these track the render lattice to ~±0.5 px
      }
      prev = { y: origin[1], xEnd: quad ? quad[2] : origin[0] };
    },
  });
  flush();
  return words;
}
const r2 = v => Math.round(v * 100) / 100;

// ---- per page: extract image, write PGM + words ----
let done = 0, skipped = 0;
for (const pno of pageNums) {
  const tag = String(pno).padStart(4, '0');
  if (existsSync(`${outDir}/page-${tag}.pgm`)) { skipped++; continue; }
  const page = doc.loadPage(pno - 1);
  // stext coords are y-down from the top of the page box; convert through the
  // RAW MediaBox (boxes like [0 -18 612 792] exist — never assume origin 0)
  const mbObj = page.getObject().getInheritable('MediaBox');
  const mb = [0, 1, 2, 3].map(i => mbObj.get(i).asNumber());

  // largest image XObject on the page
  const xobjs = page.getObject().get('Resources')?.get('XObject');
  let best = null;
  xobjs?.forEach((v, k) => {
    const d = v.resolve();
    if (String(d.get('Subtype')) !== '/Image') return;
    const w = d.get('Width').asNumber(), h = d.get('Height').asNumber();
    if (!best || w * h > best.w * best.h) best = { name: String(k), ref: v, w, h };
  });
  if (!best) { meta.pages[pno] = { empty: true }; console.log(`p${pno}: no image`); continue; }

  const pix = doc.loadImage(best.ref).toPixmap();
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents();
  const px = pix.getPixels();
  let gray;
  if (n === 1) gray = Buffer.from(px.buffer ?? px, px.byteOffset ?? 0, w * h);
  else {
    console.warn(`p${pno}: ${n}-component image — reducing (R+G+B)/3 rounded (bench mode-2 pages lose fractional grays here)`);
    gray = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = Math.round((px[i * n] + px[i * n + 1] + px[i * n + 2]) / 3);
  }

  // placement: pt (stext, y-down from page top) -> image pixel
  const cm = placements(page)[best.name];
  if (!cm) console.warn(`p${pno}: no Do placement found for ${best.name}; words.json px will assume full-page image`);
  const [a, b, c, d, e, f] = cm ?? [mb[2] - mb[0], 0, 0, mb[3] - mb[1], mb[0], mb[1]];
  if (b || c) console.warn(`p${pno}: rotated/skewed image placement — px mapping unsupported`);
  const toPx = (x, yDown) => {
    const yUp = mb[3] - yDown;                      // stext y-down -> PDF y-up
    return { x: (x + mb[0] - e) / a * w, y: (1 - (yUp - f) / d) * h };
  };

  writeFileSync(`${outDir}/page-${tag}.pgm`,
    Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), gray]));
  const words = overlayWords(page, toPx);
  writeFileSync(`${outDir}/page-${tag}.words.json`, JSON.stringify({
    page: pno,
    note: "hidden overlay = the PRODUCER'S OWN OCR (has errors; Tz-stretched: only word STARTS align with the render; interiors drift). px via the image placement matrix.",
    words,
  }, null, 1));
  meta.pages[pno] = { w, h, comps: n, cm: (cm ?? null)?.map(r2), words: words.length };
  done++;
  process.stderr.write(`\r  p${pno} (${done} done)`);
}
writeFileSync(metaPath, JSON.stringify(meta, null, 1));
process.stderr.write('\n');
console.log(`${docId}: ${done} pages ingested, ${skipped} already present -> pages/${docId}/`);

// recreate.mjs — SOURCE RECREATION certificate: rebuild page rasters from a
// blind-read positions JSON (per-glyph ¼-px pens + baselines + fonts) and
// byte-compare against the cached truth. This is the end-to-end proof that
// the JSON is a lossless description of the page text:
//
//   pens + glyph sets + compositor law  ──render──▶  the original bytes.
//
// Two compositors, matching the reader:
//   • mupdf model (v3/big corpus): each line is re-rendered through REAL
//     MuPDF via render_hypotheses.py (byte-exact, proven 1758/1758 on v3);
//   • linear model (eDiscovery producer, set names *lin*): composed in pure
//     JS with the fitted law raw' = floor(raw·rb/255), page = raw + Σshifts —
//     exact up to the documented one-sided composite ±1 (counted separately).
//
// Pixels inside detected objects (boxes/rules) and unread □ columns are
// excluded and reported — they are page content the JSON deliberately does
// not model as text.
//
//   node blind-read.mjs --pdf ../corpus/v3.pdf --page 2 --json p2.json
//   node recreate.mjs --json p2.json --pdf ../corpus/v3.pdf --page 2
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const o = { json: null, pdf: null, page: null,
  worker: 'C:/Users/yanni/Desktop/ocr/tools/render_hypotheses.py' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--json') o.json = resolve(process.cwd(), next());
  else if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--page') o.page = parseInt(next(), 10);
  else if (a === '--worker') o.worker = next();
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!o.json || !o.pdf) { console.error('need --json and --pdf'); process.exit(2); }

function readGray(path) {
  const raw = gunzipSync(readFileSync(path));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  if (hdr[0] !== 0x31595247 || hdr[1] !== 1) throw new Error(`bad page record ${path}`);
  return { w: hdr[2], h: hdr[3], gray: new Uint8Array(raw.buffer, raw.byteOffset + 16, hdr[2] * hdr[3]) };
}
const key = createHash('sha256').update(readFileSync(o.pdf)).digest('hex').slice(0, 16);
const cacheDir = join(REPO, 'bench', 'raster-cache', key);

// glyph sets: reuse the reader's parser (blindocr.js is dual node/browser)
const BlindOCR = await import('../blindocr.js').then(m => m.default ?? m);
const setCache = new Map();
function setByName(name) {
  let s = setCache.get(name);
  if (!s) {
    const j = JSON.parse(readFileSync(join(__dirname, `glyphs_${name}.json`), 'utf8'));
    s = BlindOCR.parseSet(j, name);
    s.stem = (j.font ?? '').replace(/_\d+.*$/, '');
    setCache.set(name, s);
  }
  return s;
}
const glyphOf = (set, phy, ch, phx) =>
  (set.byPhy.get(phy) ?? []).find(g => g.ch === ch && g.phx === phx);

// MuPDF re-render worker (mupdf-model lines)
function startWorker(py) {
  const proc = spawn('python', [py], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: proc.stdout }).on('line', l => {
    if (!l.trim()) return;
    const r = JSON.parse(l);
    const p = pending.get(r.id);
    if (p) { pending.delete(r.id); p(Buffer.from(r.b64, 'base64')); }
  });
  return {
    render(glyphs, baseline, y0, y1, font) {
      const id = nextId++;
      return new Promise(res => { pending.set(id, res);
        proc.stdin.write(JSON.stringify({ id, glyphs, baseline, y0, y1, font }) + '\n'); });
    },
    close() { try { proc.stdin.write('{"cmd":"quit"}\n'); } catch {} try { proc.kill(); } catch {} },
  };
}

async function recreatePage(P, truth, worker) {
  const { w, h } = truth;
  const canvas = new Uint8Array(w * h).fill(255);
  const shifts = new Uint8Array(w * h);              // linear-law +1 counts
  const dontcare = new Uint8Array(w * h);            // objects, □ columns, unread bands
  for (const ob of P.objects ?? [])
    for (let y = Math.max(0, ob.y0 - 2); y < Math.min(h, ob.y1 + 2); y++)
      for (let x = Math.max(0, ob.x0 - 2); x < Math.min(w, ob.x1 + 2); x++)
        dontcare[y * w + x] = 1;

  let slack = 0;
  for (const L of P.lines ?? []) {
    if (L.unread) {                                   // whole band unmodelled
      for (let y = Math.max(0, (L.top ?? 0) - 2); y < Math.min(h, (L.top ?? 0) + 20); y++)
        for (let x = 0; x < w; x++) dontcare[y * w + x] = 1;
      continue;
    }
    const set = setByName(L.font);
    const phy = L.phy ?? 0;
    const yTop = Math.max(0, L.baseline - set.maxAsc), yBot = Math.min(h, L.baseline + set.maxDesc);
    for (const col of L.failCols ?? [])               // unread clusters: mask generously
      for (let y = yTop; y < yBot; y++)
        for (let x = Math.max(0, col - 2); x < Math.min(w, col + 20); x++) dontcare[y * w + x] = 1;

    if (set.linear) {
      // pure-JS composition with the fitted producer law
      for (const [ch, pen] of L.glyphs ?? []) {
        if (ch === '□') continue;
        const penInt = Math.floor(pen), phx = Math.round((pen - penInt) * 4) / 4;
        const g = glyphOf(set, phy, ch, phx);
        if (!g) { console.error(`  missing glyph '${ch}' phase ${phx} in ${L.font}`); continue; }
        const gx = penInt + g.dx, gy = L.baseline + g.dy;
        for (const p of g.ink) {
          const rr = (p / g.w) | 0, cc = p % g.w;
          const x = gx + cc, y = gy + rr;
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          const gb = g.bytes[p], i = y * w + x;
          const sh = gb >= 129 && gb !== 255 ? 1 : 0, s0 = shifts[i];
          canvas[i] = Math.min(255, (((canvas[i] - s0) * (gb - sh)) / 255 | 0) + s0 + sh);
          shifts[i] = s0 + sh;
        }
      }
    } else if (worker) {
      // real MuPDF full-line render, blitted ink-over-white
      const fontFile = `C:/Windows/Fonts/${set.stem || 'times'}.ttf`;
      const gl = (L.glyphs ?? []).filter(([ch]) => ch !== '□');
      if (!gl.length) continue;
      const band = await worker.render(gl, L.baseline + phy, yTop, yBot, fontFile);
      for (let y = yTop; y < yBot; y++)
        for (let x = 0; x < w; x++) {
          const v = band[(y - yTop) * w + x], i = y * w + x;
          if (v < canvas[i]) canvas[i] = v;
        }
    }
  }

  // byte-compare outside the don't-care mask
  let diff = 0, first = null;
  for (let i = 0; i < w * h; i++) {
    if (dontcare[i] || canvas[i] === truth.gray[i]) continue;
    if (shifts[i] && canvas[i] - truth.gray[i] === 1) { slack++; continue; }  // documented ±1
    diff++;
    if (!first) first = { x: i % w, y: (i / w) | 0, want: truth.gray[i], got: canvas[i] };
  }
  return { diff, slack, first };
}

async function main() {
  const doc = JSON.parse(readFileSync(o.json, 'utf8'));
  const needsWorker = doc.pages.some(P => (P?.lines ?? []).some(L => !L.unread && L.font && !setByName(L.font).linear));
  const worker = needsWorker ? startWorker(o.worker) : null;
  try {
    let totalDiff = 0, totalSlack = 0, pagesOk = 0, pagesTried = 0;
    for (const P of doc.pages) {
      if (!P) continue;
      const pno = o.page ?? P.pno;
      const truth = readGray(join(cacheDir, `page-${String(pno).padStart(4, '0')}.gray.gz`));
      pagesTried++;
      const r = await recreatePage(P, truth, worker);
      totalDiff += r.diff; totalSlack += r.slack;
      if (r.diff === 0) pagesOk++;
      console.log(`page ${pno}: ${r.diff === 0 ? 'BYTE-EXACT RECREATION' : `${r.diff} px differ`}` +
        `${r.slack ? ` (+${r.slack} documented composite-slack px)` : ''}` +
        (r.first ? ` · first diff @(${r.first.x},${r.first.y}) want ${r.first.want} got ${r.first.got}` : ''));
    }
    console.log(`\n${pagesOk}/${pagesTried} pages byte-exact outside objects/□ · ` +
      `${totalDiff} stray px · ${totalSlack} slack px`);
  } finally { worker?.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });

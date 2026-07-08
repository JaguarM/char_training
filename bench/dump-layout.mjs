// dump-layout.mjs — emit the kern-correct layout of a spaced transcription as
// JSON: for every page/row/glyph, the exact left edge the measureText model
// places it at (startX + width(prefix+ch) − width(ch)). No page pixels are
// read — this is the pure layout half of synth-templates.mjs, for rendering
// synthetic pages through an external rasterizer.
//
//   node dump-layout.mjs --source ../corpus/v3.txt --out ../notes/layout_v3.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const ROW_COUNT = 54;

const o = { source: join(REPO, 'corpus', 'v3.txt'), out: join(REPO, 'notes', 'layout_v3.json'),
  startX: 45, chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--source') o.source = resolve(process.cwd(), next());
  else if (a === '--out') o.out = resolve(process.cwd(), next());
  else if (a === '--startX') o.startX = parseFloat(next());
  else if (a === '--chrome') o.chrome = next();
}
if (!existsSync(o.source)) { console.error(`no source: ${o.source}`); process.exit(1); }

// page splitting: identical to synth-templates.mjs
const srcRaw = readFileSync(o.source, 'utf8').replace(/\r/g, '');
const srcLines = (srcRaw.endsWith('\n') ? srcRaw.slice(0, -1) : srcRaw).split('\n');
let sep = 1;
for (let i = ROW_COUNT; i < srcLines.length - 1; i += ROW_COUNT + 1)
  if (srcLines[i] !== '') { sep = 0; break; }
const srcPages = [];
for (let i = 0; i + 1 <= srcLines.length; i += ROW_COUNT + sep) {
  const pg = srcLines.slice(i, i + ROW_COUNT);
  if (!pg.length) break;
  while (pg.length < ROW_COUNT) pg.push('');
  srcPages.push(pg);
  if (i + ROW_COUNT >= srcLines.length) break;
}

const browser = await puppeteer.launch({ executablePath: o.chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const pages = await page.evaluate(({ srcPages, startX }) => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '16px "Times New Roman"';
    const chW = new Map();
    const width = s => ctx.measureText(s).width;
    const chWidth = c => { let v = chW.get(c); if (v === undefined) { v = width(c); chW.set(c, v); } return v; };
    return srcPages.map(lines => lines.map(text => {
      const row = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ') continue;
        row.push([ch, startX + width(text.slice(0, i + 1)) - chWidth(ch)]);
      }
      return row;
    }));
  }, { srcPages, startX: o.startX });
  const nGlyphs = pages.flat(2).length / 1; // rows hold [ch,left] pairs
  writeFileSync(o.out, JSON.stringify({ source: o.source, startX: o.startX,
    rowBase: 40, rowPitch: 18, baselineOffset: 11, pages }));
  console.log(`${pages.length} pages, ${pages.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0)} glyphs -> ${o.out}`);
} finally {
  await browser.close();
}

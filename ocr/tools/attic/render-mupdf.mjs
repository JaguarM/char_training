// render-mupdf.mjs — CANDIDATE RENDERER, KNOWN NOT TO MATCH (MuPDF cour10-16
// was excluded in the parent repo; glyph heights and stem weights disagree).
// Kept as (a) the working code template for writing new candidates and (b)
// the baseline score. MuPDF = unhinted FreeType outlines, linear coverage AA.
// If you change something (font file, size, transfer law) and EXACT count
// rises above 0, that change is the discovery.
//
// Default em: measured cell pitch 7.418 px / Courier New advance ratio
// (1229/2048 em) = 12.361 px — trust pixels over any nominal point size.
//
//   npm install            # once, installs mupdf wasm
//   node tools/render-mupdf.mjs [fonts/cour.ttf] [12.3613]
//   node tools/check.mjs candidates/mupdf
import * as mupdf from 'mupdf';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fontFile = process.argv[2] ?? `${root}/fonts/cour.ttf`;
const em = +(process.argv[3] ?? 7.418 / 0.60009765625);
const outDir = `${root}/candidates/mupdf`;
mkdirSync(outDir, { recursive: true });

const font = new mupdf.Font('F', readFileSync(fontFile));
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));

const W = 48, H = 48, PENX = 12, BASEY = 34;
for (const t of targets) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const text = new mupdf.Text();
  const gid = font.encodeCharacter(t.cp);
  // t.phx is the harvest ¼-px phase slot; MuPDF itself quantizes glyph
  // subpixel position to ¼ px in x, ½ px in y.
  text.showGlyph(font, [em, 0, 0, -em, PENX + t.phx, BASEY], gid, t.cp, 0);
  dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  dev.close();
  writeFileSync(`${outDir}/${t.id}.pgm`,
    Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), Buffer.from(pix.getPixels())]));
}
console.log(`wrote ${targets.length} candidates → candidates/mupdf  (em ${em}, ${fontFile})`);
console.log('score them:  node tools/check.mjs candidates/mupdf');

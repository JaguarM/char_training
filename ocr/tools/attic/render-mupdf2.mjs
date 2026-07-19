// render-mupdf2.mjs — CANDIDATE RENDERER: MuPDF glyphs composited N times
// (the solved-family eDiscovery law is MuPDF's own integer blend; drawing the
// same glyph twice reproduces the "darker than raw outline" stems:
// cov119→136→72, cov~103→152→90 — the block's documented 'r' stem bytes).
//
//   node tools/render-mupdf2.mjs --em 12.3607 --draws 2 --ybase 0 --out mp2
//   knobs: --font fonts/cour.ttf  --draws N  --ybase 0|0.5  --rshift
import * as mupdf from 'mupdf';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const EM = parseFloat(optS('em', String(7.418 * 2048 / 1229)));
const DRAWS = parseInt(optS('draws', '2'));
const YBASE = parseFloat(optS('ybase', '0'));
const RSHIFT = args.includes('--rshift');
const FONTF = optS('font', 'fonts/cour.ttf');
const OUT = optS('out', `mp${DRAWS}`);

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const font = new mupdf.Font('F', readFileSync(`${root}/${FONTF}`));
const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
const outDir = `${root}/candidates/${OUT}`;
mkdirSync(outDir, { recursive: true });

const W = 48, H = 48, PENX = 12, BASEY = 34 + YBASE;
const cache = new Map();
for (const t of targets) {
  const key = `${t.cp}_${t.phx}`;
  let bytes = cache.get(key);
  if (!bytes) {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    const gid = font.encodeCharacter(t.cp);
    for (let d = 0; d < DRAWS; d++) {
      const text = new mupdf.Text();
      text.showGlyph(font, [EM, 0, 0, -EM, PENX + t.phx, BASEY], gid, t.cp, 0);
      dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
    }
    dev.close();
    bytes = Buffer.from(pix.getPixels());
    if (RSHIFT) for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 128 && b <= 253) bytes[i] = b + 1;
    }
    cache.set(key, bytes);
  }
  writeFileSync(`${outDir}/${t.id}.pgm`, Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), bytes]));
}
console.log(`wrote ${targets.length} -> candidates/${OUT} (em ${EM}, draws ${DRAWS}, ybase ${YBASE}${RSHIFT ? ', rshift' : ''}, ${FONTF})`);

// pathrender.mjs — render TTF glyph outlines through MuPDF's OWN scan
// converter via fillPath (no glyph-cache subpixel snap: pens can be ANY
// fractional position, unlike fillText which quantizes x to ¼ / y to ½).
// Quads are converted to cubics exactly (standard 2/3 rule) — same as
// MuPDF's own fz_quadto. Exposes single buffers or N-draw composites.
//
//   import { GlyphRenderer } from './pathrender.mjs';
//   const R = new GlyphRenderer('fonts/cour.ttf', W, H);
//   const bytes = R.render(cp, emx, emy, penX, penY, draws);
//
// Self-test (fillPath vs fillText at the 8 snap phases, several glyphs):
//   node tools/pathrender.mjs
import * as mupdf from 'mupdf';
import { readFileSync } from 'node:fs';
import { loadFont } from './ttf.mjs';

export class GlyphRenderer {
  constructor(fontPath, W = 40, H = 40) {
    this.W = W; this.H = H;
    this.ttf = loadFont(fontPath);
    this.upm = this.ttf.unitsPerEm;
    this.outlines = new Map();
  }
  outline(cp) {
    let o = this.outlines.get(cp);
    if (o === undefined) { o = this.ttf.outline(cp); this.outlines.set(cp, o); }
    return o;
  }
  // build a mupdf.Path for cp at scale (sx, sy) px/em, pen (px, py); y-up -> raster
  path(cp, emx, emy, px, py) {
    const o = this.outline(cp);
    if (!o) return null;
    const sx = emx / this.upm, sy = emy / this.upm;
    const P = new mupdf.Path();
    for (const { start, segs } of o.contours) {
      const X = u => px + u * sx, Y = v => py - v * sy;
      let cx = start[0], cy = start[1];
      P.moveTo(X(cx), Y(cy));
      for (const s of segs) {
        if (s.ctrl) {
          const [qx, qy] = s.ctrl, [tx, ty] = s.to;
          const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
          const c2x = tx + (2 / 3) * (qx - tx), c2y = ty + (2 / 3) * (qy - ty);
          P.curveTo(X(c1x), Y(c1y), X(c2x), Y(c2y), X(tx), Y(ty));
        } else P.lineTo(X(s.to[0]), Y(s.to[1]));
        cx = s.to[0]; cy = s.to[1];
      }
      P.closePath();
    }
    return P;
  }
  // N same-position draws composited by mupdf's own blend; returns W*H bytes
  render(cp, emx, emy, penX, penY, draws = 1, dx2 = 0, dy2 = 0) {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, this.W, this.H], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    for (let d = 0; d < draws; d++) {
      const P = this.path(cp, emx, emy, penX + (d ? dx2 : 0), penY + (d ? dy2 : 0));
      dev.fillPath(P, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
      P.destroy();
    }
    dev.close();
    const bytes = Buffer.from(pix.getPixels());
    pix.destroy();
    return bytes;
  }
}

// ---- self-test: fillPath must equal fillText byte-for-byte at snap phases
const selfTest = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('pathrender.mjs');
if (selfTest) {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const fontFile = `${root}/fonts/cour.ttf`;
  const mf = new mupdf.Font('F', readFileSync(fontFile));
  const W = 40, H = 40, PENX = 12, BASEY = 26;
  const R = new GlyphRenderer(fontFile, W, H);
  const configs = [[12.36, 12.36], [12.36, 12]];
  const cps = [46, 101, 109, 103, 72, 48, 95];  // . e m g H 0 _
  let worst = 0, cells = 0, diffs = 0;
  for (const [emx, emy] of configs) {
    for (const cp of cps) {
      for (const fx of [0, 0.25, 0.5, 0.75]) for (const fy of [0, 0.5]) {
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        const text = new mupdf.Text();
        text.showGlyph(mf, [emx, 0, 0, -emy, PENX + fx, BASEY + fy], mf.encodeCharacter(cp), cp, 0);
        dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
        dev.close();
        const ref = Buffer.from(pix.getPixels());
        pix.destroy();
        const got = R.render(cp, emx, emy, PENX + fx, BASEY + fy, 1);
        for (let i = 0; i < ref.length; i++) {
          const d = Math.abs(ref[i] - got[i]);
          if (d) { diffs++; if (d > worst) worst = d; }
          cells++;
        }
      }
    }
  }
  console.log(`fillPath vs fillText: ${diffs}/${cells} bytes differ, worst |d| = ${worst}`);
  console.log(diffs === 0 ? 'CERTIFIED byte-identical — continuous-phase rendering unlocked'
    : 'NOT identical — inspect before trusting continuous phases');
}

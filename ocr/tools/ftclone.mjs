// ftclone.mjs — faithful JS port of the EXACT glyph pipeline inside mupdf
// 1.28 wasm (FreeType 2.13 smooth rasterizer, FT_INT64 build):
//
//   outline funits --(x32 exact, ppem 1024)--> 26.6
//   FT_Outline_Transform with m = trunc(trm*64) per component (16.16),
//     each point: x' = MulFix(x, m.xx) + MulFix(y, m.xy)  [round half away]
//   FT_Outline_Translate by v = (px64, py64)  (26.6 integers)
//   ftgrays: UPSCALE<<2 (26.8), DDA conics, prod-based line walker,
//     cells (cover, area), sweep: coverage = area>>9, ~ on sign, clamp 255
//   mupdf blend per draw over white: dst = (dst*(256-(g+(g>>7))))>>8
//
// All parameters are INTEGERS in 26.6 units: em64x = trunc(emx*64) etc.
// This bypasses fz_subpixel_adjust — pens can sit on ANY 1/64 position,
// which fillText cannot do (it snaps x to 1/4 and y to 1/2).
//
// Certify (must print 0 diffs before any hunt conclusions):
//   node tools/ftclone.mjs            # vs fillText at the 8 snap phases
import { loadFont } from './ttf.mjs';
import { loadCff } from './cff.mjs';

const ONE_PIXEL = 256;
const UPSCALE = x => x << 2;          // 26.6 -> 26.8
const TRUNC = x => x >> 8;
const FRACT = x => x & 255;
const INT_MIN = -2147483648;

// FT_MulFix: (a*b + 0x8000 - (ab<0)) >> 16, arithmetic shift = floor
export function mulfix(a, b) {
  const ab = a * b;                    // |ab| < 2^40 — exact in double
  return Math.floor((ab + (ab < 0 ? 0x7FFF : 0x8000)) / 65536);
}

class Raster {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.rows = Array.from({ length: H }, () => new Map());  // ey -> (ex -> cell)
    this.cur = null;                   // current cell or null (dumpster)
    this.x = 0; this.y = 0;            // 26.8 current position
  }
  setCell(ex, ey) {
    if (ey < 0 || ey >= this.H || ex >= this.W) { this.cur = null; return; }
    ex = Math.max(ex, -1);
    const row = this.rows[ey];
    let c = row.get(ex);
    if (!c) { c = { x: ex, cover: 0, area: 0 }; row.set(ex, c); }
    this.cur = c;
  }
  integrate(a, b) {
    const c = this.cur;
    if (c) { c.cover += a; c.area += a * b; }
  }
  moveTo(x, y) {                       // 26.8 coords
    this.setCell(TRUNC(x), TRUNC(y));
    this.x = x; this.y = y;
  }
  // gray_render_line, FT_INT64 variant (prod walker)
  lineTo(to_x, to_y) {
    let ey1 = TRUNC(this.y), ey2 = TRUNC(to_y);
    if ((ey1 >= this.H && ey2 >= this.H) || (ey1 < 0 && ey2 < 0)) { this.x = to_x; this.y = to_y; return; }
    let ex1 = TRUNC(this.x), ex2 = TRUNC(to_x);
    let fx1 = FRACT(this.x), fy1 = FRACT(this.y);
    let fx2, fy2;
    const dx = to_x - this.x, dy = to_y - this.y;

    if (ex1 === ex2 && ey1 === ey2) { /* inside one cell */ }
    else if (dy === 0) { this.setCell(ex2, ey2); this.x = to_x; this.y = to_y; return; }
    else if (dx === 0) {
      if (dy > 0) do {
        fy2 = ONE_PIXEL;
        this.integrate(fy2 - fy1, fx1 * 2);
        fy1 = 0; ey1++;
        this.setCell(ex1, ey1);
      } while (ey1 !== ey2);
      else do {
        fy2 = 0;
        this.integrate(fy2 - fy1, fx1 * 2);
        fy1 = ONE_PIXEL; ey1--;
        this.setCell(ex1, ey1);
      } while (ey1 !== ey2);
    } else {
      let prod = dx * fy1 - dy * fx1;  // |dx|,|dy| < 2^15 — exact
      const dxr = ex1 !== ex2 ? Math.trunc(0xFFFFFFFF / dx) : 0;   // C signed div: trunc toward 0
      const dyr = ey1 !== ey2 ? Math.trunc(0xFFFFFFFF / dy) : 0;
      const udiv = (a, br) => Math.floor((a * br) / 4294967296);
      do {
        if (prod - dx * ONE_PIXEL > 0 && prod <= 0) {                    /* left */
          fx2 = 0;
          fy2 = udiv(-prod, -dxr);     // FT_UDIV(-prod, -dx): uses reciprocal of -dx
          prod -= dy * ONE_PIXEL;
          this.integrate(fy2 - fy1, fx1 + fx2);
          fx1 = ONE_PIXEL; fy1 = fy2; ex1--;
        } else if (prod - dx * ONE_PIXEL + dy * ONE_PIXEL > 0 &&
                   prod - dx * ONE_PIXEL <= 0) {                          /* up */
          prod -= dx * ONE_PIXEL;
          fx2 = udiv(-prod, dyr);
          fy2 = ONE_PIXEL;
          this.integrate(fy2 - fy1, fx1 + fx2);
          fx1 = fx2; fy1 = 0; ey1++;
        } else if (prod + dy * ONE_PIXEL >= 0 &&
                   prod - dx * ONE_PIXEL + dy * ONE_PIXEL <= 0) {         /* right */
          prod += dy * ONE_PIXEL;
          fx2 = ONE_PIXEL;
          fy2 = udiv(prod, dxr);
          this.integrate(fy2 - fy1, fx1 + fx2);
          fx1 = 0; fy1 = fy2; ex1++;
        } else {                                                          /* down */
          fx2 = udiv(prod, -dyr);
          fy2 = 0;
          prod += dx * ONE_PIXEL;
          this.integrate(fy2 - fy1, fx1 + fx2);
          fx1 = fx2; fy1 = ONE_PIXEL; ey1--;
        }
        this.setCell(ex1, ey1);
      } while (ex1 !== ex2 || ey1 !== ey2);
    }
    fx2 = FRACT(to_x); fy2 = FRACT(to_y);
    this.integrate(fy2 - fy1, fx1 + fx2);
    this.x = to_x; this.y = to_y;
  }
  // gray_render_cubic + gray_split_cubic (FT_INT64 build). controls/to in 26.6!
  cubicTo(c1x6, c1y6, c2x6, c2y6, tx6, ty6) {
    const stack = [];   // arc frames of 4 points, arc = top index
    const A = [];       // flat array of points {x,y}; arc window = A[ai..ai+3]
    for (let k = 0; k < 16 * 3 + 1; k++) A.push({ x: 0, y: 0 });
    let ai = 0;
    A[0].x = UPSCALE(tx6); A[0].y = UPSCALE(ty6);
    A[1].x = UPSCALE(c2x6); A[1].y = UPSCALE(c2y6);
    A[2].x = UPSCALE(c1x6); A[2].y = UPSCALE(c1y6);
    A[3].x = this.x; A[3].y = this.y;
    const H = this.H;
    const t0 = TRUNC(A[0].y), t1 = TRUNC(A[1].y), t2 = TRUNC(A[2].y), t3 = TRUNC(A[3].y);
    if ((t0 >= H && t1 >= H && t2 >= H && t3 >= H) || (t0 < 0 && t1 < 0 && t2 < 0 && t3 < 0)) {
      this.x = A[0].x; this.y = A[0].y; return;
    }
    const split = i => {
      let a, b, c;
      A[i + 6].x = A[i + 3].x;
      a = A[i].x + A[i + 1].x; b = A[i + 1].x + A[i + 2].x; c = A[i + 2].x + A[i + 3].x;
      A[i + 5].x = c >> 1; c += b; A[i + 4].x = c >> 2; A[i + 1].x = a >> 1;
      a += b; A[i + 2].x = a >> 2; A[i + 3].x = (a + c) >> 3;
      A[i + 6].y = A[i + 3].y;
      a = A[i].y + A[i + 1].y; b = A[i + 1].y + A[i + 2].y; c = A[i + 2].y + A[i + 3].y;
      A[i + 5].y = c >> 1; c += b; A[i + 4].y = c >> 2; A[i + 1].y = a >> 1;
      a += b; A[i + 2].y = a >> 2; A[i + 3].y = (a + c) >> 3;
    };
    for (;;) {
      if (Math.abs(2 * A[ai].x - 3 * A[ai + 1].x + A[ai + 3].x) > ONE_PIXEL / 2 ||
          Math.abs(2 * A[ai].y - 3 * A[ai + 1].y + A[ai + 3].y) > ONE_PIXEL / 2 ||
          Math.abs(A[ai].x - 3 * A[ai + 2].x + 2 * A[ai + 3].x) > ONE_PIXEL / 2 ||
          Math.abs(A[ai].y - 3 * A[ai + 2].y + 2 * A[ai + 3].y) > ONE_PIXEL / 2) {
        split(ai); ai += 3;
        if (ai + 6 >= A.length) for (let k = 0; k < 6; k++) A.push({ x: 0, y: 0 });
        continue;
      }
      this.lineTo(A[ai].x, A[ai].y);
      if (ai === 0) return;
      ai -= 3;
    }
  }
  // gray_render_conic, DDA (FT_INT64) variant. control/to in 26.6!
  conicTo(cx6, cy6, tx6, ty6) {
    const p0x = this.x, p0y = this.y;
    const p1x = UPSCALE(cx6), p1y = UPSCALE(cy6);
    const p2x = UPSCALE(tx6), p2y = UPSCALE(ty6);
    if ((TRUNC(p0y) >= this.H && TRUNC(p1y) >= this.H && TRUNC(p2y) >= this.H) ||
        (TRUNC(p0y) < 0 && TRUNC(p1y) < 0 && TRUNC(p2y) < 0)) {
      this.x = p2x; this.y = p2y; return;
    }
    const bx = p1x - p0x, by = p1y - p0y;
    const ax = p2x - p1x - bx, ay = p2y - p1y - by;
    let dx = Math.abs(ax), dyv = Math.abs(ay);
    if (dx < dyv) dx = dyv;
    if (dx <= ONE_PIXEL / 4) { this.lineTo(p2x, p2y); return; }
    let shift = 16;
    do { dx >>= 2; shift--; } while (dx > ONE_PIXEL / 4);
    let count = 0x10000 >>> shift;

    const P32 = 4294967296;
    let rx = ax * 2 ** (shift + shift), ry = ay * 2 ** (shift + shift);
    let qx = bx * 2 ** (shift + 17) + rx, qy = by * 2 ** (shift + 17) + ry;
    rx *= 2; ry *= 2;
    let px = p0x * P32, py = p0y * P32;
    do {
      px += qx; py += qy;
      qx += rx; qy += ry;
      this.lineTo(Math.floor(px / P32), Math.floor(py / P32));
    } while (--count);
  }
  // gray_sweep, nonzero rule (fill = INT_MIN) — writes coverage into out
  sweep(out) {
    for (let y = 0; y < this.H; y++) {
      const cells = [...this.rows[y].values()].sort((a, b) => a.x - b.x);
      if (!cells.length) continue;
      let x = 0, cover = 0, coverage;
      const fillRule = area => {
        let c = area >> 9;                       // PIXEL_BITS*2+1-8
        if (c & INT_MIN) c = ~c;
        if (c > 255) c = 255;
        return c;
      };
      for (const cell of cells) {
        if (cover !== 0 && cell.x > x) {
          coverage = fillRule(cover);
          for (let i = x; i < cell.x; i++) out[y * this.W + i] = coverage;
        }
        cover += cell.cover * (ONE_PIXEL * 2);
        const area = cover - cell.area;
        if (area !== 0 && cell.x >= 0) {
          coverage = fillRule(area);
          out[y * this.W + cell.x] = coverage & 255;
        }
        x = cell.x + 1;
      }
      if (cover !== 0) {
        coverage = fillRule(cover);
        for (let i = x; i < this.W; i++) out[y * this.W + i] = coverage;
      }
    }
  }
}

// FT_DivFix: ((a<<16)/b) with C truncation
export function divfix(a, b) {
  return Math.trunc((a * 65536) / b);
}

export class FTClone {
  constructor(fontPath, W = 40, H = 40) {
    this.W = W; this.H = H;
    if (fontPath.endsWith('.cff')) {
      this.cff = loadCff(fontPath);
      this.upm = this.cff.unitsPerEm;
      this.gidMap = null;              // set via setGidMap (cp -> gid)
    } else {
      this.ttf = loadFont(fontPath);
      this.upm = this.ttf.unitsPerEm;
    }
    // FT loads at char size 65536/64 = 1024pt @72dpi: scale16.16 = DivFix(65536, upm)
    this.scale16 = divfix(65536, this.upm);
    this.cache = new Map();
  }
  setGidMap(map) { this.gidMap = map; }
  // coverage buffer for glyph cp at matrix [em64x,0,0,-em64y]/64 pen (px64,py64)/64
  coverage(cp, em64x, em64y, px64, py64) {
    const key = `${cp}|${em64x}|${em64y}|${px64}|${py64}`;
    let cov = this.cache.get(key);
    if (cov) return cov;
    const R = new Raster(this.W, this.H);
    // funits -> 26.6 at ppem 1024 via MulFix(u, scale16) (exact x32 for upm
    // 2048), then FT_Outline_Transform m=(em64x,-em64y) 16.16, then +v.
    const pre = u => mulfix(u, this.scale16);
    const TX = u => mulfix(pre(u), em64x) + px64;
    const TY = v => mulfix(pre(v), -em64y) + py64;
    if (this.cff) {
      const gid = this.gidMap ? this.gidMap.get(cp) : cp;
      const contours = this.cff.outline(gid);
      if (!contours) return null;
      for (const { start, segs } of contours) {
        const sx = TX(start[0]), sy = TY(start[1]);
        R.moveTo(UPSCALE(sx), UPSCALE(sy));
        for (const s of segs) {
          if (s.c1) R.cubicTo(TX(s.c1[0]), TY(s.c1[1]), TX(s.c2[0]), TY(s.c2[1]), TX(s.to[0]), TY(s.to[1]));
          else R.lineTo(UPSCALE(TX(s.to[0])), UPSCALE(TY(s.to[1])));
        }
        R.lineTo(UPSCALE(sx), UPSCALE(sy));   // decompose closes every contour
      }
      cov = new Uint8Array(this.W * this.H);
      R.sweep(cov);
      this.cache.set(key, cov);
      return cov;
    }
    const o = this.ttf.rawOutline(cp);
    if (!o) return null;
    // Implicit conic midpoints are (a+b)/2 with C truncation, computed in 26.6.
    const half = (a, b) => Math.trunc((a + b) / 2);
    for (const raw of o.contours) {
      if (raw.length < 2) continue;
      // em64 may be fractional in 1/32 steps (16.16 scale granularity for
      // upm 2048): mulfix(p*32, em64) === mulfix(p, em64*32) for integers,
      // so this is a no-op for every integer em64 (certification holds).
      const pts = raw.map(p => ({
        x: mulfix(p.x, Math.round(em64x * 32)) + px64,
        y: mulfix(p.y, -Math.round(em64y * 32)) + py64,
        on: p.on,
      }));
      let limit = pts.length - 1;
      let vStart = pts[0], vLast = pts[limit];
      let i = 0;
      if (!pts[0].on) {
        if (pts[limit].on) { vStart = vLast; limit--; }
        else {
          vStart = { x: half(vStart.x, vLast.x), y: half(vStart.y, vLast.y), on: true };
          vLast = vStart;
        }
        i--;
      }
      R.moveTo(UPSCALE(vStart.x), UPSCALE(vStart.y));
      let closedByConic = false;
      while (i < limit) {
        i++;
        if (pts[i].on) { R.lineTo(UPSCALE(pts[i].x), UPSCALE(pts[i].y)); continue; }
        let vControl = pts[i];
        let done = false;
        while (i < limit) {
          i++;
          const vec = pts[i];
          if (vec.on) { R.conicTo(vControl.x, vControl.y, vec.x, vec.y); done = true; break; }
          const vMiddle = { x: half(vControl.x, vec.x), y: half(vControl.y, vec.y) };
          R.conicTo(vControl.x, vControl.y, vMiddle.x, vMiddle.y);
          vControl = vec;
        }
        if (!done) {          // ran out of points: close with conic to start
          R.conicTo(vControl.x, vControl.y, vStart.x, vStart.y);
          closedByConic = true;
          break;
        }
      }
      if (!closedByConic) R.lineTo(UPSCALE(vStart.x), UPSCALE(vStart.y));
    }
    cov = new Uint8Array(this.W * this.H);
    R.sweep(cov);
    this.cache.set(key, cov);
    return cov;
  }
  // N draws composited with mupdf's integer blend over white
  render(cp, em64x, em64y, px64, py64, draws = 1) {
    const cov = this.coverage(cp, em64x, em64y, px64, py64);
    if (!cov) return null;
    const dst = new Uint8Array(this.W * this.H).fill(255);
    for (let d = 0; d < draws; d++)
      for (let i = 0; i < dst.length; i++) {
        const g = cov[i];
        if (g) dst[i] = (dst[i] * (256 - (g + (g >> 7)))) >> 8;
      }
    return dst;
  }
}

// ---- certification vs mupdf fillText at the 8 representable snap phases
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('ftclone.mjs');
if (isMain) {
  const { default: mupdf } = await import('mupdf').then(m => ({ default: m }));
  const { readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const fontFile = `${root}/fonts/cour.ttf`;
  const mf = new mupdf.Font('F', readFileSync(fontFile));
  const { targets } = JSON.parse(readFileSync(`${root}/targets/index.json`, 'utf8'));
  const cps = [...new Set(targets.map(t => t.cp))];
  const W = 40, H = 40, PENX = 10, BASEY = 28;
  const clone = new FTClone(fontFile, W, H);

  let totalDiff = 0, worst = 0, worstKey = '';
  for (const [emx, emy, em64x, em64y] of [[12.36, 12, 791, 768], [12.36, 12.36, 791, 791]]) {
    for (const cp of cps) {
      // fillText-representable pens only: x snaps to 1/4, y snaps to INTEGER
      // (probe boundary at 0.5 was round-to-int, not floor-to-half: see ftdebug)
      for (const fx64 of [0, 16, 32, 48]) for (const fy64 of [0]) {
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        const text = new mupdf.Text();
        text.showGlyph(mf, [emx, 0, 0, -emy, PENX + fx64 / 64, BASEY + fy64 / 64], mf.encodeCharacter(cp), cp, 0);
        dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
        dev.close();
        const ref = Buffer.from(pix.getPixels());
        pix.destroy();
        const got = clone.render(cp, em64x, em64y, PENX * 64 + fx64, BASEY * 64 + fy64, 1);
        let diffs = 0, w = 0;
        for (let i = 0; i < ref.length; i++) {
          const d = Math.abs(ref[i] - got[i]);
          if (d) { diffs++; if (d > w) w = d; }
        }
        totalDiff += diffs;
        if (w > worst) { worst = w; worstKey = `cp${cp} em64(${em64x},${em64y}) f(${fx64},${fy64})`; }
      }
    }
  }
  console.log(totalDiff === 0
    ? `TTF CERTIFIED: 0 byte diffs across ${cps.length} glyphs x 4 phases x 2 em configs`
    : `TTF NOT certified: ${totalDiff} bytes differ, worst |d|=${worst} at ${worstKey}`);

  // ---- CFF: clone(NimbusMonoPS-Regular.cff) vs fillText(builtin 'Courier')
  const bfont = new mupdf.Font('Courier');
  const cloneC = new FTClone(`${root}/fonts/NimbusMonoPS-Regular.cff`, W, H);
  cloneC.setGidMap(new Map(cps.map(cp => [cp, bfont.encodeCharacter(cp)])));
  totalDiff = 0; worst = 0; worstKey = '';
  for (const [emx, emy, em64x, em64y] of [[12.359375, 12.359375, 791, 791], [12.359375, 12, 791, 768]]) {
    for (const cp of cps) {
      for (const fx64 of [0, 16, 32, 48]) for (const fy64 of [0]) {
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        const text = new mupdf.Text();
        text.showGlyph(bfont, [emx, 0, 0, -emy, PENX + fx64 / 64, BASEY + fy64 / 64], bfont.encodeCharacter(cp), cp, 0);
        dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
        dev.close();
        const ref = Buffer.from(pix.getPixels());
        pix.destroy();
        const got = cloneC.render(cp, em64x, em64y, PENX * 64 + fx64, BASEY * 64 + fy64, 1);
        let diffs = 0, w = 0;
        for (let i = 0; i < ref.length; i++) {
          const d = Math.abs(ref[i] - got[i]);
          if (d) { diffs++; if (d > w) w = d; }
        }
        totalDiff += diffs;
        if (w > worst) { worst = w; worstKey = `cp${cp} em64(${em64x},${em64y}) f(${fx64},${fy64})`; }
      }
    }
  }
  console.log(totalDiff === 0
    ? `CFF CERTIFIED: 0 byte diffs across ${cps.length} glyphs x 4 phases x 2 em configs`
    : `CFF NOT certified: ${totalDiff} bytes differ, worst |d|=${worst} at ${worstKey}`);
}

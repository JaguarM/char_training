// rastold.mjs — JS port of FreeType 2.4.12 ftgrays walkers (the pre-2.6
// CLASSIC smooth rasterizer: gray_render_scanline/line div-mod walkers +
// recursive conic bisection), sharing the certified ftclone conventions:
// 26.6 inputs, UPSCALE<<2 to 26.8, cell (cover, area) accumulation,
// nonzero-winding sweep. Differences vs the 2.13 FT_INT64 build ported in
// ftclone.mjs (known ±1-coverage divergence sources on diagonals/curves):
//   - line walker: per-scanline div/mod chunks instead of the prod walker
//   - conic: recursive midpoint bisection instead of DDA
//   - sweep sign: coverage = -c on negative area (2.13 uses ~c)
// Old FT clamps coverage at >= 256 -> 255 after abs; identical to clamp>255
// for the values reachable here.
import { loadFont } from '../ttf.mjs';
import { mulfix as ftMulfix } from '../ftclone.mjs';
// scaler rounding variants: ft = round half away (FT_MulFix); floor; trunc
const MROUND = {
  ft: ftMulfix,
  floor: (a, b) => Math.floor((a * b) / 65536),
  trunc: (a, b) => Math.trunc((a * b) / 65536),
};

const ONE_PIXEL = 256;
const UPSCALE = x => x << 2;
const TRUNC = x => x >> 8;
const SUBPIX = x => x << 8;

// opts: { line: 'old'|'prod', conic: 'bisect'|'dda', sign: 'neg'|'not' }
// 'prod'/'dda'/'not' = the 2.13 FT_INT64 behavior certified in ftclone.
export class OldRaster {
  constructor(W, H, opts = {}) {
    this.W = W; this.H = H;
    this.lineMode = opts.line ?? 'old';
    this.conicMode = opts.conic ?? 'bisect';
    this.sign = opts.sign ?? 'neg';
    this.div = opts.div ?? 'recip';    // 'recip' = FT 2.10+ FT_UDIV; 'exact' = FT 2.6.1-2.9
    this.raw268 = opts.prec === '268'; // inputs already 26.8: skip UPSCALE
    this.ctol = opts.ctol ? ONE_PIXEL / +opts.ctol : ONE_PIXEL / 4; // conic flatness threshold
    this.rows = Array.from({ length: H }, () => new Map());
    this.cur = null;
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
  add(cover, area) {
    const c = this.cur;
    if (c) { c.cover += cover; c.area += area; }
  }
  moveTo(x, y) {                       // 26.8
    this.setCell(TRUNC(x), TRUNC(y));
    this.x = x; this.y = y;
  }
  // gray_render_scanline (2.4.12): walk cells horizontally within row ey
  scanline(ey, x1, fy1, x2, fy2) {
    let ex1 = TRUNC(x1), ex2 = TRUNC(x2);
    let fx1 = x1 - SUBPIX(ex1), fx2 = x2 - SUBPIX(ex2);
    let dx = x2 - x1;

    if (fy1 === fy2) { this.setCell(ex2, ey); return; }
    if (ex1 === ex2) {
      const delta = fy2 - fy1;
      this.add(delta, (fx1 + fx2) * delta);
      return;
    }
    let p = (ONE_PIXEL - fx1) * (fy2 - fy1);
    let first = ONE_PIXEL;
    let incr = 1;
    if (dx < 0) {
      p = fx1 * (fy2 - fy1);
      first = 0;
      incr = -1;
      dx = -dx;
    }
    let delta = Math.trunc(p / dx);
    let mod = p % dx;
    if (mod < 0) { delta--; mod += dx; }

    this.add(delta, (fx1 + first) * delta);
    let y1 = fy1 + delta;
    ex1 += incr;
    this.setCell(ex1, ey);

    if (ex1 !== ex2) {
      p = ONE_PIXEL * (fy2 - y1 + delta);
      const lift = Math.trunc(p / dx);
      let rem = p % dx;
      let l = lift;
      if (rem < 0) { l--; rem += dx; }
      mod -= dx;
      while (ex1 !== ex2) {
        delta = l;
        mod += rem;
        if (mod >= 0) { mod -= dx; delta++; }
        this.add(delta, ONE_PIXEL * delta);
        y1 += delta;
        ex1 += incr;
        this.setCell(ex1, ey);
      }
    }
    delta = fy2 - y1;
    this.add(delta, (fx2 + ONE_PIXEL - first) * delta);
  }
  lineTo(to_x, to_y) {
    if (this.lineMode === 'prod') return this.prodLineTo(to_x, to_y);
    return this.oldLineTo(to_x, to_y);
  }
  // gray_render_line, FT_INT64 prod walker (2.13) — verbatim from ftclone
  prodLineTo(to_x, to_y) {
    let ey1 = TRUNC(this.y), ey2 = TRUNC(to_y);
    if ((ey1 >= this.H && ey2 >= this.H) || (ey1 < 0 && ey2 < 0)) { this.x = to_x; this.y = to_y; return; }
    let ex1 = TRUNC(this.x), ex2 = TRUNC(to_x);
    let fx1 = this.x & 255, fy1 = this.y & 255;
    let fx2, fy2;
    const dx = to_x - this.x, dy = to_y - this.y;

    if (ex1 === ex2 && ey1 === ey2) { /* inside one cell */ }
    else if (dy === 0) { this.setCell(ex2, ey2); this.x = to_x; this.y = to_y; return; }
    else if (dx === 0) {
      if (dy > 0) do {
        fy2 = ONE_PIXEL;
        this.add(fy2 - fy1, (fy2 - fy1) * fx1 * 2);
        fy1 = 0; ey1++;
        this.setCell(ex1, ey1);
      } while (ey1 !== ey2);
      else do {
        fy2 = 0;
        this.add(fy2 - fy1, (fy2 - fy1) * fx1 * 2);
        fy1 = ONE_PIXEL; ey1--;
        this.setCell(ex1, ey1);
      } while (ey1 !== ey2);
    } else {
      let prod = dx * fy1 - dy * fx1;
      const exactDiv = this.div === 'exact';
      const dxr = !exactDiv && ex1 !== ex2 ? Math.trunc(0xFFFFFFFF / dx) : 0;
      const dyr = !exactDiv && ey1 !== ey2 ? Math.trunc(0xFFFFFFFF / dy) : 0;
      const udiv = (a, br) => Math.floor((a * br) / 4294967296);
      do {
        if (prod - dx * ONE_PIXEL > 0 && prod <= 0) {
          fx2 = 0;
          fy2 = exactDiv ? Math.floor(-prod / -dx) : udiv(-prod, -dxr);
          prod -= dy * ONE_PIXEL;
          this.add(fy2 - fy1, (fy2 - fy1) * (fx1 + fx2));
          fx1 = ONE_PIXEL; fy1 = fy2; ex1--;
        } else if (prod - dx * ONE_PIXEL + dy * ONE_PIXEL > 0 &&
                   prod - dx * ONE_PIXEL <= 0) {
          prod -= dx * ONE_PIXEL;
          fx2 = exactDiv ? Math.floor(-prod / dy) : udiv(-prod, dyr);
          fy2 = ONE_PIXEL;
          this.add(fy2 - fy1, (fy2 - fy1) * (fx1 + fx2));
          fx1 = fx2; fy1 = 0; ey1++;
        } else if (prod + dy * ONE_PIXEL >= 0 &&
                   prod - dx * ONE_PIXEL + dy * ONE_PIXEL <= 0) {
          prod += dy * ONE_PIXEL;
          fx2 = ONE_PIXEL;
          fy2 = exactDiv ? Math.floor(prod / dx) : udiv(prod, dxr);
          this.add(fy2 - fy1, (fy2 - fy1) * (fx1 + fx2));
          fx1 = 0; fy1 = fy2; ex1++;
        } else {
          fx2 = exactDiv ? Math.floor(prod / -dy) : udiv(prod, -dyr);
          fy2 = 0;
          prod += dx * ONE_PIXEL;
          this.add(fy2 - fy1, (fy2 - fy1) * (fx1 + fx2));
          fx1 = fx2; fy1 = ONE_PIXEL; ey1--;
        }
        this.setCell(ex1, ey1);
      } while (ex1 !== ex2 || ey1 !== ey2);
    }
    fx2 = to_x & 255; fy2 = to_y & 255;
    this.add(fy2 - fy1, (fy2 - fy1) * (fx1 + fx2));
    this.x = to_x; this.y = to_y;
  }
  // gray_render_line (2.4.12)
  oldLineTo(to_x, to_y) {
    let ey1 = TRUNC(this.y), ey2 = TRUNC(to_y);
    const fy1 = this.y - SUBPIX(ey1), fy2 = to_y - SUBPIX(ey2);
    let dx = to_x - this.x, dy = to_y - this.y;

    const min = Math.min(ey1, ey2), max = Math.max(ey1, ey2);
    if (min >= this.H || max < 0) { this.x = to_x; this.y = to_y; return; }

    if (ey1 === ey2) {
      this.scanline(ey1, this.x, fy1, to_x, fy2);
      this.x = to_x; this.y = to_y; return;
    }

    let incr = 1;
    if (dx === 0) {
      const ex = TRUNC(this.x);
      const two_fx = (this.x - SUBPIX(ex)) << 1;
      let first = ONE_PIXEL;
      if (dy < 0) { first = 0; incr = -1; }
      let delta = first - fy1;
      this.add(delta, two_fx * delta);
      ey1 += incr;
      this.setCell(ex, ey1);
      delta = first + first - ONE_PIXEL;
      const area = two_fx * delta;
      while (ey1 !== ey2) {
        this.add(delta, area);
        ey1 += incr;
        this.setCell(ex, ey1);
      }
      delta = fy2 - ONE_PIXEL + first;
      this.add(delta, two_fx * delta);
      this.x = to_x; this.y = to_y; return;
    }

    let p = (ONE_PIXEL - fy1) * dx;
    let first = ONE_PIXEL;
    if (dy < 0) {
      p = fy1 * dx;
      first = 0;
      incr = -1;
      dy = -dy;
    }
    let delta = Math.trunc(p / dy);
    let mod = p % dy;
    if (mod < 0) { delta--; mod += dy; }

    let x = this.x + delta;
    this.scanline(ey1, this.x, fy1, x, first);

    ey1 += incr;
    this.setCell(TRUNC(x), ey1);

    if (ey1 !== ey2) {
      p = ONE_PIXEL * dx;
      const lift0 = Math.trunc(p / dy);
      let rem = p % dy;
      let lift = lift0;
      if (rem < 0) { lift--; rem += dy; }
      mod -= dy;
      while (ey1 !== ey2) {
        delta = lift;
        mod += rem;
        if (mod >= 0) { mod -= dy; delta++; }
        const x2 = x + delta;
        this.scanline(ey1, x, ONE_PIXEL - first, x2, first);
        x = x2;
        ey1 += incr;
        this.setCell(TRUNC(x), ey1);
      }
    }
    this.scanline(ey1, x, ONE_PIXEL - first, to_x, fy2);
    this.x = to_x; this.y = to_y;
  }
  conicTo(cx6, cy6, tx6, ty6) {
    if (this.conicMode === 'dda') return this.ddaConicTo(cx6, cy6, tx6, ty6);
    return this.bisectConicTo(cx6, cy6, tx6, ty6);
  }
  // gray_render_conic, DDA (2.13 FT_INT64) — verbatim from ftclone
  ddaConicTo(cx6, cy6, tx6, ty6) {
    const U = this.raw268 ? (x => x) : UPSCALE;
    const p0x = this.x, p0y = this.y;
    const p1x = U(cx6), p1y = U(cy6);
    const p2x = U(tx6), p2y = U(ty6);
    if ((TRUNC(p0y) >= this.H && TRUNC(p1y) >= this.H && TRUNC(p2y) >= this.H) ||
        (TRUNC(p0y) < 0 && TRUNC(p1y) < 0 && TRUNC(p2y) < 0)) {
      this.x = p2x; this.y = p2y; return;
    }
    const bx = p1x - p0x, by = p1y - p0y;
    const ax = p2x - p1x - bx, ay = p2y - p1y - by;
    let dx = Math.abs(ax), dyv = Math.abs(ay);
    if (dx < dyv) dx = dyv;
    if (dx <= this.ctol) { this.lineTo(p2x, p2y); return; }
    let shift = 16;
    do { dx >>= 2; shift--; } while (dx > this.ctol);
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
  // gray_render_conic (2.4.12): level-stack midpoint bisection. 26.6 inputs.
  bisectConicTo(cx6, cy6, tx6, ty6) {
    const U = this.raw268 ? (x => x) : UPSCALE;
    const arc = [];                    // stack of arcs, each [p2, c, p0]
    const a0 = { x: U(tx6), y: U(ty6) };
    const a1 = { x: U(cx6), y: U(cy6) };
    const a2 = { x: this.x, y: this.y };
    let dx = Math.abs(a2.x + a0.x - 2 * a1.x);
    const dyv = Math.abs(a2.y + a0.y - 2 * a1.y);
    if (dx < dyv) dx = dyv;

    if (dx < this.ctol) { this.lineTo(a0.x, a0.y); return; }

    // band short-cut: if wholly outside vertically, draw as one line
    let mn = a0.y, mx = a0.y;
    for (const p of [a1, a2]) { if (p.y < mn) mn = p.y; if (p.y > mx) mx = p.y; }
    if (TRUNC(mn) >= this.H || TRUNC(mx) < 0) { this.lineTo(a0.x, a0.y); return; }

    let level = 0;
    do { dx >>= 2; level++; } while (dx > this.ctol);

    const half = (a, b) => Math.trunc((a + b) / 2);
    const stack = [[a0, a1, a2]];
    const levels = [level];
    while (stack.length) {
      const lv = levels[levels.length - 1];
      const top = stack[stack.length - 1];
      if (lv > 0) {
        // gray_split_conic on [to, ctl, from]
        const [p0, p1, p2] = top;      // p0=to, p1=ctl, p2=from(current)
        const q2 = { x: p2.x, y: p2.y };
        const m12 = { x: half(p1.x, p2.x), y: half(p1.y, p2.y) };
        const m01 = { x: half(p0.x, p1.x), y: half(p0.y, p1.y) };
        const mid = { x: half(m01.x, m12.x), y: half(m01.y, m12.y) };
        // near half: from -> m12 -> mid ; far half: mid -> m01 -> to
        stack.pop(); levels.pop();
        stack.push([p0, m01, mid]); levels.push(lv - 1);
        stack.push([mid, m12, q2]); levels.push(lv - 1);
        continue;
      }
      this.lineTo(top[0].x, top[0].y);
      stack.pop(); levels.pop();
    }
  }
  // gray_sweep + gray_hline (2.4.12): nonzero rule, NEGATE (not ~) on sign
  sweep(out) {
    for (let y = 0; y < this.H; y++) {
      const cells = [...this.rows[y].values()].sort((a, b) => a.x - b.x);
      if (!cells.length) continue;
      let x = 0, cover = 0, coverage;
      const fillRule = this.sign === 'not'
        ? area => {                    // 2.13: ~ on sign
          let c = area >> 9;
          if (c < 0) c = ~c;
          if (c > 255) c = 255;
          return c;
        }
        : area => {                    // 2.4.12: negate
          let c = area >> 9;
          if (c < 0) c = -c;
          if (c >= 256) c = 255;
          return c;
        };
      for (const cell of cells) {
        if (cover !== 0 && cell.x > x) {
          coverage = fillRule(cover * (ONE_PIXEL * 2));
          for (let i = x; i < cell.x; i++) out[y * this.W + i] = coverage;
        }
        cover += cell.cover;
        const area = cover * (ONE_PIXEL * 2) - cell.area;
        if (area !== 0 && cell.x >= 0) {
          coverage = fillRule(area);
          out[y * this.W + cell.x] = coverage;
        }
        x = cell.x + 1;
      }
      if (cover !== 0) {
        coverage = fillRule(cover * (ONE_PIXEL * 2));
        for (let i = x; i < this.W; i++) out[y * this.W + i] = coverage;
      }
    }
  }
}

// FTClone equivalent on the old raster (TTF only), mupdf blend + scale model
export class FTCloneOld {
  constructor(fontPath, W = 40, H = 40, opts = {}) {
    this.W = W; this.H = H;
    this.opts = opts;
    this.ttf = loadFont(fontPath);
    this.cache = new Map();
  }
  coverage(cp, em64x, em64y, px64, py64) {
    const key = `${cp}|${em64x}|${em64y}|${px64}|${py64}`;
    let cov = this.cache.get(key);
    if (cov) return cov;
    const R = new OldRaster(this.W, this.H, this.opts);
    const o = this.ttf.rawOutline(cp);
    if (!o) return null;
    const half = (a, b) => Math.trunc((a + b) / 2);
    // prec '268': scale funits straight to 26.8 (no 26.6 truncation stop)
    const p268 = this.opts.prec === '268';
    const mulfix = MROUND[this.opts.mround ?? 'ft'];
    const U = p268 ? (x => x) : UPSCALE;
    const sx = p268 ? Math.round(em64x * 128) : Math.round(em64x * 32);
    const sy = p268 ? Math.round(em64y * 128) : Math.round(em64y * 32);
    const pox = p268 ? px64 * 4 : px64, poy = p268 ? py64 * 4 : py64;
    for (const raw of o.contours) {
      if (raw.length < 2) continue;
      const pts = raw.map(p => ({
        x: mulfix(p.x, sx) + pox,
        y: mulfix(p.y, -sy) + poy,
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
      R.moveTo(U(vStart.x), U(vStart.y));
      let closedByConic = false;
      while (i < limit) {
        i++;
        if (pts[i].on) { R.lineTo(U(pts[i].x), U(pts[i].y)); continue; }
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
        if (!done) { R.conicTo(vControl.x, vControl.y, vStart.x, vStart.y); closedByConic = true; break; }
      }
      if (!closedByConic) R.lineTo(U(vStart.x), U(vStart.y));
    }
    cov = new Uint8Array(this.W * this.H);
    R.sweep(cov);
    this.cache.set(key, cov);
    return cov;
  }
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

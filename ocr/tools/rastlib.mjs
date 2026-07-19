// rastlib.mjs — shared outline→pixels core: flatten (quad/cubic), embolden,
// exact-area analytic coverage rasterizer (nonzero winding), PGM writer.
// Coordinates: outlines are y-UP around a baseline origin; rasterize() flips
// to raster rows via pen (penX right, penY = baseline row).

export function flatten(contours, tol = 1 / 128) {
  const polys = [];
  for (const { start, segs } of contours) {
    const pts = [start.slice()];
    let cur = start;
    const quad = (p0, pc, p1) => {
      const mx = (p0[0] + 2 * pc[0] + p1[0]) / 4, my = (p0[1] + 2 * pc[1] + p1[1]) / 4;
      const lx = (p0[0] + p1[0]) / 2, ly = (p0[1] + p1[1]) / 2;
      if (Math.abs(mx - lx) + Math.abs(my - ly) <= tol) { pts.push(p1.slice()); return; }
      const pa = [(p0[0] + pc[0]) / 2, (p0[1] + pc[1]) / 2], pb = [(pc[0] + p1[0]) / 2, (pc[1] + p1[1]) / 2];
      const pm = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      quad(p0, pa, pm); quad(pm, pb, p1);
    };
    const cubic = (p0, c1, c2, p1, d) => {
      if (d > 16) { pts.push(p1.slice()); return; }
      const l = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const m = [(p0[0] + 3 * c1[0] + 3 * c2[0] + p1[0]) / 8, (p0[1] + 3 * c1[1] + 3 * c2[1] + p1[1]) / 8];
      if (Math.abs(m[0] - l[0]) + Math.abs(m[1] - l[1]) <= tol) { pts.push(p1.slice()); return; }
      const ab = [(p0[0] + c1[0]) / 2, (p0[1] + c1[1]) / 2], bc = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
      const cd = [(c2[0] + p1[0]) / 2, (c2[1] + p1[1]) / 2];
      const abc = [(ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2], bcd = [(bc[0] + cd[0]) / 2, (bc[1] + cd[1]) / 2];
      const mm = [(abc[0] + bcd[0]) / 2, (abc[1] + bcd[1]) / 2];
      cubic(p0, ab, abc, mm, d + 1); cubic(mm, bcd, cd, p1, d + 1);
    };
    for (const s of segs) {
      if (s.c1) cubic(cur, s.c1, s.c2, s.to, 0);
      else if (s.ctrl) quad(cur, s.ctrl, s.to);
      else pts.push(s.to.slice());
      cur = s.to;
    }
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) pts.push(a.slice());
      polys.push(pts);
    }
  }
  return polys;
}

// TT convention (y-up): ink lies RIGHT of edge direction; outward normal of
// edge e is its LEFT normal (-ey, ex). Moves each vertex along the corner
// bisector; ex/ey are per-side strengths in px.
export function embolden(polys, ex, ey) {
  if (!ex && !ey) return polys;
  return polys.map(pts => {
    const n = pts.length - 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      const e0 = [p[0] - a[0], p[1] - a[1]], e1 = [b[0] - p[0], b[1] - p[1]];
      const nrm = v => { const l = Math.hypot(v[0], v[1]) || 1; return [-v[1] / l, v[0] / l]; };
      const n0 = nrm(e0), n1 = nrm(e1);
      let bx = n0[0] + n1[0], by = n0[1] + n1[1];
      const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
      const scale = Math.min(2, 1 / Math.max(0.5, (1 + (n0[0] * n1[0] + n0[1] * n1[1])) / 2) ** 0.5);
      out.push([p[0] + bx * ex * scale, p[1] + by * ey * scale]);
    }
    out.push(out[0].slice());
    return out;
  });
}

export function rasterize(polys, W, H, penX, penY) {
  const area = new Float64Array(W * H), cover = new Float64Array(W * H);
  const addEdge = (x0, y0, x1, y1) => {
    if (y0 === y1) return;
    const dy = y1 - y0, dx = x1 - x0;
    const ts = [0, 1];
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    for (let r = Math.floor(lo) + 1; r <= Math.ceil(hi) - 1; r++) ts.push((r - y0) / dy);
    const xlo = Math.min(x0, x1), xhi = Math.max(x0, x1);
    if (dx !== 0) for (let c = Math.floor(xlo) + 1; c <= Math.ceil(xhi) - 1; c++) ts.push((c - x0) / dx);
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i++) {
      const ta = ts[i], tb = ts[i + 1];
      if (tb <= ta) continue;
      const xa = x0 + ta * dx, ya = y0 + ta * dy;
      const xb = x0 + tb * dx, yb = y0 + tb * dy;
      const tm = (ta + tb) / 2;
      const r = Math.floor(y0 + tm * dy), c = Math.floor(x0 + tm * dx);
      if (r < 0 || r >= H) continue;
      const dyp = yb - ya;
      if (c >= W) continue;
      if (c < 0) { cover[r * W] += dyp; area[r * W] += dyp; continue; }
      area[r * W + c] += dyp * ((c + 1) - (xa + xb) / 2);
      cover[r * W + c] += dyp;
    }
  };
  for (const pts of polys) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const x0 = penX + pts[i][0], y0 = penY - pts[i][1];
      const x1 = penX + pts[i + 1][0], y1 = penY - pts[i + 1][1];
      addEdge(x0, y0, x1, y1);
    }
  }
  const cov = new Float64Array(W * H);
  for (let r = 0; r < H; r++) {
    let acc = 0;
    for (let c = 0; c < W; c++) {
      cov[r * W + c] = Math.min(1, Math.abs(acc + area[r * W + c]));
      acc += cover[r * W + c];
    }
  }
  return cov;
}

export function covToPgm(cov, W, H, { gamma = 1, q65 = false } = {}) {
  const gray = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) {
    let c = cov[i];
    if (q65) c = Math.round(c * 64) / 64;
    const a = gamma === 1 ? c : Math.pow(c, gamma);
    gray[i] = Math.max(0, Math.min(255, Math.round(255 * (1 - a))));
  }
  return Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), gray]);
}

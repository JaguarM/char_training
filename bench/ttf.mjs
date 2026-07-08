// Minimal TrueType parser: cmap(4) lookup, glyf outlines (simple + xy-offset
// composites), hmtx advances, kern(0) pairs. Enough to rebuild glyph paths.
export function parseTTF(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    tables[tag] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
  }
  const head = tables.head.offset;
  const unitsPerEm = dv.getUint16(head + 18);
  const indexToLocFormat = dv.getInt16(head + 50);
  const numGlyphs = dv.getUint16(tables.maxp.offset + 4);

  // cmap: prefer (3,1) format 4
  const cmapOff = tables.cmap.offset;
  const nSub = dv.getUint16(cmapOff + 2);
  let sub = -1;
  for (let i = 0; i < nSub; i++) {
    const p = dv.getUint16(cmapOff + 4 + i * 8), e = dv.getUint16(cmapOff + 6 + i * 8);
    const so = dv.getUint32(cmapOff + 8 + i * 8);
    if ((p === 3 && (e === 1 || e === 10)) || (p === 0)) { sub = cmapOff + so; if (p === 3 && e === 1) break; }
  }
  if (sub < 0 || dv.getUint16(sub) !== 4) throw new Error('no cmap format 4');
  const segCount = dv.getUint16(sub + 6) / 2;
  const endO = sub + 14, startO = endO + segCount * 2 + 2, deltaO = startO + segCount * 2, rangeO = deltaO + segCount * 2;
  function glyphId(code) {
    for (let s = 0; s < segCount; s++) {
      const end = dv.getUint16(endO + s * 2);
      if (code > end) continue;
      const start = dv.getUint16(startO + s * 2);
      if (code < start) return 0;
      const delta = dv.getInt16(deltaO + s * 2);
      const ro = dv.getUint16(rangeO + s * 2);
      if (ro === 0) return (code + delta) & 0xffff;
      const gi = dv.getUint16(rangeO + s * 2 + ro + (code - start) * 2);
      return gi === 0 ? 0 : (gi + delta) & 0xffff;
    }
    return 0;
  }

  // loca
  const loca = tables.loca.offset;
  const glyfOff = gid => indexToLocFormat
    ? dv.getUint32(loca + gid * 4)
    : dv.getUint16(loca + gid * 2) * 2;
  const glyfEnd = gid => indexToLocFormat
    ? dv.getUint32(loca + (gid + 1) * 4)
    : dv.getUint16(loca + (gid + 1) * 2) * 2;

  // hmtx
  const numHMetrics = dv.getUint16(tables.hhea.offset + 34);
  function advance(gid) {
    const h = tables.hmtx.offset;
    return gid < numHMetrics ? dv.getUint16(h + gid * 4) : dv.getUint16(h + (numHMetrics - 1) * 4);
  }

  // glyf → contours of {x,y,onCurve} (font units), composites resolved (xy offsets)
  function contours(gid, depth = 0) {
    if (depth > 5) throw new Error('composite depth');
    const start = tables.glyf.offset + glyfOff(gid);
    if (glyfOff(gid) === glyfEnd(gid)) return []; // empty glyph (space)
    const nc = dv.getInt16(start);
    if (nc >= 0) {
      const ends = [];
      let p = start + 10;
      for (let i = 0; i < nc; i++) { ends.push(dv.getUint16(p)); p += 2; }
      const nPts = ends[nc - 1] + 1;
      const insLen = dv.getUint16(p); p += 2 + insLen;
      const flags = new Uint8Array(nPts);
      for (let i = 0; i < nPts;) {
        const f = buf[p++]; flags[i++] = f;
        if (f & 8) { let r = buf[p++]; while (r--) flags[i++] = f; }
      }
      const xs = new Int16Array(nPts), ys = new Int16Array(nPts);
      let x = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 2) { const d = buf[p++]; x += (f & 16) ? d : -d; }
        else if (!(f & 16)) { x += dv.getInt16(p); p += 2; }
        xs[i] = x;
      }
      let y = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 4) { const d = buf[p++]; y += (f & 32) ? d : -d; }
        else if (!(f & 32)) { y += dv.getInt16(p); p += 2; }
        ys[i] = y;
      }
      const out = [];
      let s0 = 0;
      for (let c = 0; c < nc; c++) {
        const e = ends[c], pts = [];
        for (let i = s0; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        out.push(pts);
        s0 = e + 1;
      }
      return out;
    }
    // composite
    const out = [];
    let p = start + 10;
    for (;;) {
      const flags = dv.getUint16(p), cgid = dv.getUint16(p + 2); p += 4;
      let dx, dy;
      if (flags & 1) { dx = dv.getInt16(p); dy = dv.getInt16(p + 2); p += 4; }
      else { dx = new Int8Array([buf[p]])[0]; dy = new Int8Array([buf[p + 1]])[0]; p += 2; }
      let a = 1, b = 0, c2 = 0, d = 1;
      if (flags & 8) { a = d = dv.getInt16(p) / 16384; p += 2; }
      else if (flags & 0x40) { a = dv.getInt16(p) / 16384; d = dv.getInt16(p + 2) / 16384; p += 4; }
      else if (flags & 0x80) { a = dv.getInt16(p)/16384; b = dv.getInt16(p+2)/16384; c2 = dv.getInt16(p+4)/16384; d = dv.getInt16(p+6)/16384; p += 8; }
      if (!(flags & 2)) throw new Error('composite point-matching not supported');
      for (const cont of contours(cgid, depth + 1)) {
        out.push(cont.map(pt => ({ x: a * pt.x + c2 * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      }
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  // kern table (format 0) pair values in font units
  const kernMap = new Map();
  if (tables.kern) {
    const k = tables.kern.offset;
    const nT = dv.getUint16(k + 2);
    let p = k + 4;
    for (let t = 0; t < nT; t++) {
      const len = dv.getUint16(p + 2), cov = dv.getUint16(p + 4);
      if ((cov & 0xff00) === 0 && (cov & 1)) { // horizontal, format 0
        const nPairs = dv.getUint16(p + 6);
        let q = p + 14;
        for (let i = 0; i < nPairs; i++, q += 6) {
          kernMap.set((dv.getUint16(q) << 16) | dv.getUint16(q + 2), dv.getInt16(q + 4));
        }
      }
      p += len;
    }
  }
  const kern = (g1, g2) => kernMap.get((g1 << 16) | g2) ?? 0;

  // contours → canvas path commands at fontSize px, baseline origin, y-down.
  // Classic TrueType walk: pending off-curve control, implied on-curve midpoints
  // between consecutive off-curve points.
  function pathCommands(ch, fontSize) {
    const gid = glyphId(ch.codePointAt(0));
    const scale = fontSize / unitsPerEm;
    const cmds = [];
    const S = v => v * scale;
    for (const pts of contours(gid)) {
      const n = pts.length;
      if (!n) continue;
      const P = i => pts[((i % n) + n) % n];
      let s = pts.findIndex(p => p.on);
      let ax, ay; // contour start anchor
      if (s < 0) { ax = (P(-1).x + P(0).x) / 2; ay = (P(-1).y + P(0).y) / 2; s = 0; }
      else { ax = P(s).x; ay = P(s).y; s = s + 1; }
      cmds.push(['M', S(ax), -S(ay)]);
      let pending = null;
      const steps = pts.findIndex(p => p.on) < 0 ? n : n - 1;
      for (let k = 0; k < steps; k++) {
        const p = P(s + k);
        if (p.on) {
          if (pending) { cmds.push(['Q', S(pending.x), -S(pending.y), S(p.x), -S(p.y)]); pending = null; }
          else cmds.push(['L', S(p.x), -S(p.y)]);
        } else {
          if (pending) cmds.push(['Q', S(pending.x), -S(pending.y), S((pending.x + p.x) / 2), -S((pending.y + p.y) / 2)]);
          pending = p;
        }
      }
      if (pending) cmds.push(['Q', S(pending.x), -S(pending.y), S(ax), -S(ay)]);
      cmds.push(['Z']);
    }
    return cmds;
  }

  return { unitsPerEm, numGlyphs, glyphId, advance, kern, contours, pathCommands };
}

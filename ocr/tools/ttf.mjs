// ttf.mjs — minimal TrueType parser: cmap(4) lookup + glyf outlines
// (simple & composite) in FONT UNITS, y-up. Enough for the target charset.
import { readFileSync } from 'node:fs';

export function loadFont(path) {
  const b = readFileSync(path);
  const numTables = b.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    tables[b.toString('latin1', o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) };
  }
  const head = tables.head.off;
  const unitsPerEm = b.readUInt16BE(head + 18);
  const locFormat = b.readInt16BE(head + 50);
  const numGlyphs = b.readUInt16BE(tables.maxp.off + 4);
  const numHM = b.readUInt16BE(tables.hhea.off + 34);

  // cmap: prefer 3/1 format 4
  const cm = tables.cmap.off;
  const nSub = b.readUInt16BE(cm + 2);
  let sub = null;
  for (let i = 0; i < nSub; i++) {
    const o = cm + 4 + 8 * i;
    const pid = b.readUInt16BE(o), eid = b.readUInt16BE(o + 2), soff = b.readUInt32BE(o + 4);
    if ((pid === 3 && (eid === 1 || eid === 10)) || (pid === 0)) { sub = cm + soff; if (pid === 3 && eid === 1) break; }
  }
  if (sub == null) throw new Error('no usable cmap subtable');
  if (b.readUInt16BE(sub) !== 4) throw new Error(`cmap format ${b.readUInt16BE(sub)} unsupported`);
  const segX2 = b.readUInt16BE(sub + 6);
  const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
  function gidFor(cp) {
    for (let s = 0; s < segX2; s += 2) {
      if (cp <= b.readUInt16BE(endO + s)) {
        const start = b.readUInt16BE(startO + s);
        if (cp < start) return 0;
        const ro = b.readUInt16BE(rangeO + s);
        if (ro === 0) return (cp + b.readInt16BE(deltaO + s)) & 0xFFFF;
        const gi = b.readUInt16BE(rangeO + s + ro + (cp - start) * 2);
        return gi === 0 ? 0 : (gi + b.readInt16BE(deltaO + s)) & 0xFFFF;
      }
    }
    return 0;
  }

  function locaOff(gid) {
    const lo = tables.loca.off;
    return locFormat ? [b.readUInt32BE(lo + 4 * gid), b.readUInt32BE(lo + 4 * gid + 4)]
                     : [2 * b.readUInt16BE(lo + 2 * gid), 2 * b.readUInt16BE(lo + 2 * gid + 2)];
  }

  function metrics(gid) {
    const hm = tables.hmtx.off;
    const i = Math.min(gid, numHM - 1);
    return { adv: b.readUInt16BE(hm + 4 * i), lsb: gid < numHM ? b.readInt16BE(hm + 4 * gid + 2) : b.readInt16BE(hm + 4 * numHM + 2 * (gid - numHM)) };
  }

  // returns array of contours, each = array of {x,y,on} in font units
  function glyphPoints(gid, depth = 0) {
    if (depth > 5) return [];
    const [o0, o1] = locaOff(gid);
    if (o1 <= o0) return [];
    const g = tables.glyf.off + o0;
    const nc = b.readInt16BE(g);
    if (nc >= 0) {
      const endPts = [];
      for (let i = 0; i < nc; i++) endPts.push(b.readUInt16BE(g + 10 + 2 * i));
      const nPts = endPts[nc - 1] + 1;
      let o = g + 10 + 2 * nc;
      o += 2 + b.readUInt16BE(o);               // instructions
      const flags = [];
      while (flags.length < nPts) {
        const f = b[o++]; flags.push(f);
        if (f & 8) { let r = b[o++]; while (r--) flags.push(f); }
      }
      const xs = [], ys = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) { const d = b[o++]; v += (f & 16) ? d : -d; }
        else if (!(f & 16)) { v += b.readInt16BE(o); o += 2; }
        xs.push(v);
      }
      v = 0;
      for (const f of flags) {
        if (f & 4) { const d = b[o++]; v += (f & 32) ? d : -d; }
        else if (!(f & 32)) { v += b.readInt16BE(o); o += 2; }
        ys.push(v);
      }
      const contours = [];
      let s = 0;
      for (const e of endPts) {
        const pts = [];
        for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        contours.push(pts);
        s = e + 1;
      }
      return contours;
    }
    // composite
    const out = [];
    let o = g + 10;
    while (true) {
      const flags = b.readUInt16BE(o), gi = b.readUInt16BE(o + 2);
      o += 4;
      let a1, a2;
      if (flags & 1) { a1 = b.readInt16BE(o); a2 = b.readInt16BE(o + 2); o += 4; }
      else { a1 = b.readInt8(o); a2 = b.readInt8(o + 1); o += 2; }
      let m = [1, 0, 0, 1];
      if (flags & 8) { const s2 = b.readInt16BE(o) / 16384; m = [s2, 0, 0, s2]; o += 2; }
      else if (flags & 0x40) { m = [b.readInt16BE(o) / 16384, 0, 0, b.readInt16BE(o + 2) / 16384]; o += 4; }
      else if (flags & 0x80) { m = [b.readInt16BE(o) / 16384, b.readInt16BE(o + 2) / 16384, b.readInt16BE(o + 4) / 16384, b.readInt16BE(o + 6) / 16384]; o += 8; }
      const dx = (flags & 2) ? a1 : 0, dy = (flags & 2) ? a2 : 0;   // ARGS_ARE_XY_VALUES
      for (const c of glyphPoints(gi, depth + 1))
        out.push(c.map(p => ({ x: m[0] * p.x + m[2] * p.y + dx, y: m[1] * p.x + m[3] * p.y + dy, on: p.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  // contours (TT points) -> {start, segs[{ctrl?,to}]} list
  function toSegContours(ptContours) {
    const res = [];
    for (const pts of ptContours) {
      const n = pts.length;
      if (n < 2) continue;
      let s = pts.findIndex(p => p.on);
      let start, ordered;
      if (s === -1) {
        start = [(pts[0].x + pts[n - 1].x) / 2, (pts[0].y + pts[n - 1].y) / 2];
        ordered = [...pts];
      } else {
        start = [pts[s].x, pts[s].y];
        ordered = [];
        for (let i = 1; i <= n; i++) ordered.push(pts[(s + i) % n]);
      }
      const segs = [];
      let pend = null;
      for (const p of ordered) {
        if (p.on) {
          segs.push(pend ? { ctrl: [pend.x, pend.y], to: [p.x, p.y] } : { to: [p.x, p.y] });
          pend = null;
        } else {
          if (pend) segs.push({ ctrl: [pend.x, pend.y], to: [(pend.x + p.x) / 2, (pend.y + p.y) / 2] });
          pend = p;
        }
      }
      if (pend) segs.push({ ctrl: [pend.x, pend.y], to: start.slice() });
      else {
        const last = segs.length ? segs[segs.length - 1].to : start;
        if (last[0] !== start[0] || last[1] !== start[1]) segs.push({ to: start.slice() });
      }
      res.push({ start, segs });
    }
    return res;
  }

  return {
    unitsPerEm,
    outline(cp) {
      const gid = gidFor(cp);
      if (!gid) return null;
      return { contours: toSegContours(glyphPoints(gid)), ...metrics(gid), gid };
    },
    // raw TT points ({x,y,on} per contour) — for FT-exact decomposition where
    // implicit midpoints must be computed AFTER scaling, in 26.6 integers
    rawOutline(cp) {
      const gid = gidFor(cp);
      if (!gid) return null;
      return { contours: glyphPoints(gid), ...metrics(gid), gid };
    },
  };
}

// cff.mjs — minimal CFF/Type2 outline extractor for the bundled URW fonts.
// Parses header/INDEXes/TopDICT/Private/Subrs, interprets Type2 charstrings
// (hints skipped, masks consumed) into contours of lines + CUBIC beziers in
// charstring units (FontMatrix assumed 0.001 -> upm 1000, verified).
// gid comes from the caller (mupdf's encodeCharacter on the same bytes).
import { readFileSync } from 'node:fs';

export function loadCff(path) {
  const b = readFileSync(path);
  if (b[0] !== 1) throw new Error('CFF major != 1');
  const hdrSize = b[2];

  function index(off) {
    const count = b.readUInt16BE(off);
    if (count === 0) return { items: [], end: off + 2 };
    const offSize = b[off + 2];
    const offAt = i => {
      let v = 0;
      for (let k = 0; k < offSize; k++) v = v * 256 + b[off + 3 + i * offSize + k];
      return v;
    };
    const dataStart = off + 3 + (count + 1) * offSize - 1;
    const items = [];
    for (let i = 0; i < count; i++) items.push(b.subarray(dataStart + offAt(i), dataStart + offAt(i + 1)));
    return { items, end: dataStart + offAt(count) };
  }

  const nameIdx = index(hdrSize);
  const topIdx = index(nameIdx.end);
  const stringIdx = index(topIdx.end);
  const gsubrIdx = index(stringIdx.end);

  function parseDict(data) {
    const d = {};
    const st = [];
    for (let i = 0; i < data.length;) {
      const b0 = data[i];
      if (b0 <= 21) {
        let op = b0;
        i++;
        if (b0 === 12) { op = 1200 + data[i]; i++; }
        d[op] = st.slice();
        st.length = 0;
      } else if (b0 === 28) { st.push(data.readInt16BE(i + 1)); i += 3; }
      else if (b0 === 29) { st.push(data.readInt32BE(i + 1)); i += 5; }
      else if (b0 === 30) {           // real
        let s = '';
        i++;
        loop: while (i < data.length) {
          for (const nib of [data[i] >> 4, data[i] & 15]) {
            if (nib <= 9) s += nib;
            else if (nib === 10) s += '.';
            else if (nib === 11) s += 'E';
            else if (nib === 12) s += 'E-';
            else if (nib === 14) s += '-';
            else if (nib === 15) { i++; break loop; }
          }
          i++;
        }
        st.push(parseFloat(s));
      }
      else if (b0 >= 32 && b0 <= 246) { st.push(b0 - 139); i++; }
      else if (b0 >= 247 && b0 <= 250) { st.push((b0 - 247) * 256 + data[i + 1] + 108); i += 2; }
      else if (b0 >= 251 && b0 <= 254) { st.push(-(b0 - 251) * 256 - data[i + 1] - 108); i += 2; }
      else throw new Error('dict op ' + b0);
    }
    return d;
  }

  const top = parseDict(topIdx.items[0]);
  const fontMatrix = top[1207] ?? [0.001, 0, 0, 0.001, 0, 0];
  const charStrings = index(top[17][0]);
  let subrs = { items: [] };
  if (top[18]) {
    const [pSize, pOff] = top[18];
    const priv = parseDict(b.subarray(pOff, pOff + pSize));
    if (priv[19]) subrs = index(pOff + priv[19][0]);
  }
  const bias = n => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);
  const gBias = bias(gsubrIdx.items.length), lBias = bias(subrs.items.length);

  function runCharstring(gid) {
    const cs = charStrings.items[gid];
    if (!cs) return null;
    const st = [];
    let x = 0, y = 0, nStems = 0, width = null;
    const contours = [];
    let cur = null;
    const moveTo = (nx, ny) => { if (cur && cur.segs.length) contours.push(cur); cur = { start: [nx, ny], segs: [] }; };
    const lineTo = (nx, ny) => cur && cur.segs.push({ to: [nx, ny] });
    const curveTo = (c1x, c1y, c2x, c2y, nx, ny) => cur && cur.segs.push({ c1: [c1x, c1y], c2: [c2x, c2y], to: [nx, ny] });
    const stems = () => { nStems += st.length >> 1; st.length = 0; };

    function exec(code, depth) {
      if (depth > 10) throw new Error('subr depth');
      for (let i = 0; i < code.length;) {
        const b0 = code[i];
        if (b0 >= 32 || b0 === 28) {
          if (b0 === 28) { st.push(code.readInt16BE(i + 1)); i += 3; }
          else if (b0 <= 246) { st.push(b0 - 139); i++; }
          else if (b0 <= 250) { st.push((b0 - 247) * 256 + code[i + 1] + 108); i += 2; }
          else if (b0 <= 254) { st.push(-(b0 - 251) * 256 - code[i + 1] - 108); i += 2; }
          else { st.push(code.readInt32BE(i + 1) / 65536); i += 5; }   // 16.16
          continue;
        }
        i++;
        switch (b0) {
          case 1: case 3: case 18: case 23:      // h/vstem(hm)
            if (width === null && st.length % 2 === 1) width = st.shift();
            stems(); break;
          case 19: case 20:                       // hintmask/cntrmask
            if (width === null && st.length % 2 === 1) width = st.shift();
            stems(); i += (nStems + 7) >> 3; break;
          case 21:                                // rmoveto
            if (width === null && st.length > 2) width = st.shift();
            x += st[0]; y += st[1]; moveTo(x, y); st.length = 0; break;
          case 22:                                // hmoveto
            if (width === null && st.length > 1) width = st.shift();
            x += st[0]; moveTo(x, y); st.length = 0; break;
          case 4:                                 // vmoveto
            if (width === null && st.length > 1) width = st.shift();
            y += st[0]; moveTo(x, y); st.length = 0; break;
          case 5:                                 // rlineto
            for (let k = 0; k + 1 < st.length; k += 2) { x += st[k]; y += st[k + 1]; lineTo(x, y); }
            st.length = 0; break;
          case 6: case 7: {                       // hlineto / vlineto (alternating)
            let horiz = b0 === 6;
            for (let k = 0; k < st.length; k++) { if (horiz) x += st[k]; else y += st[k]; lineTo(x, y); horiz = !horiz; }
            st.length = 0; break;
          }
          case 8:                                 // rrcurveto
            for (let k = 0; k + 5 < st.length; k += 6) rr(st, k);
            st.length = 0; break;
          case 24: {                              // rcurveline
            let k = 0;
            for (; k + 5 < st.length - 2; k += 6) rr(st, k);
            x += st[k]; y += st[k + 1]; lineTo(x, y); st.length = 0; break;
          }
          case 25: {                              // rlinecurve
            let k = 0;
            for (; k + 1 < st.length - 6; k += 2) { x += st[k]; y += st[k + 1]; lineTo(x, y); }
            rr(st, k); st.length = 0; break;
          }
          case 26: {                              // vvcurveto
            let k = 0, dx1 = 0;
            if (st.length % 4 === 1) { dx1 = st[0]; k = 1; }
            for (; k + 3 < st.length; k += 4) {
              const c1x = x + dx1, c1y = y + st[k];
              const c2x = c1x + st[k + 1], c2y = c1y + st[k + 2];
              x = c2x; y = c2y + st[k + 3];
              curveTo(c1x, c1y, c2x, c2y, x, y); dx1 = 0;
            }
            st.length = 0; break;
          }
          case 27: {                              // hhcurveto
            let k = 0, dy1 = 0;
            if (st.length % 4 === 1) { dy1 = st[0]; k = 1; }
            for (; k + 3 < st.length; k += 4) {
              const c1x = x + st[k], c1y = y + dy1;
              const c2x = c1x + st[k + 1], c2y = c1y + st[k + 2];
              x = c2x + st[k + 3]; y = c2y;
              curveTo(c1x, c1y, c2x, c2y, x, y); dy1 = 0;
            }
            st.length = 0; break;
          }
          case 30: case 31: {                     // vhcurveto / hvcurveto
            let horiz = b0 === 31;
            let k = 0;
            while (k + 3 < st.length) {
              const last = k + 8 > st.length;     // 5-arg tail?
              const extra = last && k + 5 === st.length ? st[k + 4] : 0;
              let c1x, c1y, c2x, c2y;
              if (horiz) {
                c1x = x + st[k]; c1y = y;
                c2x = c1x + st[k + 1]; c2y = c1y + st[k + 2];
                y = c2y + st[k + 3]; x = c2x + extra;
              } else {
                c1x = x; c1y = y + st[k];
                c2x = c1x + st[k + 1]; c2y = c1y + st[k + 2];
                x = c2x + st[k + 3]; y = c2y + extra;
              }
              curveTo(c1x, c1y, c2x, c2y, x, y);
              horiz = !horiz; k += 4;
            }
            st.length = 0; break;
          }
          case 10: { const idx = st.pop() + lBias; exec(subrs.items[idx], depth + 1); break; }
          case 29: { const idx = st.pop() + gBias; exec(gsubrIdx.items[idx], depth + 1); break; }
          case 11: return;                        // return
          case 14:                                // endchar
            if (width === null && st.length % 2 === 1) width = st.shift();
            if (cur && cur.segs.length) contours.push(cur);
            cur = null; return;
          default: throw new Error('charstring op ' + b0 + ' gid ' + gid);
        }
      }
    }
    function rr(s, k) {
      const c1x = x + s[k], c1y = y + s[k + 1];
      const c2x = c1x + s[k + 2], c2y = c1y + s[k + 3];
      x = c2x + s[k + 4]; y = c2y + s[k + 5];
      curveTo(c1x, c1y, c2x, c2y, x, y);
    }
    exec(cs, 0);
    if (cur && cur.segs.length) contours.push(cur);
    return contours;
  }

  return {
    unitsPerEm: Math.round(1 / fontMatrix[0]),
    fontMatrix,
    numGlyphs: charStrings.items.length,
    outline: runCharstring,
  };
}

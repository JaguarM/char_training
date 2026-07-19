// font-version.mjs — print nameID 5 (version) + 4 (full name) of TTFs
//   node tools/attic/font-version.mjs <path...>
import { readFileSync } from 'node:fs';

function names(p) {
  const b = readFileSync(p);
  const n = b.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16, tag = b.toString('latin1', o, o + 4);
    if (tag !== 'name') continue;
    const off = b.readUInt32BE(o + 8);
    const cnt = b.readUInt16BE(off + 2), str = off + b.readUInt16BE(off + 4);
    for (let j = 0; j < cnt; j++) {
      const r = off + 6 + j * 12;
      const id = b.readUInt16BE(r + 6), plat = b.readUInt16BE(r);
      if ((id === 4 || id === 5) && !(id in out)) {
        const len = b.readUInt16BE(r + 8), so = str + b.readUInt16BE(r + 10);
        const raw = Buffer.from(b.subarray(so, so + len));
        out[id] = plat === 3 ? raw.swap16().toString('utf16le') : raw.toString('latin1');
      }
    }
  }
  return out;
}
for (const p of process.argv.slice(2)) {
  try {
    const o = names(p);
    console.log(`${o[5] ?? '?'}  |  ${o[4] ?? '?'}  |  ${p}`);
  } catch (e) { console.log(`ERR ${e.message.slice(0, 50)}  |  ${p}`); }
}

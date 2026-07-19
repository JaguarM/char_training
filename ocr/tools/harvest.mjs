// harvest.mjs — mine ground-truth glyph rasters from the ingested pages.
//
// The body font is MONOSPACE (Courier New, em 10 px, advance 1229/2048 em =
// 6.0009765625 px), so every text line is a lattice of abutting cells. The
// harvester needs no renderer and no layout constants:
//
//   1. mask frame objects (long vrules / hrules) so they can't join bands;
//   2. split the page into ink bands (lines) on blank rows;
//   3. per band, fit the lattice phase from overlay WORD STARTS (interior
//      overlay advances are Tz-stretched junk — see ingest.mjs). Bands whose
//      word starts don't sit on a 6.001-px lattice (Times headers etc.) are
//      skipped and counted;
//   4. cut one window per cell, trim to its own ink rows +1 white guard row;
//   5. cluster byte-identical windows; PROMOTE a cluster to targets/ only if
//      seen >= --min-obs times, with >= 2 distinct left AND right neighbor
//      labels (word boundary counts as one kind), and a unanimous overlay
//      label. Diverse-neighbor byte-identity is the proof that windows abut
//      and the cut is right — wrong cuts differ per neighbor and die here.
//
//   node tools/harvest.mjs                 # all docs under pages/
//   node tools/harvest.mjs --doc EFTA00751637 --dry
//   knobs: --adv 6.0009765625  --min-obs 3  --max-var 8
//
// Labels come from the producer's own OCR overlay: a systematic confusion
// (O/0, l/I) can survive unanimity — if a renderer later matches target 'O'
// with its '0', believe the pixels and fix the label.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { readPgm } from './view.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? +args[i + 1] : d; };
const ADV = opt('adv', 6.0009765625);
const MIN_OBS = opt('min-obs', 3);
const MAX_VAR = opt('max-var', 8);
const DRY = args.includes('--dry');
const docFilter = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--doc') docFilter.push(args[i + 1]);

const INK = 250;               // < INK = inked pixel
const docs = (docFilter.length ? docFilter : readdirSync(`${root}/pages`))
  .filter(d => existsSync(`${root}/pages/${d}/meta.json`));
if (!docs.length) { console.error('no ingested docs under pages/ — run tools/ingest.mjs first'); process.exit(1); }

// PIXELS ARE THE ONLY TRUTH here: the lattice (advance + phase) is fitted per
// band from ink alone — autocorrelation seed, then a 2-D ink-valley sweep
// (cell boundaries are the ink-minimum columns; a wrong advance drifts off the
// boundaries within half a line and the cost explodes). The overlay contributes
// nothing to geometry; it only attaches label CLAIMS to pixel-defined cells.
const ADV_OVERRIDE = args.includes('--adv') ? ADV : null;

function bandLattice(proj, near, w) {
  let mean = 0, n = 0;
  for (let c = 0; c < w; c++) if (near[c]) { mean += proj[c]; n++; }
  if (n < 30) return null;
  mean /= n;
  const d = new Float64Array(w);
  for (let c = 0; c < w; c++) d[c] = near[c] ? proj[c] - mean : 0;
  let bestLag = 0, bestAC = -Infinity;
  for (let lag = 4; lag <= 14; lag++) {
    let s = 0;
    for (let c = 0; c + lag < w; c++) s += d[c] * d[c + lag];
    if (s > bestAC) { bestAC = s; bestLag = lag; }
  }
  const cost = (adv, phi) => {
    let s = 0, nb = 0;
    for (let x = phi; x < w; x += adv) {
      const c = Math.round(x);
      if (c < w && near[c]) { s += proj[c]; nb++; }
    }
    return nb >= 8 ? { c: s / nb, nb } : null;
  };
  let best = null, costSum = 0, costN = 0;
  const lo = ADV_OVERRIDE ?? bestLag - 0.75, hi = ADV_OVERRIDE ?? bestLag + 0.75;
  for (let adv = lo; adv <= hi; adv += 0.01) {
    for (let phi = 0; phi < adv; phi += 1 / 8) {
      const r = cost(adv, phi);
      if (!r) continue;
      costSum += r.c; costN++;
      if (!best || r.c < best.cost) best = { adv, phi, cost: r.c };
    }
  }
  if (!best || !costN) return null;
  for (let adv = best.adv - 0.02; adv <= best.adv + 0.02; adv += 0.002) {
    for (let phi = best.phi - 0.3; phi <= best.phi + 0.3; phi += 1 / 32) {
      const r = cost(adv, ((phi % adv) + adv) % adv);
      if (r && r.c < best.cost) best = { adv, phi: ((phi % adv) + adv) % adv, cost: r.c };
    }
  }
  best.contrast = best.cost / (costSum / costN);         // sharp valley << 1
  return best;
}
const medianAdv = () => {
  if (!stats.bandAdvs.length) return ADV_OVERRIDE ?? 0;
  const s = [...stats.bandAdvs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// ---------------- collect cells over all pages ----------------
const clusters = new Map();    // key -> {w,h,px,obs,labels:Map,left:Set,right:Set,fracs:[],srcs:[]}
const stats = { pages: 0, bands: 0, bandsNoWords: 0, bandsOffLattice: 0, cells: 0, cellsMasked: 0, cellsBlank: 0, wordsDropped: 0, bandAdvs: [] };

for (const doc of docs) {
  const files = readdirSync(`${root}/pages/${doc}`).filter(f => /^page-\d+\.pgm$/.test(f));
  for (const f of files) {
    const pno = +/(\d+)/.exec(f)[1];
    const { w, h, px } = readPgm(`${root}/pages/${doc}/${f}`);
    const wordsFile = `${root}/pages/${doc}/${f.replace('.pgm', '.words.json')}`;
    if (!existsSync(wordsFile)) continue;
    const words = JSON.parse(readFileSync(wordsFile, 'utf8')).words;
    stats.pages++;

    // ---- mask: vertical runs >= 40 px and horizontal runs >= 300 px ----
    const mask = new Uint8Array(w * h);
    for (let c = 0; c < w; c++) {
      let run = 0;
      for (let r = 0; r <= h; r++) {
        const on = r < h && px[r * w + c] < INK;
        if (on) run++;
        else { if (run >= 40) for (let k = r - run; k < r; k++) mask[k * w + c] = 1; run = 0; }
      }
    }
    for (let r = 0; r < h; r++) {
      let run = 0;
      for (let c = 0; c <= w; c++) {
        const on = c < w && px[r * w + c] < INK;
        if (on) run++;
        else { if (run >= 300) for (let k = c - run; k < c; k++) mask[r * w + k] = 1; run = 0; }
      }
    }
    const ink = (r, c) => px[r * w + c] < INK && !mask[r * w + c];

    // ---- bands ----
    const inkedRow = new Uint8Array(h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (ink(r, c)) { inkedRow[r] = 1; break; }
    const bands = [];
    for (let r = 0; r < h; r++) {
      if (!inkedRow[r]) continue;
      let r1 = r; while (r1 + 1 < h && inkedRow[r1 + 1]) r1++;
      bands.push({ r0: r, r1 }); r = r1;
    }

    for (const band of bands) {
      stats.bands++;
      const bandWords = words.filter(o =>
        o.px.yBase >= band.r0 - 1 && o.px.yBase <= band.r1 + 2 && o.text.trim() && o.chars);
      if (!bandWords.length) { stats.bandsNoWords++; continue; }

      // ---- pixel-only lattice fit (see bandLattice above) ----
      if (band.r1 - band.r0 < 4) { stats.bandsOffLattice++; continue; }   // rules, dust
      const proj = new Float64Array(w);
      for (let c = 0; c < w; c++) {
        let s = 0;
        for (let r = band.r0; r <= band.r1; r++) if (ink(r, c)) s++;
        proj[c] = s;
      }
      const near = new Uint8Array(w);
      for (let c = 0; c < w; c++) if (proj[c]) for (let k = Math.max(0, c - 8); k < Math.min(w, c + 9); k++) near[k] = 1;
      const fit = bandLattice(proj, near, w);
      if (!fit || fit.contrast > 0.82) { stats.bandsOffLattice++; continue; }
      const ADVB = fit.adv, phi = fit.phi;
      stats.bandAdvs.push(ADVB);

      // ---- cut cells word by word (overlay contributes LABEL CLAIMS only;
      // a word whose claimed cells are >30% blank is an overlay artifact and
      // is dropped whole) ----
      for (const o of bandWords) {
        const text = o.text;
        const cuts = [];
        let blanks = 0;
        for (let j = 0; j < text.length; j++) {
          // snap each char independently (long-word overlay drift stays < half a cell)
          const kj = Math.round((o.chars[j] - phi - 1.2) / ADVB);
          const start = phi + kj * ADVB;
          const c0 = Math.round(start), c1 = Math.round(start + ADVB);
          if (c0 < 0 || c1 > w) continue;
          let masked = false, top = -1, bot = -1;
          for (let r = band.r0; r <= band.r1 && !masked; r++)
            for (let c = c0; c < c1; c++) {
              if (mask[r * w + c]) { masked = true; break; }
              if (px[r * w + c] < INK) { if (top < 0) top = r; bot = r; }
            }
          if (top < 0 && !masked) blanks++;
          cuts.push({ j, start, c0, c1, masked, top, bot });
        }
        if (blanks > 0.3 * text.length) { stats.wordsDropped++; continue; }
        for (const cut of cuts) {
          const { j, start, c0, c1, masked, top, bot } = cut;
          stats.cells++;
          if (masked) { stats.cellsMasked++; continue; }  // rule-touching cell
          if (top < 0) { stats.cellsBlank++; continue; }  // blank cell (space/err)
          const g0 = top - 1, g1 = bot + 1;              // 1 white guard row each side
          const cw = c1 - c0, ch = g1 - g0 + 1;
          const bytes = Buffer.alloc(cw * ch);
          for (let r = g0; r <= g1; r++) for (let c = c0; c < c1; c++)
            bytes[(r - g0) * cw + (c - c0)] = (r < 0 || r >= h) ? 255 : px[r * w + c];
          const key = `${cw}x${ch}:${bytes.toString('latin1')}`;
          let cl = clusters.get(key);
          if (!cl) clusters.set(key, cl = { w: cw, h: ch, px: bytes, obs: 0,
            labels: new Map(), left: new Set(), right: new Set(), fracs: [], srcs: [] });
          cl.obs++;
          const ch_ = text[j];
          cl.labels.set(ch_, (cl.labels.get(ch_) ?? 0) + 1);
          cl.left.add(j > 0 ? text[j - 1] : '␣');
          cl.right.add(j < text.length - 1 ? text[j + 1] : '␣');
          cl.fracs.push(((start % 1) + 1) % 1);
          if (cl.srcs.length < 3) cl.srcs.push({ doc, page: pno, x: c0, y: g0 });
        }
      }
    }
  }
}

// ---------------- promote ----------------
const promoted = [];
let rejObs = 0, rejLabel = 0, rejNb = 0, byMajority = 0;
for (const cl of clusters.values()) {
  if (cl.obs < MIN_OBS) { rejObs++; continue; }
  if (cl.left.size < 2 || cl.right.size < 2) { rejNb++; continue; }
  // label CLAIM: unanimous, or a >=90% majority with >=3 votes (the overlay
  // misreads base64 walls; the pixels of a repeated cell are still truth)
  const votes = [...cl.labels.entries()].sort((a, b) => b[1] - a[1]);
  const [ch, top] = votes[0];
  if (cl.labels.size !== 1) {
    if (top < 3 || top / cl.obs < 0.9) { rejLabel++; continue; }
    byMajority++;
  }
  const frac = cl.fracs.reduce((a, b) => a + b, 0) / cl.fracs.length;
  promoted.push({ ch, cp: ch.codePointAt(0), frac, labelShare: +(top / cl.obs).toFixed(3), cl });
}

// group into (cp, slot) -> variants sorted by obs
const bySlot = new Map();
for (const p of promoted) {
  const slot = Math.min(3, Math.floor(p.frac * 4));
  const k = `${p.cp}_${slot}`;
  if (!bySlot.has(k)) bySlot.set(k, []);
  bySlot.get(k).push(p);
}
let overflow = 0;
const targets = [];
for (const [k, list] of [...bySlot.entries()].sort()) {
  list.sort((a, b) => b.cl.obs - a.cl.obs);
  if (list.length > MAX_VAR) { overflow += list.length - MAX_VAR; list.length = MAX_VAR; }
  list.forEach((p, i) => {
    const slot = +k.split('_')[1];
    const id = `${p.cp}_p${slot}_v${i + 1}`;
    targets.push({ id, ch: p.ch, cp: p.cp, phaseSlot: slot, phx: slot / 4, variant: i + 1,
      w: p.cl.w, h: p.cl.h, adv: +medianAdv().toFixed(6), frac: +p.frac.toFixed(4), obs: p.cl.obs, srcs: p.cl.srcs });
    if (!DRY) writeFileSync(`${root}/targets/${id}.pgm`,
      Buffer.concat([Buffer.from(`P5\n${p.cl.w} ${p.cl.h}\n255\n`), p.cl.px]));
  });
}

if (!DRY) {
  mkdirSync(`${root}/targets`, { recursive: true });
  writeFileSync(`${root}/targets/index.json`, JSON.stringify({
    adv: +medianAdv().toFixed(6), source: docs,
    note: 'cells cut on the fitted monospace lattice from pages/<doc>/, ' +
      'trimmed to ink rows +1 white guard row; promoted at >=' + MIN_OBS +
      ' byte-identical observations with diverse neighbors and unanimous overlay label. ' +
      'phx = phaseSlot/4 (quarter-px convention); frac = mean sub-px cell origin.',
    targets,
  }, null, 1));
}

const chars = new Set(targets.map(t => t.ch));
if (stats.bandAdvs.length) {
  const s = [...stats.bandAdvs].sort((a, b) => a - b);
  console.log(`band advance: median ${s[s.length >> 1].toFixed(4)} px  (q10 ${s[s.length / 10 | 0].toFixed(4)}, q90 ${s[9 * s.length / 10 | 0].toFixed(4)}, n ${s.length})`);
}
console.log(`pages ${stats.pages}  bands ${stats.bands} (noWords ${stats.bandsNoWords}, offLattice ${stats.bandsOffLattice})`);
console.log(`cells ${stats.cells} (masked ${stats.cellsMasked}, blank ${stats.cellsBlank})  clusters ${clusters.size}`);
console.log(`promoted ${promoted.length} clusters (${byMajority} by 90% majority label) -> ${targets.length} targets, ${chars.size} distinct chars (variant overflow dropped: ${overflow})`);
console.log(`rejected: obs<${MIN_OBS} ${rejObs}, label-conflict ${rejLabel}, neighbor-diversity ${rejNb}; words dropped ${stats.wordsDropped}`);
console.log([...chars].sort().join(''));
if (!DRY) console.log(`\nwrote targets/index.json + ${targets.length} PGMs`);

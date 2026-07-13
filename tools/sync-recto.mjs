// sync-recto.mjs — push the certified engine into the Recto PDF editor's
// ocr_tool plugin. char_training stays the ONLY place the engine is
// developed (edit → corpus gate → sync); Recto's copies are verbatim and
// never hand-edited there.
//
//   node tools/sync-recto.mjs             # sync (default Recto: ../Recto)
//   node tools/sync-recto.mjs --check     # report stale files, write nothing (exit 1 if stale)
//   node tools/sync-recto.mjs --recto <path-to-Recto>
//
// What syncs:
//   src/core.js, src/ocr.js, src/blindocr.js -> ocr_tool/static/ocr_tool/engine/
//   assets/glyphs/glyphs_*.json              -> ocr_tool/static/ocr_tool/glyphs/ (+ index.json)
// Engine script cache-busters in ocr_tool/tool.py are rewritten to a content
// hash, so browsers refetch exactly when a file actually changed.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const o = { check: false, recto: resolve(REPO, '..', 'Recto') };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--check') o.check = true;
  else if (a === '--recto') o.recto = resolve(process.cwd(), process.argv[++i]);
  else { console.error(`unknown arg: ${a}`); process.exit(2); }
}

const PLUGIN = join(o.recto, 'ocr_tool');
if (!existsSync(join(PLUGIN, 'tool.py'))) {
  console.error(`no ocr_tool plugin at ${PLUGIN} — pass --recto <path-to-Recto>`);
  process.exit(2);
}

const ENGINE_FILES = ['core.js', 'ocr.js', 'blindocr.js'];
const engineDir = join(PLUGIN, 'static', 'ocr_tool', 'engine');
const glyphDir = join(PLUGIN, 'static', 'ocr_tool', 'glyphs');

const hash8 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 8);
let stale = 0, synced = 0;

function place(src, dst) {
  const want = readFileSync(src);
  const have = existsSync(dst) ? readFileSync(dst) : null;
  if (have && have.equals(want)) return false;
  stale++;
  if (!o.check) { writeFileSync(dst, want); synced++; }
  return true;
}

// 1. engine files (verbatim)
if (!o.check) mkdirSync(engineDir, { recursive: true });
const versions = {};
for (const f of ENGINE_FILES) {
  const src = join(REPO, 'src', f);
  const changed = place(src, join(engineDir, f));
  versions[f] = hash8(readFileSync(src));
  console.log(`${changed ? (o.check ? 'STALE ' : 'sync  ') : 'same  '} engine/${f}  v=${versions[f]}`);
}

// 2. glyph sets + index.json (stale sets in Recto are removed)
// _OFF sets are disabled experiments — never shipped
const sets = readdirSync(join(REPO, 'assets', 'glyphs'))
  .filter(f => /^glyphs_.*\.json$/.test(f) && !/_OFF\.json$/.test(f)).sort();
if (!sets.length) { console.error('no glyph sets in assets/glyphs — export them first'); process.exit(2); }
if (!o.check) mkdirSync(glyphDir, { recursive: true });
for (const f of sets)
  if (place(join(REPO, 'assets', 'glyphs', f), join(glyphDir, f)))
    console.log(`${o.check ? 'STALE ' : 'sync  '} glyphs/${f}`);
const index = JSON.stringify(sets, null, 2) + '\n';
const indexPath = join(glyphDir, 'index.json');
if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== index) {
  stale++;
  if (!o.check) { writeFileSync(indexPath, index); synced++; console.log('sync   glyphs/index.json'); }
  else console.log('STALE  glyphs/index.json');
}
if (existsSync(glyphDir))
  for (const f of readdirSync(glyphDir))
    if (f !== 'index.json' && !sets.includes(f)) {
      stale++;
      if (!o.check) { rmSync(join(glyphDir, f)); console.log(`remove glyphs/${f} (stale)`); }
      else console.log(`STALE  glyphs/${f} (should be removed)`);
    }

// 3. cache-buster versions in tool.py (content-hash of each engine file)
const toolPy = join(PLUGIN, 'tool.py');
let py = readFileSync(toolPy, 'utf8');
const before = py;
for (const f of ENGINE_FILES)
  py = py.replace(
    new RegExp(`('ocr_tool/engine/${f.replace('.', '\\.')}', 'version': ')v=[^']*(')`),
    `$1v=${versions[f]}$2`);
if (py !== before) {
  stale++;
  if (!o.check) { writeFileSync(toolPy, py); synced++; console.log('sync   tool.py cache-busters'); }
  else console.log('STALE  tool.py cache-busters');
}

if (o.check) {
  console.log(stale ? `\n${stale} file(s) stale — run: npm run sync:recto` : '\nRecto is in sync');
  process.exit(stale ? 1 : 0);
}
console.log(synced ? `\nsynced ${synced} file(s) -> ${PLUGIN}` : '\nnothing to do — Recto already in sync');

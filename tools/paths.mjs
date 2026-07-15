// paths.mjs — shared path discovery for the bench scripts: the browser executable
// and the working PDF. Kept in one place so a new PDF or browser location only has to
// be handled once (the three tools each used to carry their own copy).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// First Chrome/Chromium/Edge that exists, or '' if none (caller errors with a
// clear message; CHROME=<path> / --chrome always win in the callers).
export function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:/Program Files';
    const px = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    return [
      `${px}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${la}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
      `${px}/Microsoft/Edge/Application/msedge.exe`,
    ].find(existsSync) || '';
  }
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].find(existsSync) || '';
  return [                                   // linux
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].find(existsSync) || '';
}

// Drop the app's own startup work before navigating. training.html's DOMContentLoaded
// handler wires up the interactive UI and fire-and-forgets autoLoadTemplatesFromHTTP() —
// loading all ~2000 template PNGs into a viewer scoped inside that handler, never exposed
// on window. Every bench script builds its OWN viewer and loads templates itself, so the
// app's load is unreachable: pure waste that also runs CONCURRENTLY with the bench's load,
// fighting over Chrome's ~6 connections/host and the single decode thread (measured ~1.4s
// of contention on a 2134-template cold load). Swallowing the DOMContentLoaded listener
// skips the app init entirely; the bench only needs the top-level classes/globals, which
// are defined regardless. Call BEFORE page.goto so the override is in place at parse time.
export async function suppressAppInit(page) {
  await page.evaluateOnNewDocument(() => {
    const realAdd = document.addEventListener.bind(document);
    document.addEventListener = (type, ...rest) =>
      type === 'DOMContentLoaded' ? undefined : realAdd(type, ...rest);
  });
}

// The working PDF: the most-recently-modified *.pdf in `dir` (the repo root), so the
// bench always targets whatever document was last dropped in — no filename to keep in
// sync as the source PDF is swapped. Returns '' if the directory holds no PDF.
export function findPdf(dir) {
  const pdfs = readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => resolve(dir, f));
  if (pdfs.length <= 1) return pdfs[0] || '';
  return pdfs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

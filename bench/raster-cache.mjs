// raster-cache.mjs — node half of the per-page raster cache (browser half:
// raster-cache-browser.js, which documents the record format).
//
// The cache lives at bench/raster-cache/<sha256[:16] of the PDF bytes>/ so it is
// (a) keyed to the exact document — a swapped PDF gets a fresh directory — and
// (b) under the repo root, so launch.py's static handler already serves it to the
// page with no server changes. Node's only jobs are hashing the PDF, answering
// "is page N cached?", and writing the bytes the browser hands back; all
// encode/decode logic is front-end JS.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pageFile = (pno) => `page-${String(pno).padStart(4, '0')}.gray.gz`;

export async function openRasterCache(pdfPath, repoRoot) {
  const sha = await new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(pdfPath)
      .on('data', d => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
  const key = sha.slice(0, 16);
  const dir = join(repoRoot, 'bench', 'raster-cache', key);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;

  return {
    key,
    // URL path (relative to the served repo root) the browser fetches pages from.
    urlBase: `bench/raster-cache/${key}`,
    // numPages recorded by a previous completed run, or 0 if unknown.
    numPages: meta?.numPages ?? 0,
    pageName: pageFile,
    havePage: (pno) => existsSync(join(dir, pageFile(pno))),
    haveAll(numPages) {
      if (!numPages) return false;
      for (let p = 1; p <= numPages; p++) if (!this.havePage(p)) return false;
      return true;
    },
    writePage: (pno, base64) =>
      writeFileSync(join(dir, pageFile(pno)), Buffer.from(base64, 'base64')),
    writeMeta: (numPages, pdfName) => writeFileSync(metaPath, JSON.stringify({
      pdf: pdfName, sha256: sha, numPages,
      format: 'gzip(GRY1 header + u8 sum/3 | u16le R+G+B sums) — see raster-cache-browser.js',
    }, null, 2)),
  };
}

// ---------------------------------------------------------------------------
// serve.mjs — the repo's static HTTP server (Node port of the retired
// launch.py; zero dependencies).
//
// Serves the Auto OCR app (src/training.html) and the repo's static files
// (glyph sets under assets/glyphs/, the raster cache, corpus PDFs).
//
//   GET /            → 302 /src/training.html
//   GET /<path>      → static file from the repo root
//
// Usage:
//   node tools/serve.mjs                 # default port 8765, opens browser
//   node tools/serve.mjs --port 9000
//   node tools/serve.mjs --no-browser    # headless (rasterize.mjs, app test)
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { statSync, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 8765;

const argv = process.argv.slice(2);
const noBrowser = argv.includes('--no-browser');
const preferred = argv.includes('--port')
  ? Number(argv[argv.indexOf('--port') + 1]) : DEFAULT_PORT;

// .gz carries NO Content-Encoding on purpose: the app fetches *.gray.gz as raw
// bytes and inflates in JS — auto-decode by the browser would corrupt that
// (same behavior as Python's SimpleHTTPRequestHandler before it).
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Length': 0 }).end(); return;
  }
  const raw = req.url.split('?')[0].split('#')[0];
  if (raw === '/' || raw === '') {
    res.writeHead(302, { Location: '/src/training.html', 'Content-Length': 0 }).end();
    return;
  }
  let path;
  try { path = resolve(REPO, decodeURIComponent(raw).replace(/^\/+/, '')); }
  catch { res.writeHead(400, { 'Content-Length': 0 }).end(); return; }
  if (path !== REPO && !path.startsWith(REPO + sep)) {          // no escape from the repo
    res.writeHead(403, { 'Content-Length': 0 }).end(); return;
  }
  let st;
  try { st = statSync(path); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Length': 0 }).end(); return; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(path).pipe(res);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* headless box */ }
}

const server = createServer(handle);
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  server.listen(0, 'localhost');         // preferred port taken — let the OS assign one
});
server.listen(preferred, 'localhost');
server.on('listening', () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`Base dir  : ${REPO}`);
  console.log(`Server    : ${url}`);
  console.log('Press Ctrl+C to stop.\n');
  if (!noBrowser) setTimeout(() => openBrowser(url), 400);
});

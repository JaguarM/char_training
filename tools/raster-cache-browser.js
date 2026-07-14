// raster-cache-browser.js — browser half of the per-page raster cache.
//
// The reader never looks at RGBA: PageEngine._pageFor reduces the page to one
// grayscale Float32Array where each value is (R+G+B)/3 (see gray() in core.js). So
// the cache stores the integer sums R+G+B — the float is reconstructed as sum/3,
// the exact computation gray() performs, which makes the cached page BIT-IDENTICAL
// to live extraction by arithmetic, with no canvas, PNG premultiply, or color
// management in the loop. The sums are recovered from the engine's own page buffer
// via Math.round(g*3): g is (sum/3) rounded to f32, whose absolute error (< 1e-4
// at sums ≤ 765) is far below the 0.5 that rounding tolerates.
//
// Record layout (little-endian, after gunzip):
//   u32 magic 'GRY1' (0x31595247) · u32 mode · u32 w · u32 h · payload
//   mode 0: page had no embedded image (no payload)
//   mode 1: every sum divisible by 3 (R=G=B scans) → u8 per pixel, value = sum/3
//   mode 2: u16le per pixel, value = sum (legacy color pages: colorness only
//           recoverable via sum%3 — blind to colors whose sum is ≡0 mod 3)
//   mode 3: u16le sums + u8 per-pixel channel spread (max−min): true
//           colorness survives the cache. Written when any pixel has
//           spread > 0 and the rasterizer supplied a spread plane.
//
// Plain script (no modules): the bench injects it with addScriptTag, and a future
// browser-only app can load it with a <script> tag. Uses only web APIs
// (fetch, CompressionStream/DecompressionStream, FileReader).

const RC_MAGIC = 0x31595247; // 'GRY1'

// Fetch + decode one cached page. Returns null on miss (non-OK response),
// {empty:true} for a no-image page, else {w, h, gray:Float32Array}.
async function rcFetchPage(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return null;
  const buf = await new Response(
    r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const hdr = new Uint32Array(buf, 0, 4);
  if (hdr[0] !== RC_MAGIC) throw new Error(`raster cache: bad magic in ${url}`);
  const mode = hdr[1], w = hdr[2], h = hdr[3], n = w * h;
  if (mode === 0) return { empty: true };
  const gray = new Float32Array(n);
  if (mode === 1) {
    const v = new Uint8Array(buf, 16, n);
    for (let i = 0; i < n; i++) gray[i] = v[i];          // sum/3 is integer ≤ 255: exact
  } else if (mode === 2) {
    const s = new Uint16Array(buf, 16, n);
    for (let i = 0; i < n; i++) gray[i] = s[i] / 3;      // same op as gray(): identical f32
  } else if (mode === 3) {
    // sums + spread: real color (spread ≥ 4) seeds a whitening flood that
    // spreads only through pixels whose channels differ at all (colored AA
    // fringes), never through neutral ink; remaining spread 1-3 pixels are
    // producer JPEG jitter — their true gray is round(sum/3). Mirrors the
    // node bench (blind-read.mjs readGray mode 3) and the live-RGBA law in
    // blindocr.js whitenColored.
    const s = new Uint16Array(buf, 16, n);
    const sp = new Uint8Array(buf, 16 + 2 * n, n);
    const colored = new Uint8Array(n), stack = [];
    for (let i = 0; i < n; i++) {
      gray[i] = s[i] >= 765 ? 255 : Math.round(s[i] / 3);
      if (sp[i] >= 4) { colored[i] = 1; stack.push(i); }
    }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!colored[j] && sp[j]) { colored[j] = 1; stack.push(j); }
        }
    }
    for (let i = 0; i < n; i++) if (colored[i]) gray[i] = 255;
  } else throw new Error(`raster cache: unknown mode ${mode} in ${url}`);
  return { w, h, gray };
}

// Encode a page for the cache: `page` is {w, h, gray} (the engine's own _page
// buffer) or null for a page with no embedded image. Returns base64 of the
// gzipped record — the node side just Buffer.from(b64).writeFile()s it.
async function rcEncodePage(page) {
  let raw;
  if (!page) {
    raw = new Uint8Array(16);
    new Uint32Array(raw.buffer)[0] = RC_MAGIC;           // mode 0, w = h = 0
  } else {
    const n = page.w * page.h, g = page.gray;
    const sums = new Uint16Array(n);
    let mod3 = true;
    for (let i = 0; i < n; i++) {
      const s = Math.round(g[i] * 3);
      sums[i] = s;
      if (s % 3) mod3 = false;
    }
    let anySpread = false;
    if (page.spread) for (let i = 0; i < n; i++) if (page.spread[i]) { anySpread = true; break; }
    const mode = anySpread ? 3 : mod3 ? 1 : 2;
    raw = new Uint8Array(16 + (mode === 1 ? n : mode === 2 ? 2 * n : 3 * n));
    const hdr = new Uint32Array(raw.buffer, 0, 4);
    hdr[0] = RC_MAGIC; hdr[1] = mode; hdr[2] = page.w; hdr[3] = page.h;
    if (mode === 1) for (let i = 0; i < n; i++) raw[16 + i] = sums[i] / 3;
    else {
      raw.set(new Uint8Array(sums.buffer), 16);
      if (mode === 3) raw.set(page.spread, 16 + 2 * n);
    }
  }
  const gz = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return new Promise(resolve => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);
    fr.readAsDataURL(new Blob([gz]));
  });
}

// Point the viewer at a cached page: a plain {width,height} stand-in replaces the
// canvas (the OCR path only reads .width/.height), and the engine's page buffer is
// seeded directly so _pageFor never touches a canvas.
function rcSeedViewer(viewer, cached) {
  const img = { width: cached.w, height: cached.h };
  viewer.img = img;
  viewer.engine._page = { w: cached.w, h: cached.h, gray: cached.gray };
  viewer.engine._pageImg = img;
  return img;
}

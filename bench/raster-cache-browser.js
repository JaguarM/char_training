// raster-cache-browser.js — browser half of the per-page raster cache.
//
// The matcher never looks at RGBA: TemplateEngine._pageFor reduces the page to one
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
//   mode 2: u16le per pixel, value = sum
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
    raw = new Uint8Array(16 + (mod3 ? n : 2 * n));
    const hdr = new Uint32Array(raw.buffer, 0, 4);
    hdr[0] = RC_MAGIC; hdr[1] = mod3 ? 1 : 2; hdr[2] = page.w; hdr[3] = page.h;
    if (mod3) for (let i = 0; i < n; i++) raw[16 + i] = sums[i] / 3;
    else raw.set(new Uint8Array(sums.buffer), 16);
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

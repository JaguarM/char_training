// calibri-topo.mjs — visual sanity check: render letters with the certified
// unhinted pipeline (ftclone) at a given em64 and print the same ASCII art
// view.mjs uses, for side-by-side topology comparison with page crops.
//   node tools/attic/calibri-topo.mjs --font C:/Windows/Fonts/calibri.ttf --em64 1024 --chars daughter
import { FTClone } from '../ftclone.mjs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', 'C:/Windows/Fonts/calibri.ttf');
const EM64 = +optS('em64', '1024');
const CHARS = optS('chars', 'daughter');
const FX = +optS('fx', '0'), FY = +optS('fy', '0');

const W = 26, H = 30, PENX = 8, BASEY = 20;
const clone = new FTClone(FONT, W, H);

for (const ch of CHARS) {
  const cp = ch.codePointAt(0);
  const px = clone.render(cp, EM64, EM64, PENX * 64 + FX, BASEY * 64 + FY, 1);
  // trim to ink bbox + 1 margin
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++)
    if (px[r * W + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  console.log(`--- '${ch}' em64=${EM64} fx=${FX} fy=${FY} ink ${x1 - x0 + 1}x${y1 - y0 + 1} baseRow=${BASEY - y0}`);
  for (let r = Math.max(0, y0 - 1); r <= Math.min(H - 1, y1 + 1); r++) {
    let line = '';
    for (let c = Math.max(0, x0 - 1); c <= Math.min(W - 1, x1 + 1); c++) {
      const v = px[r * W + c];
      line += v === 255 ? '.' : v < 64 ? '#' : v < 160 ? '+' : '-';
    }
    console.log(String(r - BASEY).padStart(4), line);
  }
}

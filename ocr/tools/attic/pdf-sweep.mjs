// pdf-sweep.mjs — build a minimal uncompressed PDF that embeds a TTF and
// draws one glyph at N sub-pixel x offsets (rows), for rendering with real
// poppler (pdftoppm/pdftocairo) and byte-comparing against a page cut.
// 612x792pt page -> 816x1056 px at 96dpi (matches the doc raster).
//
//   node tools/attic/pdf-sweep.mjs --font fonts/cand/calibri-jondot.ttf \
//     --char w --out sweep-w.pdf
// Layout: 2 columns x 64 rows; row i draws at pixel x = X0 + i/128,
// baseline pixel y = 20 + (i%64)*16. Draw index i -> phase i/128 px.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const FONT = optS('font', 'fonts/cand/calibri-jondot.ttf');
const CH = optS('char', 'w');
const OUT = optS('out', 'sweep-w.pdf');
const SIZE = +optS('size', '12');      // pt; 12pt @96dpi = 16px em
const STEPS = +optS('steps', '128');   // total draws, 1/128 px apart
const PERCOL = 64;

const fontBytes = readFileSync(FONT);

// content stream: text draws
let content = '';
for (let i = 0; i < STEPS; i++) {
  const col = Math.floor(i / PERCOL), row = i % PERCOL;
  const xpx = 100 + col * 300 + i / 128;        // sub-pixel phase i/128
  const ypx = 20 + row * 16;                    // baseline pixel y
  const xpt = xpx * 3 / 4;                      // exact dyadic
  const ypt = 792 - ypx * 3 / 4;
  content += `BT /F1 ${SIZE} Tf ${xpt} ${ypt} Td (${CH.replace(/[\\()]/g, c => '\\' + c)}) Tj ET\n`;
}

const objs = [];
objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
objs[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>`;
objs[4] = `<< /Type /Font /Subtype /TrueType /BaseFont /Calibri /FirstChar 32 /LastChar 126 /Widths [${new Array(95).fill(500).join(' ')}] /FontDescriptor 5 0 R /Encoding /WinAnsiEncoding >>`;
objs[5] = `<< /Type /FontDescriptor /FontName /Calibri /Flags 32 /FontBBox [-500 -250 1200 900] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 632 /StemV 80 /FontFile2 7 0 R >>`;

function build() {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  const chunks = [Buffer.from(pdf, 'latin1')];
  let pos = pdf.length;
  const add = (n, body) => {
    offsets[n] = pos;
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const head = Buffer.from(`${n} 0 obj\n`, 'latin1');
    const tail = Buffer.from(`\nendobj\n`, 'latin1');
    chunks.push(head, b, tail);
    pos += head.length + b.length + tail.length;
  };
  add(1, objs[1]); add(2, objs[2]); add(3, objs[3]); add(4, objs[4]); add(5, objs[5]);
  add(6, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  add(7, Buffer.concat([
    Buffer.from(`<< /Length ${fontBytes.length} /Length1 ${fontBytes.length} >>\nstream\n`, 'latin1'),
    fontBytes,
    Buffer.from(`\nendstream`, 'latin1'),
  ]));
  const xrefPos = pos;
  let xref = `xref\n0 8\n0000000000 65535 f \n`;
  for (let n = 1; n <= 7; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
writeFileSync(OUT, build());
console.log(`wrote ${OUT}: ${STEPS} draws of '${CH}' at ${SIZE}pt, phases i/128 px`);

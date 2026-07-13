"""Persistent MuPDF hypothesis-render worker for guess-letter.mjs (level 3).

Reads JSON lines on stdin:
    {"id": 7, "glyphs": [["T", 45.0], ["h", 54.75], ...], "baseline": 231,
     "y0": 219, "y1": 236}
Renders a US-Letter page through the byte-proven corpus pipeline (Times New
Roman 12 pt via insert_text at pen*0.75 pt, MuPDF 96 dpi gray) with each glyph
at its stated pixel pen (callers pass exact quarter-px buckets, so the pen
snap is a no-op), and answers one JSON line:
    {"id": 7, "b64": "<base64 of rows y0..y1, all 816 cols, row-major u8>"}
{"cmd": "quit"} (or EOF) ends the worker.
"""
import base64, json, sys

import fitz
import numpy as np

FONT = r"C:\Windows\Fonts\times.ttf"


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        if req.get("cmd") == "quit":
            break
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        y = req["baseline"] * 0.75              # baseline may be half-px (y-phase 0.5)
        font = req.get("font", FONT)
        for ch, pen in req["glyphs"]:
            page.insert_text(fitz.Point(pen * 0.75, y), ch,
                             fontsize=12, fontfile=font, fontname="F0")
        pix = page.get_pixmap(matrix=fitz.Matrix(4 / 3, 4 / 3),
                              colorspace=fitz.csGRAY, alpha=False)
        a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)
        band = a[req["y0"]:req["y1"], :]
        doc.close()
        sys.stdout.write(json.dumps(
            {"id": req["id"], "b64": base64.b64encode(band.tobytes()).decode()}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

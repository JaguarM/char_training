"""Font-generic glyph raster generator for the identified corpus pipeline.

Renders every char of a font through the byte-exact pipeline (PDF text at
size_px*0.75 pt -> MuPDF raster at 96 dpi gray) at all subpixel phases the
pipeline can produce: 4 x-phases (1/4 px snap) x 2 y-phases (1/2 px snap).
Stores tight-cropped rasters + pen/baseline offsets + exact fractional
advances in one .npz per (font, size).

CLI:  python tools/fontgen/fontgen.py C:/Windows/Fonts/times.ttf 16 [out.npz]
API:  gs = GlyphSet.generate(fontfile, 16);  gs.save(path)
      gs = GlyphSet.load(path); gs.get('A', 0.25, 0.0) -> (raster, dx, dy)
"""
import json, sys
from pathlib import Path
import numpy as np

PHASES_X = (0.0, 0.25, 0.5, 0.75)
PHASES_Y = (0.0, 0.5)
DEFAULT_CHARS = ("".join(chr(c) for c in range(33, 127))  # printable ASCII, no space
                 + "‘’“”–—…•§¶©ﬁﬂ"   # ‘ ’ “ ” – — … •
                 # Western-European accents (French corpus emails: "Envoyé",
                 # "à" — 2026-07-14); adding chars only ADDS candidates, the
                 # existing rasters are unchanged by regeneration
                 + "àâäçèéêëìîïòôöùûüÿñæœÀÂÄÇÈÉÊËÌÎÏÒÔÖÙÛÜŸÑÆŒáíóúýÁÍÓÚÝßãõÃÕ°±²³€£¥")

class GlyphSet:
    def __init__(self, meta, glyphs, advances):
        self.meta = meta                  # dict
        self.glyphs = glyphs              # {(char, phx, phy): (uint8 raster, dx, dy)}
        self.advances = advances          # {char: float px}

    @classmethod
    def generate(cls, fontfile, size_px, chars=DEFAULT_CHARS, linear=False):
        """linear=True remaps the raster to the report.pdf producer's bytes:
        g+1 for g in 129..254, g elsewhere (empirical map, proven byte-exact
        on the probe glyphs — REPORT_RENDERER_HUNT.md, 2026-07-11)."""
        import fitz, freetype
        fontfile = str(fontfile)
        cell = max(int(size_px * 2.5), 24)
        cols = max(1, 800 // cell)
        rows_per_page = max(1, (1040 - cell) // cell)
        per_page = cols * rows_per_page

        slots = [(c, ix, iy) for c in chars for ix in range(len(PHASES_X))
                 for iy in range(len(PHASES_Y))]
        doc = fitz.open()
        placement = []                     # (pageidx, char, ix, iy, penx_int, basey_int)
        for i, (c, ix, iy) in enumerate(slots):
            k = i % per_page
            if k == 0:
                page = doc.new_page(width=612, height=792)
            r, col = divmod(k, cols)
            penx = col * cell + cell // 3
            basey = r * cell + cell
            page.insert_text(fitz.Point((penx + PHASES_X[ix]) * 0.75,
                                        (basey + PHASES_Y[iy]) * 0.75),
                             c, fontsize=size_px * 0.75, fontfile=fontfile, fontname="F0")
            placement.append((len(doc) - 1, c, ix, iy, penx, basey))

        pages_arr = []
        for p in range(len(doc)):
            pix = doc[p].get_pixmap(matrix=fitz.Matrix(4/3, 4/3), colorspace=fitz.csGRAY, alpha=False)
            g = (np.frombuffer(pix.samples, dtype=np.uint8)
                 .reshape(pix.height, pix.width).copy())
            if linear:
                # empirical producer map (REPORT_RENDERER_HUNT): identity for
                # g<=126, +1 for 128..254, 255 stays. Single-glyph-on-white law
                # bytes never hit 127, so no ambiguity remains.
                g[(g >= 128) & (g != 255)] += 1
            pages_arr.append(g)
        doc.close()

        glyphs = {}
        wpre, wpost = int(size_px * 0.75), int(size_px * 1.6)
        hup, hdn = int(size_px * 1.2), int(size_px * 0.6)
        for p, c, ix, iy, penx, basey in placement:
            win = pages_arr[p][basey-hup:basey+hdn, penx-wpre:penx+wpost]
            ink = win < 255
            if not ink.any():
                glyphs[(c, PHASES_X[ix], PHASES_Y[iy])] = (np.zeros((0, 0), np.uint8), 0, 0)
                continue
            ys, xs = np.nonzero(ink)
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            raster = win[y0:y1, x0:x1].copy()
            dx = int(x0) - wpre          # ink left  relative to integer pen x
            dy = int(y0) - hup           # ink top   relative to integer baseline y
            glyphs[(c, PHASES_X[ix], PHASES_Y[iy])] = (raster, dx, dy)

        face = freetype.Face(fontfile)
        upem = face.units_per_EM
        advances = {}
        for c in chars:
            gi = face.get_char_index(c)
            adv = face.get_advance(gi, freetype.FT_LOAD_NO_SCALE) if gi else 0
            advances[c] = adv * size_px / upem
        meta = {"fontfile": fontfile, "size_px": size_px, "chars": chars,
                "phases_x": PHASES_X, "phases_y": PHASES_Y,
                "pipeline": ("mupdf-96dpi-gray+linear-remap (report.pdf producer, "
                             "REPORT_RENDERER_HUNT.md)" if linear else
                             "mupdf-96dpi-gray (byte-exact, NOTES.md)")}
        return cls(meta, glyphs, advances)

    def get(self, char, phx, phy=0.0):
        return self.glyphs[(char, phx, phy)]

    def save(self, path):
        out = {"meta": np.frombuffer(json.dumps(self.meta).encode(), dtype=np.uint8),
               "adv": np.array([self.advances[c] for c in self.meta["chars"]])}
        for (c, phx, phy), (arr, dx, dy) in self.glyphs.items():
            key = f"g_{ord(c)}_{int(phx*4)}_{int(phy*2)}"
            out[key] = arr
            out["o" + key[1:]] = np.array([dx, dy], np.int16)
        np.savez_compressed(path, **out)

    @classmethod
    def load(cls, path):
        z = np.load(path)
        meta = json.loads(bytes(z["meta"]).decode())
        advances = dict(zip(meta["chars"], z["adv"]))
        glyphs = {}
        for c in meta["chars"]:
            for phx in meta["phases_x"]:
                for phy in meta["phases_y"]:
                    key = f"_{ord(c)}_{int(phx*4)}_{int(phy*2)}"
                    dx, dy = (int(v) for v in z["o" + key])
                    glyphs[(c, phx, phy)] = (z["g" + key], dx, dy)
        return cls(meta, glyphs, advances)

if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if a != "--linear"]
    linear = "--linear" in sys.argv
    fontfile = argv[0]
    size_px = float(argv[1]) if len(argv) > 1 else 16
    size_px = int(size_px) if size_px == int(size_px) else size_px
    out = argv[2] if len(argv) > 2 else str(
        Path(__file__).resolve().parents[2] / "assets" / "fonts" /
        f"{Path(fontfile).stem}{'lin' if linear else ''}_{size_px}.npz")
    Path(out).parent.mkdir(exist_ok=True)
    gs = GlyphSet.generate(fontfile, size_px, linear=linear)
    gs.save(out)
    n_ink = sum(1 for a, _, _ in gs.glyphs.values() if a.size)
    print(f"{out}: {len(gs.glyphs)} glyph rasters ({n_ink} with ink), "
          f"{Path(out).stat().st_size//1024} KB")

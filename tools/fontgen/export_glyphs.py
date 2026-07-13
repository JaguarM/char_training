"""Export a fontgen GlyphSet to JSON for node-side consumers
(guess-letter.mjs, blind-read.mjs).

Both y-phases are exported (integer and half-px baselines — MuPDF can produce
either; the known corpus uses integer only). Rasters are the raw uint8 gray
windows (single glyph on white), base64, row-major, with (dx, dy) offsets
relative to the integer pen / baseline and the exact dyadic freetype advance.
Keys are "phx_phy" (e.g. "0.25_0.5").

    python tools/fontgen/export_glyphs.py [assets/fonts/times_16.npz] [out.json]
"""
import base64, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fontgen import GlyphSet

if len(sys.argv) == 2:
    sys.exit(f"refusing to write {sys.argv[1]} to the default glyphs_times16.json - "
             f"pass an explicit out path, e.g.\n"
             f"    python tools/fontgen/export_glyphs.py {sys.argv[1]} "
             f"assets/glyphs/glyphs_<name>.json")

REPO = Path(__file__).resolve().parents[2]
npz = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "assets" / "fonts" / "times_16.npz"
out = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "assets" / "glyphs" / "glyphs_times16.json"

gs = GlyphSet.load(npz)
chars = {}
for c in gs.meta["chars"]:
    ph = {}
    for phx in gs.meta["phases_x"]:
        for phy in gs.meta["phases_y"]:
            arr, dx, dy = gs.get(c, phx, phy)
            key = str(phx) if phy == 0.0 else f"{phx}_{phy}"   # legacy key for phy=0
            ph[key] = {"w": int(arr.shape[1]) if arr.size else 0,
                       "h": int(arr.shape[0]) if arr.size else 0,
                       "dx": int(dx), "dy": int(dy),
                       "b64": base64.b64encode(arr.tobytes()).decode() if arr.size else ""}
    chars[c] = {"adv": float(gs.advances[c]), "ph": ph}
out.write_text(json.dumps({"font": str(npz.name), "size_px": gs.meta["size_px"],
                           "linear": "linear-remap" in gs.meta.get("pipeline", ""),
                           "phases_x": gs.meta["phases_x"],
                           "phases_y": gs.meta["phases_y"], "chars": chars}))
print(f"{out}: {len(chars)} chars x {len(gs.meta['phases_x'])}x{len(gs.meta['phases_y'])} phases, "
      f"{out.stat().st_size // 1024} KB")

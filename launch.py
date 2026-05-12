"""
launch.py
---------
Serves training.html and auto-loads the template dictionary on startup.

  GET /                    → training.html
  GET /<path>              → static file from this directory
  GET /api/templates       → JSON manifest [{filename, char}, …] from ./templates/
  GET /templates/<file>    → individual template PNG

Usage:
  python launch.py                # default port 8765
  python launch.py --port 9000
  python launch.py --no-browser   # don't auto-open browser
"""

import argparse
import http.server
import json
import socket
import threading
import webbrowser
from pathlib import Path


BASE_DIR = Path(__file__).parent
DEFAULT_PORT = 8765


# ---------------------------------------------------------------------------
# Stem → character mapping (mirrors TemplateEngine.stemToChar in training.js)
# ---------------------------------------------------------------------------
def stem_to_char(stem: str) -> str | None:
    base = stem.split("_")[0]
    if base == "eq":
        return "="
    if base == "slash":
        return "/"
    if base == "plus":
        return "+"
    if base == "minus":
        return "-"
    if "_UPPER" in stem:
        return stem.split("_UPPER")[0]
    return base if len(base) == 1 else None


def build_template_manifest() -> list[dict]:
    """Scan ./templates/ and return [{filename, char}] for all valid PNGs (all variants included)."""
    templates_dir = BASE_DIR / "templates"
    if not templates_dir.exists():
        return []

    result: list[dict] = []
    for f in sorted(templates_dir.glob("*.png")):
        if "unmatched" in f.name:
            continue
        char = stem_to_char(f.stem)
        if not char or len(char) != 1:
            continue
        result.append({"filename": f.name, "char": char})

    return result


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def do_GET(self):
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/training.html")
            self.end_headers()
        elif self.path == "/api/templates":
            self._serve_json(build_template_manifest())
        else:
            super().do_GET()

    def _serve_json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # suppress all request logging


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
def find_free_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("localhost", preferred)) != 0:
            return preferred
    # preferred is taken — let OS assign one
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("localhost", 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description="Serve the Base64 Layout Debugger.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    port = find_free_port(args.port)
    url = f"http://localhost:{port}"

    n_templates = len(build_template_manifest())
    print(f"Base dir  : {BASE_DIR}")
    print(f"Templates : {n_templates} characters found in ./templates/")
    print(f"Server    : {url}")
    print("Press Ctrl+C to stop.\n")

    server = http.server.HTTPServer(("localhost", port), Handler)

    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=[url]).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()

"""
launch.py
---------
Serves the Auto OCR app (src/training.html) and the repo's static files
(glyph sets under assets/glyphs/, the raster cache, corpus PDFs).

  GET /                    → src/training.html
  GET /<path>              → static file from this directory

Usage:
  python launch.py                # default port 8765
  python launch.py --port 9000
  python launch.py --no-browser   # don't auto-open browser
"""

import argparse
import http.server
import socket
import threading
import webbrowser
from pathlib import Path


BASE_DIR = Path(__file__).parent
DEFAULT_PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 keep-alive + threaded serving: the page fetches the glyph-set
    # JSONs and raster-cache pages in parallel; reusing connections keeps
    # startup fast.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def do_GET(self):
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/src/training.html")
            self.send_header("Content-Length", "0")  # keep keep-alive in sync (HTTP/1.1)
            self.end_headers()
        else:
            super().do_GET()

    def log_message(self, fmt, *args):
        pass  # suppress all request logging


def find_free_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("localhost", preferred)) != 0:
            return preferred
    # preferred is taken — let OS assign one
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("localhost", 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description="Serve the Auto OCR app.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    port = find_free_port(args.port)
    url = f"http://localhost:{port}"

    print(f"Base dir  : {BASE_DIR}")
    print(f"Server    : {url}")
    print("Press Ctrl+C to stop.\n")

    server = http.server.ThreadingHTTPServer(("localhost", port), Handler)

    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=[url]).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()

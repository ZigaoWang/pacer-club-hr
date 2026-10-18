#!/usr/bin/env python3
"""
Pacer Club · Heart Rate Booth server.

Serves the booth page on http://localhost:8000 and prints receipts. The page
sends a finished 1-bit bitmap (576 dots wide for 80 mm paper at 203 dpi); this
script only decides where it goes, from printer.json:

  "a4"     Any printer the Mac knows. The receipt is placed at true size on an
           A4 page, inside an outline of the 80 mm paper, and sent with lp.
  "epson"  An ESC/POS thermal printer (Epson TM-T82III). The bitmap goes as a
           raster image followed by a cut, either straight to the printer over
           the network (port 9100, no driver at all) or through a raw macOS
           print queue over USB.
  "off"    Don't print.

Changing printer is changing that one word. Standard library only:

  python3 booth.py
"""

import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "printer.json")
PORT = int(os.environ.get("PORT", "8000"))

DOTS_PER_MM = 8           # 203 dpi
PAPER_MM = 80


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


# ── A4 test prints ─────────────────────────────────────────────

def a4_pdf(width, height, bits):
    """One or more A4 pages with the receipt at true size, centered, inside a
    hairline outline of the 80 mm paper. Long receipts continue on a new page."""
    pt_per_dot = 72 / 25.4 / DOTS_PER_MM
    page_w, page_h = 595.28, 841.89
    margin = 12 * 72 / 25.4
    row_bytes = (width + 7) // 8
    rows_per_page = int((page_h - 2 * margin) / pt_per_dot)

    objects = []

    def add(obj):
        objects.append(obj)
        return len(objects)

    pages = []
    catalog = add(None)
    pages_obj = add(None)
    for top in range(0, height, rows_per_page):
        rows = min(rows_per_page, height - top)
        chunk = bits[top * row_bytes:(top + rows) * row_bytes]
        data = zlib.compress(chunk)
        img = add(
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
            b"/ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] "
            b"/Interpolate false /Filter /FlateDecode /Length %d >>\nstream\n"
            % (width, rows, len(data)) + data + b"\nendstream"
        )
        img_w, img_h = width * pt_per_dot, rows * pt_per_dot
        paper_w = PAPER_MM * 72 / 25.4
        x = (page_w - img_w) / 2
        y = page_h - margin - img_h
        px = (page_w - paper_w) / 2
        draw = (
            "q 0.6 G 0.4 w [3 3] 0 d %.2f %.2f %.2f %.2f re S Q\n"
            "q %.3f 0 0 %.3f %.3f %.3f cm /Im Do Q\n"
            % (px, y - 4, paper_w, img_h + 8, img_w, img_h, x, y)
        ).encode()
        content = add(b"<< /Length %d >>\nstream\n" % len(draw) + draw + b"\nendstream")
        page = add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] "
            b"/Resources << /XObject << /Im %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_obj, page_w, page_h, img, content)
        )
        pages.append(page)

    objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj
    objects[pages_obj - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % p for p in pages), len(pages))

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, catalog, xref)
    return bytes(out)


def print_a4(cfg, width, height, bits):
    pdf = a4_pdf(width, height, bits)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf)
        path = f.name
    # Keep a copy of the last one, handy for checking without wasting paper.
    with open(os.path.join(HERE, "last-receipt.pdf"), "wb") as f:
        f.write(pdf)
    cmd = ["lp", "-o", "media=A4", "-o", "print-scaling=none", "-o", "fit-to-page=false"]
    if cfg.get("queue"):
        cmd += ["-d", cfg["queue"]]
    run(cmd + [path])
    os.unlink(path)


# ── ESC/POS thermal printers ───────────────────────────────────

def escpos(width, height, bits, cut="full", feed_lines=4):
    row_bytes = (width + 7) // 8
    out = bytearray(b"\x1b@")                       # ESC @   initialise
    out += b"\x1ba\x01"                             # ESC a 1 center
    band = 256                                      # rows per raster command
    for top in range(0, height, band):
        rows = min(band, height - top)
        out += b"\x1dv0\x00"                        # GS v 0  raster bit image
        out += bytes([row_bytes & 255, row_bytes >> 8, rows & 255, rows >> 8])
        out += bits[top * row_bytes:(top + rows) * row_bytes]
    out += b"\x1bd" + bytes([feed_lines])           # ESC d n feed past the cutter
    out += b"\x1dV" + (b"A" if cut == "full" else b"B") + b"\x00"   # GS V m 0 cut
    return bytes(out)


def print_epson(cfg, width, height, bits):
    data = escpos(width, height, bits, cfg.get("cut", "full"))
    if cfg.get("connection", "network") == "network":
        with socket.create_connection((cfg["host"], int(cfg.get("port", 9100))), timeout=5) as s:
            s.sendall(data)
    else:
        with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
            f.write(data)
            path = f.name
        run(["lp", "-d", cfg["usbQueue"], "-o", "raw", path])
        os.unlink(path)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"{cmd[0]} failed")


# ── Server ─────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/print":
            cfg = load_config()
            return self.reply(200, {"printer": cfg.get("printer", "off")})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/print":
            return self.reply(404, {"error": "Not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            width, height = int(body["width"]), int(body["height"])
            bits = base64.b64decode(body["bits"])
            if len(bits) != ((width + 7) // 8) * height:
                raise ValueError("Bitmap size doesn't match its dimensions")
            cfg = load_config()
            printer = cfg.get("printer", "off")
            if printer == "a4":
                print_a4(cfg.get("a4", {}), width, height, bits)
            elif printer == "epson":
                print_epson(cfg.get("epson", {}), width, height, bits)
            self.reply(200, {"printer": printer})
        except Exception as e:  # noqa: BLE001 — every failure goes back to the page as text
            self.log_message("print failed: %s", e)
            self.reply(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        if "/print" in (args[0] if args else "") or "failed" in fmt:
            sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    cfg = load_config()
    print(f"Heart Rate Booth on http://localhost:{PORT}  ·  printer: {cfg.get('printer', 'off')}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

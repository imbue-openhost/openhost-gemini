#!/usr/bin/env python3
"""Tiny HTTP status sidecar for the OpenHost Gemini (agate) app.

The OpenHost router requires every app to answer HTTP on the manifest
``port`` so it can health-check the app and render a dashboard tile.
Gemini itself is TLS-wrapped TCP on :1965 (published directly via the
``[[ports]]`` entry in ``openhost.toml``), which the router does not
touch.

Endpoints:

``GET /healthz``
    Returns HTTP 200 with body ``ok`` iff something is listening on
    ``127.0.0.1:1965`` (agate's port). Returns 503 otherwise so the
    dashboard reflects a crashed agate process.

``GET /`` and ``GET /index.html``
    Serve a small HTML landing page with the ``gemini://...`` URL,
    a short explainer, and pointers to a few Gemini clients. The
    landing page is reachable via the OpenHost router without a
    signed-in OpenHost session (``public_paths = ["/"]`` in the
    manifest) so visitors who stumble onto the HTTP side know what
    to do.
"""

from __future__ import annotations

import html
import os
import re
import socket
import sys
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from typing import Any


def _load_status_port() -> int:
    raw = os.environ.get("STATUS_PORT", "").strip() or "8080"
    try:
        port = int(raw)
    except ValueError:
        sys.stderr.write(f"[status] FATAL: STATUS_PORT={raw!r} is not an integer\n")
        sys.exit(1)
    if not 1 <= port <= 65535:
        sys.stderr.write(f"[status] FATAL: STATUS_PORT={raw!r} out of range\n")
        sys.exit(1)
    return port


STATUS_PORT = _load_status_port()

# Agate's fixed listen port. Checking this specific port is a more
# useful liveness signal than anything else we could probe.
AGATE_HOST = "127.0.0.1"
AGATE_PORT = 1965
PROBE_TIMEOUT_SECONDS = 1.0

# GEMINI_RESOLVED_HOSTNAME is exported by start.sh after resolving
# $GEMINI_HOSTNAME / <app_name>.<zone_domain>. If unset (direct
# invocation for dev / tests) we fall back to a placeholder.
GEMINI_HOSTNAME = os.environ.get("GEMINI_RESOLVED_HOSTNAME", "").strip() or "your-openhost-zone"

# Permissive but safe hostname shape: labels of [A-Za-z0-9-] up to
# 63 chars, separated by dots, total <= 253 chars. A value that
# doesn't match goes through as "your-openhost-zone" instead of
# reaching the HTML.
_VALID_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)


def _agate_up() -> bool:
    """Return True iff something is listening on 127.0.0.1:1965.

    Short-timeout TCP connect rather than a TLS handshake: we just
    want "process alive and bound to its port", not "Gemini stream
    fully healthy", and we don't want to burn CPU on a TLS dance
    per health check.
    """
    try:
        with socket.create_connection((AGATE_HOST, AGATE_PORT), timeout=PROBE_TIMEOUT_SECONDS):
            return True
    except OSError:
        return False


_HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Gemini Capsule</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
           Roboto, sans-serif; background:#0f1117; color:#e1e4e8;
           padding:40px; max-width:720px; margin:0 auto; line-height:1.4; }
    h1 { color:#fff; }
    h2 { color:#fff; margin-top:1.5em; }
    code { background:#0d1117; border:1px solid #30363d; padding:2px 6px;
           border-radius:4px; }
    .card { background:#161b22; border:1px solid #30363d; border-radius:8px;
            padding:16px 20px; margin:16px 0; }
    .status-ok { color:#2ea043; font-weight:600; }
    .status-bad { color:#f85149; font-weight:600; }
    ul { padding-left: 1.4em; }
    li { margin: 0.3em 0; }
    a { color:#58a6ff; }
  </style>
</head>
<body>
  <h1>Gemini Capsule</h1>

  <div class="card">
    <p>Agate status:
       <span class="@@STATUS_CLASS@@">@@STATUS_TEXT@@</span>
    </p>
  </div>

  <div class="card">
    <h2>Browsing</h2>
    <p>This is the HTTP landing page for a Gemini capsule. Gemini is a
       separate protocol from HTTP; point a Gemini client at:</p>
    <p><code>gemini://@@HOST@@/</code></p>
    <p>Some desktop and mobile clients:</p>
    <ul>
      <li><a href="https://lagrange.skyjake.fi/">Lagrange</a> (macOS, Linux, Windows, iOS, Android)</li>
      <li><a href="https://github.com/makew0rld/amfora">Amfora</a> (terminal, cross-platform)</li>
      <li><a href="https://github.com/mbrubeck/agate#gemini-clients">More clients in the agate README</a></li>
    </ul>
    <p>The server uses a self-signed TLS certificate, which is
       standard for Gemini. Your client will prompt you to trust it
       on first connect (Trust On First Use).</p>
  </div>

  <div class="card">
    <h2>Editing content</h2>
    <p>The capsule's gemtext files live under
       <code>$OPENHOST_APP_DATA_DIR/content/</code> in this app's
       persistent volume. Edit them with the file-browser app, or
       drop new <code>.gmi</code> files in and they are served
       immediately. See the
       <a href="https://gemini.circumlunar.space/docs/gemtext.gmi">gemtext format guide</a>
       for the small markup language.</p>
  </div>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    # Route access logs through stderr with a short tag so container
    # logs stay legible when interleaved with agate's log lines.
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
        sys.stderr.write("[status] " + (fmt % args) + "\n")

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            if _agate_up():
                self._respond(200, b"ok\n", "text/plain")
            else:
                self._respond(503, b"agate-not-listening\n", "text/plain")
            return
        if path in ("/", "/index.html"):
            up = _agate_up()
            host = GEMINI_HOSTNAME
            if not _VALID_HOSTNAME_RE.match(host):
                host = "your-openhost-zone"
            host = html.escape(host, quote=True)
            body = (
                _HTML_TEMPLATE
                .replace("@@STATUS_CLASS@@", "status-ok" if up else "status-bad")
                .replace(
                    "@@STATUS_TEXT@@",
                    "running" if up else "not listening on 1965 (still starting?)",
                )
                .replace("@@HOST@@", host)
            ).encode("utf-8")
            self._respond(200, body, "text/html; charset=utf-8")
            return
        self._respond(404, b"not found\n", "text/plain")

    def _respond(self, code: int, body: bytes, content_type: str) -> None:
        # A client can disconnect at any point in the response, not
        # just during body writing. send_response, send_header, and
        # end_headers all touch the socket. Catch the narrow set of
        # expected errors so genuine failures (disk full, bad fd,
        # permission denied) still propagate.
        try:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (
            BrokenPipeError,
            ConnectionResetError,
            ConnectionAbortedError,
            TimeoutError,
        ):
            pass


def main() -> int:
    try:
        server = ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), Handler)
    except OSError as exc:
        sys.stderr.write(f"[status] FATAL: cannot bind :{STATUS_PORT}: {exc}\n")
        return 1
    sys.stderr.write(f"[status] listening on :{STATUS_PORT}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""HTTP sidecar for the openhost-gemini app.

Three jobs:

1. Health check at ``/healthz`` (probes agate on 127.0.0.1:1965).
2. Landing page at ``/`` describing how to point a Gemini client at the
   capsule. Behind the OpenHost session gate by default (no
   ``public_paths`` declared in the manifest), so only the
   compute-space owner sees it.
3. WYSIWYG editor for the capsule's ``.gmi`` files at ``/edit``, with
   a small JSON file API at ``/api/files`` and ``/api/files/<path>``.
   Edits land in ``$OPENHOST_APP_DATA_DIR/content/`` directly; agate
   re-reads files on the next request, so changes are live without a
   restart.

Run as ``start.sh`` does in the container::

    cd sidecar
    python3 -m uvicorn server:app --host 0.0.0.0 --port "$STATUS_PORT"

Outside the container, install ``sidecar/requirements.txt`` first.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import socket
import tempfile
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import HTMLResponse
from starlette.responses import JSONResponse
from starlette.responses import PlainTextResponse
from starlette.responses import Response
from starlette.routing import Route
from starlette.staticfiles import StaticFiles

logger = logging.getLogger("openhost-gemini.sidecar")


# ----------------------------------------------------------------- config

# Agate's listen port. Used by the health probe.
AGATE_HOST = "127.0.0.1"
AGATE_PORT = 1965
PROBE_TIMEOUT_SECONDS = 1.0

# Paths derived from the runtime environment. The defaults are used by
# the unit/dev modes; under OpenHost both env vars are always set.
DATA_DIR = Path(os.environ.get("OPENHOST_APP_DATA_DIR", "/var/lib/openhost-gemini"))
CONTENT_DIR = (DATA_DIR / "content").resolve()

# Static assets shipped in the image.
SIDECAR_ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = SIDECAR_ROOT / "templates"
STATIC_DIR = SIDECAR_ROOT / "static"

# Cap saved files to a generous-but-bounded size. Gemtext is hand-edited
# prose; nobody legitimately writes a 10-MB capsule page through the
# WYSIWYG editor. The bound prevents a confused or hostile editor JS
# call from filling the persistent volume.
MAX_FILE_BYTES = 1 * 1024 * 1024  # 1 MiB

# Gemini hostname (resolved by start.sh; falls back if missing).
GEMINI_HOSTNAME = os.environ.get("GEMINI_RESOLVED_HOSTNAME", "").strip() or "your-openhost-zone"

# Permissive but safe hostname shape (RFC-ish). Anything that doesn't
# match goes through as a placeholder rather than reaching the HTML.
_VALID_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)

# Filenames stored in the content dir must look like a relative gemtext
# (or text/markdown) path. We allow letters, digits, dash, underscore,
# dot, and forward-slash (for subdirectories), and require a ``.gmi``
# extension. This keeps the editor focused on its job and makes the
# path-safety check simple.
_VALID_RELPATH_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")


# ---------------------------------------------------------------- helpers

def _safe_hostname() -> str:
    """Return the configured Gemini hostname or a placeholder."""
    if _VALID_HOSTNAME_RE.match(GEMINI_HOSTNAME):
        return GEMINI_HOSTNAME
    return "your-openhost-zone"


async def _agate_up() -> bool:
    """Return True iff something is listening on 127.0.0.1:1965.

    Short-timeout TCP connect rather than a TLS handshake -- we just
    need "process bound to its port", not "Gemini stream healthy", and
    we don't want to burn CPU per health check. The connect happens in
    a worker thread so the event loop doesn't block on the timeout.
    """

    def _probe() -> bool:
        try:
            with socket.create_connection((AGATE_HOST, AGATE_PORT), timeout=PROBE_TIMEOUT_SECONDS):
                return True
        except OSError:
            return False

    return await asyncio.to_thread(_probe)


def _resolve_content_path(rel: str) -> Path:
    """Resolve ``rel`` (a user-supplied relative path) against
    ``CONTENT_DIR`` and refuse anything that escapes the content dir,
    contains absolute components, or doesn't look like a gemtext file.

    Raises HTTPException with a 4xx status on rejection.
    """
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        raise HTTPException(400, "invalid path")
    if not _VALID_RELPATH_RE.match(rel):
        raise HTTPException(400, "path contains characters that are not allowed")
    if not rel.endswith(".gmi"):
        raise HTTPException(400, "only .gmi files are editable")

    candidate = (CONTENT_DIR / rel).resolve()
    # ``resolve(strict=False)`` follows symlinks. We re-check the
    # parents so a content-dir-relative symlink can't be used to
    # write outside the content dir on a future create-file call.
    try:
        candidate.relative_to(CONTENT_DIR)
    except ValueError:
        raise HTTPException(400, "path escapes the content directory")
    return candidate


def _list_gmi_files() -> list[str]:
    """Return relative paths of ``.gmi`` regular files under
    ``CONTENT_DIR``, sorted. Symlinks (in or out of bounds) are
    skipped: the editor refuses to read or write through symlinks at
    the per-file API, so listing them in the sidebar would just give
    the user clickable entries that 400.

    Errors traversing the directory propagate as HTTPException(500)
    with the underlying ``OSError`` message, mirroring how every
    other file-IO call in this module reports failures.
    """
    if not CONTENT_DIR.is_dir():
        return []
    paths: list[str] = []
    try:
        entries = list(CONTENT_DIR.rglob("*.gmi"))
    except OSError as exc:
        raise HTTPException(500, f"failed to list content dir: {exc}")
    for entry in entries:
        # is_symlink first so a dangling symlink doesn't trip is_file.
        if entry.is_symlink():
            continue
        try:
            if not entry.is_file():
                continue
        except OSError as exc:
            # A subtree we can't stat (e.g. permission flip mid-walk)
            # is not actionable; skip the entry rather than aborting
            # the whole list, but log so the operator can see why a
            # file is missing from the editor.
            logger.warning("skipping %s (cannot stat): %s", entry, exc)
            continue
        try:
            rel = entry.relative_to(CONTENT_DIR)
        except ValueError:
            # Should not happen for a non-symlink under CONTENT_DIR,
            # but be defensive.
            continue
        paths.append(str(rel))
    paths.sort()
    return paths


# ---------------------------------------------------------------- handlers

_LANDING_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemini Capsule</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, sans-serif; background:#0f1117; color:#e1e4e8;
            padding:40px; max-width:720px; margin:0 auto; line-height:1.4; }}
    h1 {{ color:#fff; }}
    h2 {{ color:#fff; margin-top:1.5em; }}
    code {{ background:#0d1117; border:1px solid #30363d; padding:2px 6px;
            border-radius:4px; }}
    .card {{ background:#161b22; border:1px solid #30363d; border-radius:8px;
             padding:16px 20px; margin:16px 0; }}
    .status-ok {{ color:#2ea043; font-weight:600; }}
    .status-bad {{ color:#f85149; font-weight:600; }}
    ul {{ padding-left: 1.4em; }}
    li {{ margin: 0.3em 0; }}
    a {{ color:#58a6ff; }}
    .cta {{
      display: inline-block; background:#1f6feb; color:#fff;
      text-decoration: none; padding: 8px 16px; border-radius: 6px;
      font-weight: 600;
    }}
    .cta:hover {{ background:#388bfd; }}
  </style>
</head>
<body>
  <h1>Gemini Capsule</h1>

  <div class="card">
    <p>Agate status: <span class="{status_class}">{status_text}</span></p>
  </div>

  <div class="card">
    <h2>Browsing</h2>
    <p>This is the HTTP landing page for a Gemini capsule. Gemini is a
       separate protocol from HTTP; point a Gemini client at:</p>
    <p><code>gemini://{host}/</code></p>
    <p>Some desktop and mobile clients:</p>
    <ul>
      <li><a href="https://lagrange.skyjake.fi/">Lagrange</a> (macOS, Linux, Windows, iOS, Android)</li>
      <li><a href="https://github.com/makew0rld/amfora">Amfora</a> (terminal, cross-platform)</li>
    </ul>
    <p>The server uses a self-signed TLS certificate, which is standard
       for Gemini. Your client will prompt you to trust it on first
       connect (Trust On First Use).</p>
  </div>

  <div class="card">
    <h2>Editing content</h2>
    <p>Edit your capsule's gemtext pages with the built-in WYSIWYG
       editor:</p>
    <p><a class="cta" href="/edit">Open editor</a></p>
    <p>(Or edit the files directly via the file-browser app; they
       live under <code>$OPENHOST_APP_DATA_DIR/content/</code>.)</p>
  </div>
</body>
</html>
"""


async def landing(request: Request) -> HTMLResponse:
    up = await _agate_up()
    body = _LANDING_TEMPLATE.format(
        status_class="status-ok" if up else "status-bad",
        status_text="running" if up else "not listening on 1965 (still starting?)",
        host=html.escape(_safe_hostname(), quote=True),
    )
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


async def healthz(request: Request) -> Response:
    if await _agate_up():
        return PlainTextResponse("ok\n")
    return PlainTextResponse("agate-not-listening\n", status_code=503)


async def edit_page(request: Request) -> HTMLResponse:
    """Serve the editor shell. The actual content + file list is
    populated by ``editor.js`` calling ``/api/files``."""
    try:
        template = (TEMPLATES_DIR / "editor.html").read_text(encoding="utf-8")
    except OSError as exc:
        # Should be impossible at runtime (the file is COPYed into the
        # image), but a broken build or hand-mounted volume could
        # remove it. Surface a 500 with context instead of letting an
        # unhandled exception become an opaque ASGI traceback.
        raise HTTPException(500, f"editor template missing: {exc}")
    return HTMLResponse(template, headers={"Cache-Control": "no-store"})


async def list_files(request: Request) -> JSONResponse:
    return JSONResponse({"files": _list_gmi_files()})


async def get_file(request: Request) -> JSONResponse:
    rel = request.path_params["rel"]
    path = _resolve_content_path(rel)
    # is_symlink first: Path.is_file follows symlinks, so a symlink to
    # a regular file would pass is_file and only get rejected by the
    # symlink check; a symlink to a directory would raise the "not a
    # regular file" error which is misleading. Refuse all symlinks
    # uniformly so every symlinked path produces the same clear
    # error, regardless of what it points at.
    if path.is_symlink():
        raise HTTPException(400, "symlinks are not editable")
    if not path.exists():
        raise HTTPException(404, f"no such file: {rel}")
    if not path.is_file():
        raise HTTPException(400, "path is not a regular file")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise HTTPException(500, f"failed to read: {exc}")
    return JSONResponse({"path": rel, "content": text})


async def _read_json_body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > MAX_FILE_BYTES + 1024:
        # 1 KiB headroom for the JSON envelope.
        raise HTTPException(413, "request body too large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"invalid JSON body: {exc}")
    if not isinstance(data, dict):
        raise HTTPException(400, "JSON body must be an object")
    return data


def _validate_content(value: Any, *, missing_message: str = "missing 'content' field") -> str:
    """Validate that ``value`` is a UTF-8-encodable string under the
    file size cap. Raises HTTPException with a 4xx detail on rejection.

    Distinguishes ``None`` (key absent) from a non-string value so the
    error message matches the user's actual mistake.
    """
    if value is None:
        raise HTTPException(400, missing_message)
    if not isinstance(value, str):
        raise HTTPException(400, "'content' must be a string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        # Python str can hold lone surrogates that JSON allows but
        # UTF-8 cannot encode; reject with a clear 400 instead of
        # letting the unhandled exception become a 500.
        raise HTTPException(400, f"content is not valid UTF-8: {exc}")
    if len(encoded) > MAX_FILE_BYTES:
        raise HTTPException(413, f"content exceeds {MAX_FILE_BYTES} bytes")
    return value


async def put_file(request: Request) -> JSONResponse:
    """Overwrite an existing file. Will not create a new file -- use
    POST for that, so accidental misspellings of an existing path
    don't silently create a stray file."""
    rel = request.path_params["rel"]
    path = _resolve_content_path(rel)
    if not path.exists():
        raise HTTPException(404, f"no such file: {rel} (use POST to create)")
    if path.is_symlink():
        raise HTTPException(400, "symlinks are not editable")
    if not path.is_file():
        raise HTTPException(400, "path is not a regular file")

    data = await _read_json_body(request)
    content = _validate_content(
        data.get("content"),
        missing_message="missing 'content' field (use POST to create new files with default content)",
    )

    # Atomic write: write to a sibling tempfile in the same dir then
    # replace, so a crash mid-write doesn't truncate the existing
    # file. ``Path.replace`` is atomic on the same filesystem.
    #
    # Use a per-call unique temp filename via tempfile.mkstemp so two
    # concurrent saves of the same path don't clobber each other's
    # ``.partial`` file. mkstemp creates the file atomically so there
    # is no TOCTOU window either.
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".partial",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(content)
        tmp_path.replace(path)
    except OSError as exc:
        # Best-effort cleanup; if even the unlink fails we log so the
        # operator at least sees the orphan temp file rather than
        # discovering it later by accident.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError as cleanup_exc:
            logger.warning(
                "failed to write %s and could not remove temp %s: %s",
                path, tmp_path, cleanup_exc,
            )
        raise HTTPException(500, f"failed to write: {exc}")
    return JSONResponse({"path": rel, "bytes": len(content.encode("utf-8"))})


async def post_file(request: Request) -> JSONResponse:
    """Create a new file. Will not overwrite an existing file -- use
    PUT for that. Creates intermediate directories as needed (still
    confined to CONTENT_DIR by ``_resolve_content_path``)."""
    rel = request.path_params["rel"]
    path = _resolve_content_path(rel)
    if path.exists():
        raise HTTPException(409, f"already exists: {rel}")

    data = await _read_json_body(request)
    content = _validate_content(data.get("content", ""))

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # ``open(..., 'x')`` is exclusive: fails if the file appeared
        # between our exists() check and now (TOCTOU).
        with path.open("x", encoding="utf-8") as f:
            f.write(content)
    except FileExistsError:
        raise HTTPException(409, f"already exists: {rel}")
    except OSError as exc:
        raise HTTPException(500, f"failed to create: {exc}")
    return JSONResponse({"path": rel, "bytes": len(content.encode("utf-8"))}, status_code=201)


async def delete_file(request: Request) -> Response:
    rel = request.path_params["rel"]
    path = _resolve_content_path(rel)
    if not path.exists():
        raise HTTPException(404, f"no such file: {rel}")
    if path.is_symlink() or not path.is_file():
        raise HTTPException(400, "only regular files can be deleted")
    try:
        path.unlink()
    except OSError as exc:
        raise HTTPException(500, f"failed to delete: {exc}")
    return Response(status_code=204)


# ----------------------------------------------------------------- error handler

async def http_exception_handler(request: Request, exc: HTTPException) -> Response:
    """Return JSON for /api/* errors, plain text for everything else."""
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
    return PlainTextResponse(str(exc.detail) + "\n", status_code=exc.status_code)


# ----------------------------------------------------------------- app

# The path converter handles the multi-segment relative paths the
# editor uses (e.g. ``api/files/notes/2026.gmi``). Starlette's default
# ``str`` converter rejects slashes; ``path`` accepts them.
routes = [
    Route("/", landing),
    Route("/healthz", healthz),
    Route("/edit", edit_page),
    Route("/api/files", list_files),
    Route("/api/files/{rel:path}", get_file, methods=["GET"]),
    Route("/api/files/{rel:path}", put_file, methods=["PUT"]),
    Route("/api/files/{rel:path}", post_file, methods=["POST"]),
    Route("/api/files/{rel:path}", delete_file, methods=["DELETE"]),
]

app: Starlette = Starlette(
    debug=False,
    routes=routes,
    exception_handlers={HTTPException: http_exception_handler},
)

# Mount static assets under /static (loaded by editor.html).
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

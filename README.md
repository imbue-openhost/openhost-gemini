# openhost-gemini

A [Gemini protocol](https://geminiprotocol.net/) capsule, packaged
as an OpenHost app. Built around [agate](https://github.com/mbrubeck/agate),
with a built-in WYSIWYG editor for the capsule's gemtext pages.

## What you get

- A public Gemini capsule reachable at `gemini://<app-name>.<zone-domain>/`
  (conventionally `gemini://gemini.<zone>/`).
- A public HTTPS landing page at `https://<app-name>.<zone-domain>/`
  that explains what a Gemini capsule is and how to install a Gemini
  client. Reachable without an OpenHost session so visitors who
  follow a link to the HTTPS URL learn what to do.
- A WYSIWYG gemtext editor at `https://<app-name>.<zone-domain>/edit`
  for managing the capsule's pages from the browser. Behind the
  OpenHost session, so only the compute-space owner can use it.
- Persistent content under `$OPENHOST_APP_DATA_DIR/content/` that
  you edit via the editor or the file-browser app.
- A self-signed TLS certificate, auto-generated on first boot and
  reused across restarts.

## Deploying

```
oh app deploy https://github.com/imbue-openhost/openhost-gemini --wait
```

The capsule is immediately reachable after the container starts on
`gemini://gemini.<your-zone-domain>/`. Gemini clients will prompt
you to trust the self-signed certificate (Trust On First Use); that
is normal and standard for Gemini.

Sign in to your OpenHost compute space, then visit
`https://<app-name>.<zone-domain>/edit` to start editing pages.

## Port layout

- `1965/tcp`, published on the host by OpenHost — the Gemini
  protocol itself. Raw TLS-wrapped TCP; does not go through the
  OpenHost HTTP router.
- `8080/tcp` (container-internal) — HTTP sidecar (landing,
  health-check, editor), reached via the OpenHost router at
  `https://<app-name>.<zone>/`.

The Gemini port is published directly by OpenHost so any Gemini
client on the public internet can reach the capsule (the normal
model for a Gemini capsule). The HTTP side is gated behind the
OpenHost session.

## Editor

The editor at `/edit` is a contenteditable WYSIWYG host that maps
gemtext line shapes one-to-one to DOM blocks:

| Gemtext   | Editor block    |
|-----------|-----------------|
| `# Heading` | Heading 1     |
| `## Heading` | Heading 2    |
| `### Heading` | Heading 3   |
| `* item` | List item        |
| `> quote` | Quote           |
| `=> URL label` | Link        |
| ` ``` ` | Preformatted     |
| anything else | Paragraph   |

Use the toolbar to change a block's shape. The "View source" button
shows the current gemtext that will be saved. Save commits the file
to disk; agate re-reads it on the next request, so changes are live
without a restart.

The file API the editor uses is also addressable directly:

- `GET /api/files` — list all `.gmi` files in the content dir.
- `GET /api/files/<path>` — read one file (JSON, `{path, content}`).
- `PUT /api/files/<path>` — overwrite an existing file.
- `POST /api/files/<path>` — create a new file.
- `DELETE /api/files/<path>` — remove a file.

All file API endpoints other than `DELETE` (which returns `204 No
Content` on success) produce JSON. All endpoints are confined to the
content dir (path traversal and symlinks rejected), and all require
an OpenHost session.

## Customising

### Custom hostname

The Gemini hostname defaults to `<app-name>.<zone-domain>`. Override
by setting `GEMINI_HOSTNAME` in the container environment, which
agate uses for both its `--hostname` check and the common name on
the auto-generated cert.

### Bringing your own certificate

If you want a real (non-self-signed) cert — e.g. from Let's
Encrypt via DNS-01 — drop the files as
`$OPENHOST_APP_DATA_DIR/certs/<hostname>/cert.pem` and
`$OPENHOST_APP_DATA_DIR/certs/<hostname>/key.pem` (ECDSA P-256 or
RSA, PEM-encoded), then restart the container. Agate skips its
auto-generation step when it finds existing files.

### Replacing the default content

The bundled `default_content/index.gmi`, `about.gmi`, and
`editing.gmi` are copied into the persistent content dir only if
the dir is empty. Edit or replace them freely (in the editor or on
disk); your edits survive container rebuilds.

## Files

- `openhost.toml` — OpenHost manifest.
- `Dockerfile` — Debian slim + agate (sha256-pinned upstream
  release) + Python 3 + Starlette + Uvicorn for the sidecar.
- `start.sh` — bridge entrypoint. Resolves the hostname, seeds the
  content dir on first boot, and supervises agate + the HTTP
  sidecar.
- `sidecar/server.py` — Starlette app: landing page, health check,
  editor, file API.
- `sidecar/templates/editor.html` — editor shell.
- `sidecar/static/editor.js`, `editor.css` — editor JS (gemtext
  parser, serializer, contenteditable host) and styling.
- `default_content/` — baseline gemtext pages seeded into the
  persistent volume on first boot.

## Security

- The Gemini port (1965) is publicly reachable with no OpenHost auth
  gate -- this is the normal access model for a Gemini capsule. Do
  not put anything sensitive in the content dir.
- The HTTPS landing page at `/` and the health endpoint `/healthz`
  are listed in `public_paths`, so anyone who follows the HTTPS URL
  sees the "this is a Gemini capsule, here's how to install a
  client" page. The landing page does not link to or hint at the
  editor, and it does not reveal the agate process status.
- The editor at `/edit` and the file API under `/api/files/...`
  stay behind the OpenHost session, so only the compute-space owner
  can use them. Unauthenticated visitors get OpenHost's standard
  sign-in redirect.
- The file API rejects path traversal, absolute paths, symlinks, and
  any extension other than `.gmi`. Bodies are capped at 1 MiB.
- The container runs agate as the in-container root user; under the
  OpenHost rootless-podman runtime this maps to an unprivileged host
  uid, so it is not a privilege escalation. No extra Linux
  capabilities are requested.

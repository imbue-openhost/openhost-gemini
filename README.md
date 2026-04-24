# openhost-gemini

A [Gemini protocol](https://geminiprotocol.net/) capsule, packaged
as an OpenHost app. Built around [agate](https://github.com/mbrubeck/agate).

## What you get

- A public Gemini capsule reachable at `gemini://<app-name>.<zone-domain>/`
  (conventionally `gemini://gemini.<zone>/`).
- A small HTTP landing page at `https://<app-name>.<zone-domain>/`
  for visitors who hit it over the web, explaining how to point a
  Gemini client at the capsule.
- Persistent content under `$OPENHOST_APP_DATA_DIR/content/` that
  you edit via the file-browser app (or `oh app exec`).
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

## Port layout

- `1965/tcp`, published on the host by OpenHost — the Gemini
  protocol itself. Raw TLS-wrapped TCP; does not go through the
  OpenHost HTTP router.
- `8080/tcp` (container-internal) — HTTP status sidecar, reached
  via the OpenHost router at `https://<app-name>.<zone>/`.

Because the Gemini port is published directly by OpenHost, the
OpenHost session-cookie gate does not apply to it. The capsule is
reachable by any Gemini client on the public internet. That is the
normal model for a Gemini capsule; if you want access control, use
agate's client-certificate authentication.

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
the dir is empty. Edit or replace them freely; your edits survive
container rebuilds.

## Files

- `openhost.toml` — OpenHost manifest.
- `Dockerfile` — Debian slim + agate from the upstream GitHub
  release (sha256-pinned).
- `start.sh` — bridge entrypoint. Resolves the hostname, seeds the
  content dir on first boot, and supervises agate + the HTTP
  status sidecar.
- `status_server.py` — tiny Python HTTP server that answers
  `/healthz` and `/` on the manifest's `port` (8080).
- `default_content/` — baseline gemtext pages seeded into the
  persistent volume on first boot.

## Security

- The Gemini port is publicly reachable with no OpenHost auth gate.
  Do not put anything sensitive in the content dir.
- The HTTP landing page at `/` is in `public_paths`, so it is
  reachable without a signed-in OpenHost session. Only a static
  page describing how to browse the capsule is served there.
- The container runs agate as an unprivileged `agate` system user;
  no extra Linux capabilities are requested.

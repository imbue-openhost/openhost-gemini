# Agate Gemini server for OpenHost.
#
# Agate is a single-binary Rust implementation of the Gemini protocol
# (gemini://, RFC "Gemini Protocol v0.16.1"). We download the prebuilt
# upstream release binary rather than building from source because the
# binary is small (~3 MiB), the release has been signed by upstream
# (see the sha256 pin below), and there is no need to drag a full Rust
# toolchain through the layer.
#
# Base image: Debian 12 slim. We need a modern glibc (agate is linked
# against glibc 2.35+), openssl for cert generation, python3 for the
# tiny status/landing sidecar, curl+ca-certs for downloading the
# agate release, and tini so SIGTERM from `docker stop` reaches both
# children via our start.sh supervisor.
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

# Pin to a specific agate release + sha256 so rebuilds are reproducible
# and a compromised upstream release tarball would fail the verify step
# rather than silently landing in the image. Bump both values together
# when updating; the checksum is printed in the release notes of each
# GitHub release.
ARG AGATE_VERSION=3.3.22
ARG AGATE_SHA256=18773fa82b70160e77a64c788647c8e252f06e9bc2cd3f1cacea2e159206b0ef

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl openssl python3 tini \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    url="https://github.com/mbrubeck/agate/releases/download/v${AGATE_VERSION}/agate.x86_64-unknown-linux-gnu.gz"; \
    curl -fsSL "$url" -o /tmp/agate.gz; \
    echo "${AGATE_SHA256}  /tmp/agate.gz" | sha256sum -c -; \
    gunzip /tmp/agate.gz; \
    mv /tmp/agate /usr/local/bin/agate; \
    chmod 755 /usr/local/bin/agate; \
    /usr/local/bin/agate --version

# Bundled assets: the entrypoint and the HTTP status sidecar. The
# default gemtext index gets copied into $OPENHOST_APP_DATA_DIR/content/
# on first boot only, so an operator editing index.gmi inside the
# persistent volume won't have their edits overwritten by a later image
# update.
COPY start.sh /usr/local/bin/start.sh
COPY status_server.py /usr/local/bin/status_server.py
COPY default_content/ /usr/local/share/openhost-gemini/default_content/
RUN chmod +x /usr/local/bin/start.sh /usr/local/bin/status_server.py

# Create an unprivileged user for agate to drop to. Agate itself does
# not daemonise or drop privileges, so running as root would be
# unnecessary exposure. Rootless podman remaps uids anyway; this stays
# correct under both runtimes.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin agate

# :8080 is the HTTP landing/health port (reached via the OpenHost
# router). :1965 is the Gemini port (published directly on the host by
# OpenHost via the [[ports]] entry in openhost.toml). We document both
# via EXPOSE so `docker inspect` reflects intent.
EXPOSE 8080 1965

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]

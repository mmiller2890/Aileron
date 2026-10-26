#!/usr/bin/env bash
# Build Aileron's Fedora .rpm in a Fedora container (rootless Podman, or
# Docker). Run from the repository root on any x86_64 Linux machine:
#
#   scripts/build-fedora-rpm.sh            # Fedora 44
#   FEDORA_VERSION=45 scripts/build-fedora-rpm.sh
#
# The package lands in dist-fedora/. The container keeps its own Rust target
# and node_modules, so it never mixes with a native build of the same tree.
set -euo pipefail

fedora_version="${FEDORA_VERSION:-44}"
engine="${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}"
image="aileron-fedora-build:${fedora_version}"
root="$(cd "$(dirname "$0")/.." && pwd)"

"$engine" build --build-arg "FEDORA_VERSION=${fedora_version}" \
  -t "$image" -f "$root/scripts/fedora/Containerfile" "$root/scripts/fedora"

# Named volumes keep the container's dependencies between builds.
"$engine" run --rm \
  -v "$root:/src" \
  -v "aileron-fedora-${fedora_version}-target:/target" \
  -v "aileron-fedora-${fedora_version}-node:/src/node_modules" \
  -v "aileron-fedora-cargo-registry:/opt/cargo/registry" \
  -e CARGO_TARGET_DIR=/target \
  "$image" bash -c '
    set -euo pipefail
    npm ci --no-audit --no-fund
    npx tauri build --bundles rpm
    mkdir -p dist-fedora
    cp /target/release/bundle/rpm/*.rpm dist-fedora/
    ls -l dist-fedora
  '

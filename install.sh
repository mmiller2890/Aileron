#!/bin/bash
# Install or update Aileron from the latest GitHub Release. Needs no build
# tools and no password:
#
#   curl -fsSL https://github.com/mmiller2890/Aileron/releases/latest/download/install.sh | bash
#
# Published with each release by scripts/release-macos.sh. To build from source
# instead, use scripts/install-macos.sh.
#
# Everything is inside main so a download cut off mid-way runs nothing.

main() {
  set -euo pipefail

  local base="${AILERON_RELEASE_URL:-https://github.com/mmiller2890/Aileron/releases/latest/download}"
  local archive=Aileron-macos-arm64.zip

  die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

  [ "$(uname -s)" = Darwin ] || die "This installer is for macOS."
  [ "$(uname -m)" = arm64 ] || die "Aileron needs an Apple Silicon Mac."
  local macos_major
  macos_major=$(sw_vers -productVersion | cut -d. -f1)
  [ "$macos_major" -ge 14 ] || die "Aileron needs macOS 14 (Sonoma) or newer; this Mac has $(sw_vers -productVersion)."

  # Not local: the exit trap runs after main has returned.
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading Aileron…"
  curl -fSL --progress-bar "$base/$archive" -o "$tmp/$archive" \
    || die "Couldn't download Aileron. Check your connection and try again."
  curl -fsSL "$base/$archive.sha256" -o "$tmp/$archive.sha256" \
    || die "Couldn't download Aileron's checksum. Check your connection and try again."
  (cd "$tmp" && shasum -a 256 -c "$archive.sha256" >/dev/null 2>&1) \
    || die "The download is damaged (checksum mismatch). Nothing was installed; try again."

  ditto -x -k "$tmp/$archive" "$tmp/unpacked"
  codesign --verify --strict "$tmp/unpacked/Aileron.app" 2>/dev/null \
    || die "The downloaded app's signature is invalid. Nothing was installed."

  local dest
  if [ -n "${AILERON_INSTALL_DIR:-}" ]; then dest=$AILERON_INSTALL_DIR
  elif [ -w /Applications ]; then dest=/Applications
  else dest="$HOME/Applications"; fi
  mkdir -p "$dest"

  if pgrep -xq Aileron; then
    echo "Closing Aileron to update it…"
    osascript -e 'quit app "Aileron"' >/dev/null 2>&1 || true
    local waited=0
    while pgrep -xq Aileron; do
      [ "$waited" -lt 15 ] || die "Aileron didn't close. Quit it (⌘Q), then run this again."
      sleep 1
      waited=$((waited + 1))
    done
  fi

  # Unpack beside the destination first, so a failure leaves the old app in place.
  rm -rf "$dest/Aileron.app.new"
  ditto "$tmp/unpacked/Aileron.app" "$dest/Aileron.app.new"
  rm -rf "$dest/Aileron.app"
  mv "$dest/Aileron.app.new" "$dest/Aileron.app"

  echo "✓ Installed $dest/Aileron.app"
  if [ -z "${AILERON_NO_OPEN:-}" ]; then
    if open "$dest/Aileron.app" 2>/dev/null; then
      echo "Aileron is starting. Press ⌘⇧D to open the dashboard and connect an AI provider."
    else
      echo "Open Aileron from $dest. Press ⌘⇧D to open the dashboard and connect an AI provider."
    fi
  fi
}

main "$@"

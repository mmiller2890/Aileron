#!/bin/bash
# Build Aileron from this checkout and install it, fetching whatever build
# tools the Mac is missing first. Safe to re-run: tools already present are
# left alone, and a re-run rebuilds and replaces the installed app.
#
#   ./scripts/install-macos.sh
#
# What it may install, all without sudo:
#   - Apple's Command Line Tools (Swift 6, git, clang), via Apple's own
#     installer dialog. Full Xcode isn't needed.
#   - Rust, via rustup into ~/.cargo (rustup adds it to your shell profile)
#   - Node.js, via Homebrew when you have it, otherwise the official
#     nodejs.org build into ~/.local/share/aileron/node (checksum verified;
#     your shell profile is not changed)
# Then it builds Aileron.app and copies it to /Applications (or
# ~/Applications when /Applications isn't writable; AILERON_INSTALL_DIR
# overrides the destination).

set -euo pipefail

cd "$(dirname "$0")/.."

NODE_MAJOR=22
NODE_HOME="$HOME/.local/share/aileron/node"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
else
  bold=; green=; yellow=; red=; reset=
fi
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
note() { printf '  %s!%s %s\n' "$yellow" "$reset" "$1"; }
die() { printf '\n%s✗ %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

# --- This Mac -----------------------------------------------------------------
step "Checking this Mac"
[ "$(uname -s)" = Darwin ] || die "This installer is for macOS. On Fedora use scripts/build-fedora-rpm.sh."
macos_major=$(sw_vers -productVersion | cut -d. -f1)
[ "$macos_major" -ge 14 ] || die "Aileron needs macOS 14 (Sonoma) or newer; this Mac has $(sw_vers -productVersion)."
ok "macOS $(sw_vers -productVersion)"
[ "$(uname -m)" = arm64 ] || die "Aileron needs an Apple Silicon Mac."
ok "Apple Silicon"

# --- Swift 6 (Command Line Tools or Xcode) ------------------------------------
# The speech engine compiles a Swift 6 package during the build. Apple's
# Command Line Tools are enough; full Xcode isn't needed.
swift_major() { "$@" --version 2>/dev/null | sed -nE 's/.*Swift version ([0-9]+).*/\1/p' | head -1; }

step "Checking Swift 6"
if ! xcode-select -p >/dev/null 2>&1; then
  note "Apple's Command Line Tools aren't installed. A macOS dialog will open: click Install and wait for it to finish (about 1 GB)."
  xcode-select --install >/dev/null 2>&1 || true
  printf '  Waiting for the Command Line Tools (if you closed the dialog, press Ctrl-C and run this again)'
  until xcode-select -p >/dev/null 2>&1 && [ -x "$(xcode-select -p)/usr/bin/swift" ]; do
    printf '.'; sleep 10
  done
  printf '\n'
fi

clt=/Library/Developer/CommandLineTools
found=$(swift --version 2>/dev/null | sed -nE 's/.*(Swift version [0-9.]+).*/\1/p' | head -1)
if [ "$(swift_major swift)" -ge 6 ] 2>/dev/null; then
  ok "$found"
elif [ -x "$clt/usr/bin/swift" ] && [ "$(swift_major "$clt/usr/bin/swift")" -ge 6 ] 2>/dev/null; then
  # The selected Xcode is too old but the Command Line Tools are new enough:
  # build with them without changing the system-wide selection.
  export DEVELOPER_DIR="$clt"
  ok "Swift $(swift_major "$clt/usr/bin/swift") from the Command Line Tools (your selected Xcode is older)"
else
  die "Swift 6 is needed but this Mac has ${found:-no usable Swift}. Update the Command Line Tools in System Settings → General → Software Update (or install Xcode 16+), then run this again."
fi

# One Rust dependency (cidre) runs xcodebuild, which only full Xcode has.
# Without Xcode, a small stand-in builds the same libraries with clang.
if ! xcodebuild -version >/dev/null 2>&1; then
  export PATH="$PWD/scripts/macos:$PATH"
  ok "Building without Xcode (Command Line Tools only)"
fi

# --- Rust ---------------------------------------------------------------------
step "Checking Rust"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v cargo >/dev/null 2>&1; then
  note "Installing Rust with rustup (into ~/.cargo)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  . "$HOME/.cargo/env"
fi
# src-tauri/rust-toolchain.toml pins the channel; rustup fetches it on first use.
ok "$(cd src-tauri && cargo --version)"

# --- Node.js ------------------------------------------------------------------
# package.json "engines": ^20.19.0 || ^22.12.0 || >=24.0.0
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit((a === 20 && b >= 19) || (a === 22 && b >= 12) || a >= 24 ? 0 : 1);
  '
}

install_node_tarball() {
  local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  local tmp; tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    || die "Couldn't reach nodejs.org. Check your connection and run this again."
  local file; file=$(grep -oE "node-v[0-9.]+-darwin-arm64\.tar\.gz" "$tmp/SHASUMS256.txt" | head -1)
  [ -n "$file" ] || die "Couldn't find a Node.js $NODE_MAJOR download for darwin-arm64."
  note "Downloading $file from nodejs.org…"
  curl -fSL --progress-bar "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
    || die "The Node.js download failed its checksum; not installing it."
  rm -rf "$NODE_HOME"; mkdir -p "$NODE_HOME"
  tar -xzf "$tmp/$file" -C "$NODE_HOME" --strip-components 1
  rm -rf "$tmp"
}

step "Checking Node.js"
[ -x "$NODE_HOME/bin/node" ] && export PATH="$NODE_HOME/bin:$PATH"
if ! node_ok; then
  if command -v brew >/dev/null 2>&1; then
    note "Installing Node.js $NODE_MAJOR with Homebrew…"
    brew install "node@$NODE_MAJOR"
    export PATH="$(brew --prefix "node@$NODE_MAJOR")/bin:$PATH"
  else
    install_node_tarball
    export PATH="$NODE_HOME/bin:$PATH"
  fi
  node_ok || die "Node.js was installed but $(node --version 2>/dev/null || echo 'no node') still isn't usable."
fi
ok "Node.js $(node --version)"

# --- Build --------------------------------------------------------------------
step "Installing JavaScript packages"
npm ci --no-audit --no-fund

step "Building Aileron (the first build takes several minutes)"
npm run tauri -- build --bundles app

app="src-tauri/target/release/bundle/macos/Aileron.app"
[ -d "$app" ] || die "The build finished but $app is missing."

# --- Install ------------------------------------------------------------------
step "Installing Aileron.app"
if [ -n "${AILERON_INSTALL_DIR:-}" ]; then dest=$AILERON_INSTALL_DIR
elif [ -w /Applications ]; then dest=/Applications
else dest="$HOME/Applications"; fi
mkdir -p "$dest"
# Only the copy being replaced: another Aileron (a dev build, a copy
# elsewhere) is left running.
aileron_running() { pgrep -qf "^$dest/Aileron.app/Contents/MacOS/"; }
if aileron_running; then
  note "Closing Aileron to replace it…"
  osascript -e 'quit app "Aileron"' >/dev/null 2>&1 || true
  waited=0
  while aileron_running; do
    [ "$waited" -lt 15 ] || die "Aileron didn't close. Quit it (⌘Q), then run this again."
    sleep 1
    waited=$((waited + 1))
  done
fi
# Copy beside the destination first, so a failure leaves the old app in place.
rm -rf "$dest/Aileron.app.new"
ditto "$app" "$dest/Aileron.app.new"
rm -rf "$dest/Aileron.app"
mv "$dest/Aileron.app.new" "$dest/Aileron.app"
ok "Installed $dest/Aileron.app"

cat <<EOF

${green}${bold}Done.${reset} Open Aileron from $dest (or: open "$dest/Aileron.app").

  • First launch: open the dashboard with ⌘⇧D and connect an AI provider.
  • macOS will ask for microphone / screen & system audio access the first
    time you listen. Each rebuild is a new app to macOS, so it asks again.
  • To update later: git pull, then run ./scripts/install-macos.sh again.
EOF

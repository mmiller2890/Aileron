#!/bin/bash
# Build the committed code in a clean checkout, sign it with your certificate
# and publish it as a GitHub Release that install.sh downloads.
#
#   ./scripts/release-macos.sh             build and publish
#   ./scripts/release-macos.sh --dry-run   build and check, publish nothing
#
# Uncommitted changes never reach a release. The version comes from
# src-tauri/tauri.conf.json, so bump it before each release.
#
# Signing with one stable certificate is what keeps macOS permissions across
# updates; an ad-hoc signature looks like a new app every time, so people are
# asked again after each update. Name the certificate "Aileron Signing", or set
# AILERON_SIGNING_IDENTITY. Without one the release is signed ad-hoc.

set -euo pipefail

identity="${AILERON_SIGNING_IDENTITY:-Aileron Signing}"
archive=Aileron-macos-arm64.zip

dry_run=false
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

cd "$(dirname "$0")/.."
repo=$PWD

[ "$(uname -m)" = arm64 ] || die "Releases are built on Apple Silicon."
# Captured first: under pipefail, grep -q closing the pipe early could make a
# present certificate look missing.
identities=$(security find-identity -v -p codesigning)
if grep -qF "\"$identity\"" <<<"$identities"; then
  signed=true
  export APPLE_SIGNING_IDENTITY="$identity"
else
  signed=false
  echo "! No certificate named \"$identity\": signing ad-hoc, so macOS re-asks permissions after each update."
fi

# Read from the commit, not the working tree: only committed code is released.
commit=$(git rev-parse HEAD)
version=$(git show "$commit:src-tauri/tauri.conf.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
tag="v$version"
git cat-file -e "$commit:install.sh" 2>/dev/null \
  || die "install.sh isn't committed. Commit it, then run this again."

if ! $dry_run; then
  command -v gh >/dev/null 2>&1 || die "Publishing needs the GitHub CLI (gh)."
  git fetch --quiet origin
  [ -n "$(git branch -r --contains "$commit")" ] \
    || die "$(git rev-parse --short HEAD) isn't pushed yet. Push it, then run this again."
  if gh release view "$tag" >/dev/null 2>&1; then
    die "Release $tag already exists. Bump the version in package.json and src-tauri/tauri.conf.json first."
  fi
fi

work=$(mktemp -d)
checkout="$work/checkout"
cleanup() {
  git -C "$repo" worktree remove --force "$checkout" 2>/dev/null || true
  rm -rf "$work"
  git -C "$repo" worktree prune
}
trap cleanup EXIT

echo "==> Building $tag from $(git rev-parse --short HEAD) in a clean checkout"
git worktree add --quiet --detach "$checkout" "$commit"
(
  cd "$checkout"
  npm ci --no-audit --no-fund
  npm run tauri -- build --bundles app
)

app="$checkout/src-tauri/target/release/bundle/macos/Aileron.app"
[ -d "$app" ] || die "The build finished but Aileron.app is missing."

echo "==> Checking the app"
built=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString)
[ "$built" = "$version" ] || die "Built app says version $built, expected $version."
codesign --verify --strict "$app" || die "Aileron.app's signature doesn't verify."
requirement=$(codesign -d -r- "$app" 2>&1)
if $signed && ! grep -q 'certificate leaf' <<<"$requirement"; then
  die "Aileron.app isn't tied to a certificate, so macOS would re-ask permissions after every update:
$requirement"
fi

mkdir "$work/out"
ditto -c -k --keepParent "$app" "$work/out/$archive"
(cd "$work/out" && shasum -a 256 "$archive" > "$archive.sha256")
cp "$checkout/install.sh" "$work/out/install.sh"

if $dry_run; then
  mkdir -p dist-release
  cp "$work/out/"* dist-release/
  echo "==> Dry run: nothing published. Files are in dist-release/"
  exit 0
fi

echo "==> Publishing $tag"
gh release create "$tag" \
  "$work/out/$archive" "$work/out/$archive.sha256" "$work/out/install.sh" \
  --target "$commit" --title "Aileron $version" --latest \
  --notes "Install or update on an Apple Silicon Mac (macOS 14+):

\`\`\`bash
curl -fsSL https://github.com/mmiller2890/Aileron/releases/latest/download/install.sh | bash
\`\`\`"
echo "==> Published $tag"

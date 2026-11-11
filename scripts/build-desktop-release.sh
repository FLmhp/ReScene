#!/usr/bin/env bash
# Build the Linux (deb + AppImage) or macOS (universal dmg) desktop installers.
# Set RELEASE_API_URL / RELEASE_WEB_URL only for a non-production build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

case "$(uname -s)" in
  Linux)
    target=x86_64-unknown-linux-gnu
    bundles=deb,appimage
    ;;
  Darwin)
    target=universal-apple-darwin
    bundles=dmg
    ;;
  *)
    echo "scripts/build-desktop-release.sh only builds Linux and macOS installers; on Windows run scripts/build-windows-release.ps1." >&2
    exit 1
    ;;
esac

node scripts/check-versions.mjs
pnpm install --frozen-lockfile

VITE_API_URL="${RELEASE_API_URL:-https://api.rescene.xyz}" \
VITE_WEB_URL="${RELEASE_WEB_URL:-https://app.rescene.xyz}" \
  pnpm --filter @rescene/desktop tauri build --target "$target" --bundles "$bundles"

#!/usr/bin/env bash
# Builds the macOS distributable (unsigned .zip per arch).
#
# Usage:  yarn make:macos                  # both arm64 + x64
#         yarn make:macos -- --arch arm64  # single arch (args pass to forge)
#
# - Run on a macOS host for a distributable you can sign/notarize afterwards
#   (see README). From any host (incl. Linux) this cross-packages an unsigned
#   zip via Electron Packager's downloaded darwin binaries — good for testing.
# - If the `zip` CLI is missing (e.g. plain Linux CI), a 7z-backed shim is
#   created on the fly so `cross-zip` (used by MakerZIP) still works.
#   NOTE: on a real Mac, real `zip` is used; the shim exists only for hosts
#   without it and preserves the zip layout, though exotic symlink-heavy
#   trees should be validated there.
set -euo pipefail

cd "$(dirname "$0")/.."

# ─── zip shim (only when `zip` is absent and 7z is available) ────────────────
if ! command -v zip >/dev/null 2>&1; then
  if ! command -v 7z >/dev/null 2>&1; then
    echo "Neither 'zip' nor '7z' is installed — cannot create the macOS zip." >&2
    echo "Install zip (apt install zip / dnf install zip / pacman -S zip)." >&2
    exit 1
  fi
  SHIM_BIN="build/tools/bin"
  mkdir -p "$SHIM_BIN"
  cat > "$SHIM_BIN/zip" <<'EOF'
#!/bin/sh
# Minimal `zip` shim backed by 7z, covering cross-zip's arg pattern:
#   zip -r -y <archive-path> <input...>
while [ $# -gt 0 ]; do
  case "$1" in
    -*) shift ;;
    *) break ;;
  esac
done
archive="$1"; shift
# 7z cannot update an empty placeholder file; remove it first.
[ -f "$archive" ] && [ ! -s "$archive" ] && rm -f "$archive"
exec 7z a -tzip -y "$archive" "$@"
EOF
  chmod +x "$SHIM_BIN/zip"
  export PATH="$PWD/$SHIM_BIN:$PATH"
  echo "==> Using a 7z-backed 'zip' shim at $SHIM_BIN/zip (real zip not installed)."
fi

exec npx electron-forge make --targets zip --platform darwin "$@"

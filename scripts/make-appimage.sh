#!/usr/bin/env bash
# Builds a self-contained Linux AppImage from the packaged app.
#
# Usage:  yarn make:appimage            # packages for the host arch
#         APPIMAGE_ARCH=arm64 yarn make:appimage
#
# Requirements:
#   - `appimagetool` on PATH (system package, or auto-downloaded from the
#     AppImageKit releases and cached in build/tools/ when missing).
#   - The app is packaged with `electron-forge package` first (done here).
#
# Output: out/make/appimage/Electron-Xplorer-<arch>.AppImage
set -euo pipefail

cd "$(dirname "$0")/.."

# ─── Architecture mapping (forge ↔ AppImageKit names) ────────────────────────
FORGE_ARCH="${APPIMAGE_ARCH:-}"
APPIMAGE_ARCH="${APPIMAGE_ARCH:-}"
if [ -z "$FORGE_ARCH" ]; then
  case "$(uname -m)" in
    x86_64)  FORGE_ARCH=x64;     APPIMAGE_ARCH=x86_64 ;;
    aarch64) FORGE_ARCH=arm64;   APPIMAGE_ARCH=aarch64 ;;
    *) echo "Unsupported host arch: $(uname -m). Set APPIMAGE_ARCH=x64|arm64." >&2; exit 1 ;;
  esac
else
  case "$FORGE_ARCH" in
    x64)   APPIMAGE_ARCH=x86_64 ;;
    arm64) APPIMAGE_ARCH=aarch64 ;;
    *) echo "Unsupported APPIMAGE_ARCH: $FORGE_ARCH (use x64|arm64)." >&2; exit 1 ;;
  esac
fi

# forge names the output dir after the productName ("Electron Xplorer"); the
# binary inside is named after `executableName` ("electron-xplorer").
APP_NAME="Electron Xplorer"
EXEC_NAME="electron-xplorer"
PKG_DIR="out/${APP_NAME}-linux-${FORGE_ARCH}"
APPDIR="out/appimage/AppDir"
OUT="out/make/appimage/${EXEC_NAME}-${APPIMAGE_ARCH}.AppImage"

# ─── 1. Package the app ──────────────────────────────────────────────────────
if [ ! -d "$PKG_DIR" ]; then
  echo "==> Packaging (electron-forge package --platform linux --arch $FORGE_ARCH)…"
  npx electron-forge package --platform linux --arch "$FORGE_ARCH"
fi
if [ ! -x "$PKG_DIR/$EXEC_NAME" ]; then
  echo "Packaged app not found at $PKG_DIR" >&2
  exit 1
fi

# ─── 2. Locate or fetch appimagetool ─────────────────────────────────────────
find_or_fetch_appimagetool() {
  if command -v appimagetool >/dev/null 2>&1; then
    echo "appimagetool"
    return
  fi
  local cached="build/tools/appimagetool-${APPIMAGE_ARCH}.AppImage"
  if [ ! -f "$cached" ]; then
    mkdir -p build/tools
    echo "==> Downloading appimagetool (cached in $cached)…"
    curl -fL --retry 3 -o "$cached" \
      "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${APPIMAGE_ARCH}.AppImage"
    chmod +x "$cached"
  fi
  echo "$cached"
}
APPIMAGETOOL="$(find_or_fetch_appimagetool)"

# If appimagetool is itself an AppImage it needs FUSE; use extract-and-run so
# it also works in FUSE-less environments (containers, headless CI).
if [ -f "$APPIMAGETOOL" ]; then
  APPIMAGETOOL="$APPIMAGETOOL --appimage-extract-and-run"
fi

# ─── 3. Assemble the AppDir ──────────────────────────────────────────────────
echo "==> Assembling AppDir…"
rm -rf "$APPDIR" out/make/appimage
mkdir -p "$APPDIR/usr/bin/app" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/512x512/apps"

cp -r "$PKG_DIR/." "$APPDIR/usr/bin/app/"

# Top-level icon + hicolor entry (appimagetool requires the top-level one).
cp build/icons/512x512.png "$APPDIR/${EXEC_NAME}.png"
cp build/icons/512x512.png \
   "$APPDIR/usr/share/icons/hicolor/512x512/apps/${EXEC_NAME}.png"

cat > "$APPDIR/${EXEC_NAME}.desktop" <<EOF
[Desktop Entry]
Name=${APP_NAME}
Comment=Tabbed file explorer with previews and OS drag-and-drop
Exec=${EXEC_NAME}
TryExec=${EXEC_NAME}
Icon=${EXEC_NAME}
Type=Application
Categories=Utility;System;
StartupWMClass=${EXEC_NAME}
X-AppImage-Version=$(node -p "require('./package.json').version")
EOF
cp "$APPDIR/${EXEC_NAME}.desktop" "$APPDIR/usr/share/applications/"

cat > "$APPDIR/AppRun" <<EOF
#!/usr/bin/env bash
HERE="\$(dirname "\$(readlink -f "\${0}")")"
exec "\${HERE}/usr/bin/app/${EXEC_NAME}" "\$@"
EOF
chmod +x "$APPDIR/AppRun"

# ─── 4. Build the AppImage ───────────────────────────────────────────────────
echo "==> Building AppImage…"
mkdir -p out/make/appimage
$APPIMAGETOOL "$APPDIR" "$OUT"

echo "==> Done: $OUT"

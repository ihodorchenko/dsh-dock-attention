#!/usr/bin/env bash
# Build the universal DSH Attention beacon app from src/helper/main.swift.
#
# The built bundle lives at bin/DSH Attention.app and is committed, so plugin
# users never need Xcode. Run this script only after changing the helper source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/bin/DSH Attention.app"
EXECUTABLE="$APP/Contents/MacOS/dsh-attention"
CACHE="$ROOT/.build/modulecache"
OUT="$ROOT/.build"

command -v xcrun >/dev/null 2>&1 || { echo "error: Xcode command line tools are required" >&2; exit 1; }
# `xcrun` wraps the toolchain and sets up the SDK environment; calling the
# toolchain binary directly cannot always locate the platform standard library.
SWIFTC=(xcrun swiftc)

mkdir -p "$OUT" "$CACHE" "$OUT/tmp" "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Keep compiler scratch files inside the checkout: the build also works under
# sandboxes that forbid writing to the system temp directories.
export TMPDIR="$OUT/tmp"

"${SWIFTC[@]}" -O -module-cache-path "$CACHE" -target arm64-apple-macosx12.0 \
    -o "$OUT/dsh-attention-arm64" "$ROOT/src/helper/main.swift"

if "${SWIFTC[@]}" -O -module-cache-path "$CACHE" -target x86_64-apple-macosx12.0 \
    -o "$OUT/dsh-attention-x86_64" "$ROOT/src/helper/main.swift" 2>/dev/null; then
    lipo -create -output "$EXECUTABLE" "$OUT/dsh-attention-arm64" "$OUT/dsh-attention-x86_64"
else
    echo "warning: x86_64 slice unavailable, shipping arm64 only" >&2
    cp "$OUT/dsh-attention-arm64" "$EXECUTABLE"
fi

chmod +x "$EXECUTABLE"
cp "$ROOT/src/helper/Info.plist" "$APP/Contents/Info.plist"

# Icon assets are committed; regenerate them only when Pillow is available.
if [ ! -f "$APP/Contents/Resources/AppIcon.icns" ] && command -v python3 >/dev/null 2>&1; then
    python3 "$ROOT/tools/render-icon.py" >/dev/null 2>&1 || true
fi

# Ad-hoc signature: keeps LaunchServices and Gatekeeper quiet for a locally
# installed, unnotarized helper. It carries no developer identity.
if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
fi

echo "built $APP"
file "$EXECUTABLE" | sed 's/^/  /'

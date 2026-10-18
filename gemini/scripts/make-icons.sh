#!/usr/bin/env bash
# Builds the GeminiCode app icon from gemini/branding (see gemini/branding/README.md):
#   resources/darwin/Assets.car   the layered macOS 26 icon (Default, Dark, Clear and Tinted
#                                 appearances), compiled from GeminiCode.icon with Xcode's actool.
#                                 gemini-release.yml copies it into the app and sets CFBundleIconName.
#   resources/darwin/code.icns    the classic icon, rendered per size from icon-macos.svg, for
#                                 CFBundleIconFile, the .dmg window and anything that reads .icns.
#   src/vs/workbench/browser/media/code-icon.svg   the workbench's copy of icon.svg.
# Needs macOS 26 with Xcode 26 (actool, swift). Run from the repository root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
BRANDING="$ROOT/gemini/branding"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "Compiling $BRANDING/GeminiCode.icon"
mkdir -p "$OUT/car"
actool --compile "$OUT/car" --platform macosx --minimum-deployment-target 26.0 \
	--app-icon GeminiCode --output-partial-info-plist "$OUT/partial.plist" \
	--output-format human-readable-text --errors --warnings "$BRANDING/GeminiCode.icon" > "$OUT/actool.log" 2>&1 \
	|| { cat "$OUT/actool.log"; exit 1; }
grep -q "CFBundleIconName" "$OUT/partial.plist" || { echo "actool did not produce CFBundleIconName" >&2; cat "$OUT/actool.log"; exit 1; }
cp "$OUT/car/Assets.car" "$ROOT/resources/darwin/Assets.car"

echo "Rendering $BRANDING/icon-macos.svg"
SET="$OUT/code.iconset"
mkdir -p "$SET"
for size in 16 32 128 256 512; do
	swift "$ROOT/gemini/scripts/render-svg.swift" "$BRANDING/icon-macos.svg" "$SET/icon_${size}x${size}.png" "$size"
	swift "$ROOT/gemini/scripts/render-svg.swift" "$BRANDING/icon-macos.svg" "$SET/icon_${size}x${size}@2x.png" "$((size * 2))"
done
iconutil -c icns "$SET" -o "$ROOT/resources/darwin/code.icns"

cp "$BRANDING/icon.svg" "$ROOT/src/vs/workbench/browser/media/code-icon.svg"

# Previews of every macOS appearance, for review in a pull request (Icon Composer's own renderer).
ICTOOL="$(dirname "$(xcode-select -p)")/Applications/Icon Composer.app/Contents/Executables/ictool"
if [[ -x "$ICTOOL" ]]; then
	echo "Rendering previews to $BRANDING/preview"
	mkdir -p "$BRANDING/preview"
	for rendition in Default Dark TintedLight TintedDark ClearLight ClearDark; do
		"$ICTOOL" "$BRANDING/GeminiCode.icon" --export-image --output-file "$BRANDING/preview/$rendition.png" \
			--platform macOS --rendition "$rendition" --width 256 --height 256 --scale 1 > /dev/null
	done
else
	echo "Icon Composer's ictool not found; previews not rendered" >&2
fi
echo "Wrote resources/darwin/Assets.car, resources/darwin/code.icns, src/vs/workbench/browser/media/code-icon.svg and $BRANDING/preview/"

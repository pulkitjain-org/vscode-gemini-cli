#!/bin/bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) pulkitjain-org and contributors. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Helpers for taking the site's screenshots and clips on a Mac, in the demo setup-demo.sh made.
#
#   bash shots.sh tools            # start the demo Jira, GitLab and SonarQube (keep it running)
#   bash shots.sh launch-dev       # start the dev build of this checkout on the demo workspace and profile
#   bash shots.sh launch-app       # the same with an installed /Applications/GeminiCode.app
#   bash shots.sh size             # make the GeminiCode window exactly 1440 x 900 points
#   bash shots.sh theme dark|light # switch macOS, and so GeminiCode, to dark or light
#   bash shots.sh shot <name> [s]  # wait s seconds (5) to switch to GeminiCode, then save the window
#   bash shots.sh pair <name> [s]  # the same in dark and then light: <name>-dark.png and <name>-light.png
#   bash shots.sh record <name> <s> # record the window for s seconds to <name>.mov, in the current theme
#   bash shots.sh export           # every shot as the site's 2000 x 1250 .webp, every clip as .mp4 and a poster
#
# Files go to $DEMO_ROOT/shots (DEMO_ROOT defaults to /Users/Shared/geminicode-shots). The first
# size, theme, shot or record asks to let Terminal control System Events and record the screen;
# allow both in System Settings > Privacy & Security (Accessibility, and Screen & System Audio
# Recording). export needs cwebp and ffmpeg: brew install webp ffmpeg.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$KIT/../../.." && pwd)"
ROOT="${DEMO_ROOT:-/Users/Shared/geminicode-shots}"
OUT="$ROOT/shots"
mkdir -p "$OUT"

set_theme() {
	local dark=false
	if [ "$1" = dark ]; then dark=true; fi
	osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $dark"
	sleep 1
}

# The GeminiCode window's position and size in points, as screencapture -R wants them: x,y,w,h
bounds() {
	osascript \
		-e 'tell application "System Events"' \
		-e 'set p to first process whose name contains "GeminiCode"' \
		-e 'set {x, y} to position of front window of p' \
		-e 'set {w, h} to size of front window of p' \
		-e 'return (x as string) & "," & (y as string) & "," & (w as string) & "," & (h as string)' \
		-e 'end tell'
}

case "${1:-}" in
tools)
	exec node "$KIT/demo-tools.mts" "$ROOT"
	;;
launch-dev)
	cd "$REPO"
	./scripts/code.sh --user-data-dir "$ROOT/profile" "$ROOT/acme.code-workspace" >/dev/null 2>&1 &
	echo "Started. Wait for the window, then run: bash \"$KIT/shots.sh\" size"
	;;
launch-app)
	open -na /Applications/GeminiCode.app --args --user-data-dir "$ROOT/profile" "$ROOT/acme.code-workspace"
	echo "Started. Wait for the window, then run: bash \"$KIT/shots.sh\" size"
	;;
size)
	# Just under the menu bar, 1440 x 900 points (2880 x 1800 pixels on a Retina screen).
	osascript \
		-e 'tell application "System Events"' \
		-e 'set p to first process whose name contains "GeminiCode"' \
		-e 'set frontmost of p to true' \
		-e 'set position of front window of p to {0, 0}' \
		-e 'set size of front window of p to {1440, 900}' \
		-e 'return (name of p) & " " & ((size of front window of p) as string)' \
		-e 'end tell'
	;;
theme)
	case "${2:-}" in
	dark|light) set_theme "$2" ;;
	*) echo "usage: shots.sh theme dark|light" >&2; exit 1 ;;
	esac
	;;
shot)
	# Waits so you can switch to GeminiCode (Cmd-Tab) and open a menu, then saves the
	# window's area of the screen. GeminiCode stays in front, so open menus and
	# pop-ups stay open. The camera sound means it is done.
	name="${2:?usage: shots.sh shot <name> [seconds]}"
	wait="${3:-5}"
	rect=$(bounds)
	echo "Switch to GeminiCode now; shooting in $wait seconds."
	sleep "$wait"
	screencapture -R"$rect" "$OUT/$name.png"
	echo "Saved $OUT/$name.png"
	;;
pair)
	# The same in dark and then light, without touching the window in between.
	name="${2:?usage: shots.sh pair <name> [seconds]}"
	wait="${3:-5}"
	rect=$(bounds)
	set_theme dark
	echo "Switch to GeminiCode now; shooting in $wait seconds."
	sleep "$wait"
	screencapture -R"$rect" "$OUT/$name-dark.png"
	set_theme light
	sleep 1
	screencapture -R"$rect" "$OUT/$name-light.png"
	set_theme dark
	echo "Saved $OUT/$name-dark.png and $OUT/$name-light.png"
	;;
record)
	# Records the window's area; name it <clip>-dark or <clip>-light to match the theme.
	name="${2:?usage: shots.sh record <name> <seconds>}"
	seconds="${3:?usage: shots.sh record <name> <seconds>}"
	rect=$(bounds)
	echo "Recording $seconds seconds in 3 seconds. Switch to GeminiCode now."
	sleep 3
	screencapture -v -V"$seconds" -R"$rect" "$OUT/$name.mov"
	echo "Saved $OUT/$name.mov"
	;;
export)
	# The site's sizes: 2000 x 1250 for shots and clips, and a 1000-wide copy of showcase-work.
	shopt -s nullglob
	for png in "$OUT"/*.png; do
		cwebp -quiet -q 82 -resize 2000 1250 "$png" -o "${png%.png}.webp"
		echo "${png%.png}.webp"
	done
	for mov in "$OUT"/*.mov; do
		base="${mov%.mov}"
		ffmpeg -loglevel error -y -i "$mov" -vf "scale=2000:1250:flags=lanczos,fps=30" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart -an "$base.mp4"
		ffmpeg -loglevel error -y -i "$base.mp4" -frames:v 1 -f image2 "$base-poster.png"
		cwebp -quiet -q 82 "$base-poster.png" -o "$base.webp"
		rm "$base-poster.png"
		echo "$base.mp4 and $base.webp"
	done
	;;
*)
	sed -n '7,22p' "$0"
	exit 1
	;;
esac

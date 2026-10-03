#!/usr/bin/env bash
# Sends a signed .zip, .dmg or .pkg to Apple's notary service and waits for the
# verdict. On a rejection it prints Apple's log, which names each file that
# failed, and exits non-zero. Used by .github/workflows/gemini-release.yml.
#
#   gemini/scripts/notarize.sh <file>
#
# Needs an App Store Connect API key: APPLE_API_KEY_PATH (the .p8 file),
# APPLE_API_KEY_ID and APPLE_API_ISSUER_ID.
set -euo pipefail

FILE="${1:?usage: notarize.sh <file>}"
AUTH=(--key "${APPLE_API_KEY_PATH:?}" --key-id "${APPLE_API_KEY_ID:?}" --issuer "${APPLE_API_ISSUER_ID:?}")

echo "Notarizing $(basename "$FILE")..."
RESULT="$(xcrun notarytool submit "$FILE" "${AUTH[@]}" --wait --timeout 2h --output-format json)"
echo "$RESULT"
ID="$(node -p 'JSON.parse(process.argv[1]).id ?? ""' "$RESULT")"
STATUS="$(node -p 'JSON.parse(process.argv[1]).status ?? ""' "$RESULT")"

if [[ "$STATUS" != "Accepted" ]]; then
	echo "::error::Notarization of $(basename "$FILE") ended with status '$STATUS'"
	if [[ -n "$ID" ]]; then
		xcrun notarytool log "$ID" "${AUTH[@]}" || true
	fi
	exit 1
fi

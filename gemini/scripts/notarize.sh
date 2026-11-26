#!/usr/bin/env bash
# Sends a signed .zip, .dmg or .pkg to Apple's notary service, waits for the
# verdict and staples the ticket. On a rejection it prints Apple's log, which
# names each file that failed, and exits non-zero. Used by
# .github/workflows/gemini-release.yml.
#
#   gemini/scripts/notarize.sh <file> [<what to staple>]
#
# The second argument is what the ticket is stapled to: the .app a .zip was
# made from, or the .dmg itself. Without it nothing is stapled.
#
# Needs an App Store Connect API key: APPLE_API_KEY_PATH (the .p8 file),
# APPLE_API_KEY_ID and APPLE_API_ISSUER_ID.
#
# Every step is a request to Apple, and each one fails now and then for a
# reason that is gone a minute later: a dropped connection, a 403 from the
# notary service, a ticket the stapler cannot fetch yet. The release build
# before this takes most of an hour, so each step is tried NOTARIZE_ATTEMPTS
# times (4), waiting NOTARIZE_RETRY_DELAY seconds (30) longer each time. The
# three steps are retried apart: a file Apple already has is never sent again
# because waiting for its verdict or stapling it failed. A rejection is Apple's
# answer and is never retried.
set -euo pipefail

FILE="${1:?usage: notarize.sh <file> [<what to staple>]}"
STAPLE="${2:-}"
AUTH=(--key "${APPLE_API_KEY_PATH:?}" --key-id "${APPLE_API_KEY_ID:?}" --issuer "${APPLE_API_ISSUER_ID:?}")
ATTEMPTS="${NOTARIZE_ATTEMPTS:-4}"
DELAY="${NOTARIZE_RETRY_DELAY:-30}"
NAME="$(basename "$FILE")"
ERRORS="$(mktemp)"
trap 'rm -f "$ERRORS"' EXIT

# One field of a JSON answer, or nothing when there is no answer to read.
field() {
	node -e 'try { process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]] ?? "")); } catch { }' "$1" "$2"
}

# Waits before another try; fails when the tries are used up.
again() {
	local attempt=$1 what=$2
	if ((attempt >= ATTEMPTS)); then
		return 1
	fi
	echo "::warning::$what failed (try $attempt of $ATTEMPTS); trying again in $((attempt * DELAY)) s"
	sleep $((attempt * DELAY))
}

# What to do about a failure that is not Apple's verdict on the file.
hint() {
	if grep -qi 'agreement' "$ERRORS"; then
		echo "::error::Apple refused the request over an agreement. If this repeats, the Account Holder has to accept the latest agreements at https://developer.apple.com/account and in App Store Connect (Business)."
	fi
}

echo "Notarizing $NAME..."
ID=""
for ((attempt = 1; ; attempt++)); do
	RESULT="$(xcrun notarytool submit "$FILE" "${AUTH[@]}" --output-format json 2>"$ERRORS")" || true
	cat "$ERRORS" >&2
	echo "$RESULT"
	ID="$(field "$RESULT" id)"
	if [[ -n "$ID" ]]; then
		break
	fi
	if ! again "$attempt" "Sending $NAME to Apple"; then
		hint
		echo "::error::Apple did not take $NAME after $ATTEMPTS tries"
		exit 1
	fi
done

STATUS=""
for ((attempt = 1; ; attempt++)); do
	# notarytool can exit non-zero for a rejection too; the status decides.
	RESULT="$(xcrun notarytool wait "$ID" "${AUTH[@]}" --timeout 2h --output-format json 2>"$ERRORS")" || true
	cat "$ERRORS" >&2
	echo "$RESULT"
	STATUS="$(field "$RESULT" status)"
	if [[ -n "$STATUS" && "$STATUS" != "In Progress" ]]; then
		break
	fi
	if ! again "$attempt" "Waiting for Apple's verdict on $NAME"; then
		hint
		echo "::error::No verdict on $NAME (submission $ID) after $ATTEMPTS tries"
		exit 1
	fi
done

if [[ "$STATUS" != "Accepted" ]]; then
	echo "::error::Notarization of $NAME ended with status '$STATUS'"
	xcrun notarytool log "$ID" "${AUTH[@]}" || true
	exit 1
fi

if [[ -n "$STAPLE" ]]; then
	for ((attempt = 1; ; attempt++)); do
		if xcrun stapler staple "$STAPLE"; then
			break
		fi
		if ! again "$attempt" "Stapling $(basename "$STAPLE")"; then
			echo "::error::Could not staple $(basename "$STAPLE") after $ATTEMPTS tries"
			exit 1
		fi
	done
fi

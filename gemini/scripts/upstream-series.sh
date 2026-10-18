#!/usr/bin/env bash
# The fork's edits to upstream files, as a patch series over the pinned
# upstream tag (gemini/upstream.json). Fork-only files (extensions/gemini,
# gemini, the Gemini workflows, and files the fork added under src, build and
# resources) are not patches: they apply to any base and are copied as they are.
#
#   gemini/scripts/upstream-series.sh regenerate         # rewrite gemini/patches from the working tree against the pinned tag
#   gemini/scripts/upstream-series.sh check              # fail if a patch no longer matches the working tree, or an edit has no marker (no tag needed)
#   gemini/scripts/upstream-series.sh markers            # only the marker check: every upstream code file the series edits names GEMINI-FORK
#   gemini/scripts/upstream-series.sh apply <tag>        # in a checkout of <tag>: apply the series and copy the fork's files from <from>
#   gemini/scripts/upstream-series.sh files              # list the upstream files the fork modifies
#
# `apply` takes the branch to copy fork-only files from in FROM (default: main).
# Patches carry binary data (`git diff --binary`), so icons are part of the
# series too; a binary that upstream also changed has to be redone by hand.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
patches=gemini/patches

# The pinned tag, read when a mode needs it (a checkout of a bare upstream tag has no gemini/ folder yet).
pin() { node -p "require('$(pwd)/gemini/upstream.json').tag"; }
fork_owned=(':(exclude)extensions/gemini' ':(exclude)gemini' ':(exclude).github/workflows/gemini-*.yml')

# Upstream files the fork modifies (M) and files it adds beside upstream's (A), against the pinned tag.
# The working tree is compared, not HEAD, so an edit shows up before it is committed (stage a new file first).
modified() { git diff --name-status "$1" -- . "${fork_owned[@]}" | awk '$1=="M"{print $2}'; }
added() { git diff --name-status "$1" -- . "${fork_owned[@]}" | awk '$1=="A"{print $2}'; }

need_tag() {
	if ! git rev-parse --verify --quiet "refs/tags/$1^{commit}" >/dev/null; then
		echo "Tag $1 is not here. Fetch it: git fetch upstream tag $1 (git remote add upstream https://github.com/microsoft/vscode.git first)." >&2
		exit 2
	fi
}

# Files that cannot carry a comment, or where one would ship to users as text (images, data, docs, packaging
# metadata), need no GEMINI-FORK marker; every other file the series edits must name it at least once.
no_marker='\.(json|svg|png|ico|icns|bmp|md|xml|ya?ml)$|/control\.template$|\.spec\.template$'

# The upstream files the series edits, read from the patches themselves, so this needs no tag object.
series_files() { sed -n 's|^diff --git a/\(.*\) b/.*|\1|p' "$patches"/*.patch | sort -u; }

# Prints each upstream code file the series edits without a GEMINI-FORK marker; fails if there is one.
check_markers() {
	local missing=0 file
	while read -r file; do
		if [[ "$file" =~ $no_marker ]]; then
			continue
		fi
		if ! grep -q 'GEMINI-FORK' "$file"; then
			echo "No GEMINI-FORK marker: $file. Mark the fork's edit with a comment that says why." >&2
			missing=1
		fi
	done < <(series_files)
	return $missing
}

patch_name() {
	# resources/win32/code.ico -> 0007-resources-win32-code.ico.patch
	printf '%04d-%s.patch' "$1" "$(echo "$2" | tr '/' '-')"
}

write_series() {
	local tag=$1 dir=$2 n=0
	rm -rf "$dir"
	mkdir -p "$dir"
	modified "$tag" | sort | while read -r file; do
		n=$((n + 1))
		# Full blob hashes, so the series reads the same on every machine; abbreviated ones vary with the repository.
		git diff --binary --full-index "$tag" -- "$file" > "$dir/$(patch_name "$n" "$file")"
	done
	added "$tag" | sort > "$dir/ADDED"
	echo "$tag" > "$dir/TAG"
}

case "${1:-}" in
	files)
		pin=$(pin)
		need_tag "$pin"
		echo "## Modified upstream files against $pin"
		modified "$pin"
		echo
		echo "## Files the fork adds beside upstream's"
		added "$pin"
		;;
	regenerate)
		pin=$(pin)
		need_tag "$pin"
		write_series "$pin" "$patches"
		echo "Wrote $(ls "$patches"/*.patch | wc -l | tr -d ' ') patches against $pin to $patches/, and $(wc -l < "$patches/ADDED" | tr -d ' ') added files in $patches/ADDED."
		;;
	check)
		pin=$(pin)
		# Every patch's result must be what HEAD has, so an upstream file changed
		# without regenerating the series fails here. This needs no tag object.
		status=0
		if [[ "$(cat "$patches/TAG" 2>/dev/null)" != "$pin" ]]; then
			echo "$patches/TAG says $(cat "$patches/TAG" 2>/dev/null || echo nothing) but gemini/upstream.json pins $pin. Run: gemini/scripts/upstream-series.sh regenerate" >&2
			status=1
		fi
		for p in "$patches"/*.patch; do
			if ! git apply --check -R "$p" >/dev/null 2>&1; then
				echo "Stale: $(basename "$p") no longer matches HEAD. Run: gemini/scripts/upstream-series.sh regenerate" >&2
				status=1
			fi
		done
		# A modified upstream file with no patch is also stale, when the tag is here to tell.
		if git rev-parse --verify --quiet "refs/tags/$pin^{commit}" >/dev/null; then
			tmp=$(mktemp -d)
			write_series "$pin" "$tmp/patches"
			if ! diff -rq "$tmp/patches" "$patches" >/dev/null; then
				echo "The series differs from a fresh one against $pin:" >&2
				diff -rq "$tmp/patches" "$patches" >&2 || true
				status=1
			fi
			rm -rf "$tmp"
		fi
		if ! check_markers; then
			status=1
		fi
		if [[ $status -eq 0 ]]; then
			echo "The patch series matches HEAD ($(ls "$patches"/*.patch | wc -l | tr -d ' ') patches against $pin)."
		fi
		exit $status
		;;
	markers)
		check_markers
		echo "Every upstream code file the series edits carries a GEMINI-FORK marker."
		;;
	apply)
		tag=${2:?the upstream tag to apply the series to}
		from=${FROM:-main}
		need_tag "$tag"
		if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$tag^{commit}")" ]]; then
			echo "Check out $tag first (git checkout -b upstream/$tag $tag), then run this." >&2
			exit 2
		fi
		# The fork's own folder first: the series and its scripts live there, and a bare tag has none of it.
		git checkout "$from" -- gemini extensions/gemini .github/workflows/gemini-*.yml
		failed=()
		for p in "$patches"/*.patch; do
			if ! git apply --3way --index "$p" 2>/dev/null; then
				failed+=("$(basename "$p")")
			fi
		done
		# Files the fork adds beside upstream's come over as they are.
		while read -r file; do
			[[ -n "$file" ]] && git checkout "$from" -- "$file"
		done < "$patches/ADDED"
		if [[ ${#failed[@]} -gt 0 ]]; then
			echo "Applied the series to $tag with ${#failed[@]} patches to resolve by hand (conflict markers are in the files):" >&2
			printf '  %s\n' "${failed[@]}" >&2
			exit 1
		fi
		echo "Applied the series to $tag cleanly."
		;;
	*)
		sed -n '2,15p' "$0"
		exit 2
		;;
esac

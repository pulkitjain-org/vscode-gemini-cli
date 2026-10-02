#!/usr/bin/env bash
# Lists every place the fork touches upstream VS Code files: the checklist for
# each upstream merge (see gemini/docs/PLAN.md, "Where our code lives").
#
#   gemini/scripts/list-fork-touches.sh [upstream-ref]
#
# Always prints the GEMINI-FORK markers. With an upstream ref (for example
# upstream/main or a release tag), it also prints every upstream file that
# differs from that ref, which catches files that cannot carry a marker,
# such as product.json and icons.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Fork-owned paths; anything here is ours and needs no marker.
fork_owned=(':(exclude)extensions/gemini' ':(exclude)gemini' ':(exclude).github/workflows/gemini-*.yml')

echo '## GEMINI-FORK markers'
git grep -n 'GEMINI-FORK' -- . "${fork_owned[@]}" || echo '(none)'

if [[ $# -gt 0 ]]; then
	base=$(git merge-base HEAD "$1")
	echo
	echo "## Upstream files changed since $1 (merge base ${base:0:12})"
	git diff --name-status "$base" HEAD -- . "${fork_owned[@]}"
fi

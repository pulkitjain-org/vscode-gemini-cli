#!/usr/bin/env bash
# Gemini CI's checks, run locally, for what a branch changes against its base
# (origin/main by default). The pre-push hook runs it, so a push that would
# fail these jobs stops here instead:
#
#   Checks           workflow files parse, lint and hygiene of the fork's files,
#                    the patch series, the extension's three type checks, both
#                    bundles, hygiene of the generated webview files, the unit
#                    tests (size budgets included), and the site's build and
#                    SEO check when gemini/site changed
#   Compile & hygiene  `npm run compile`, and hygiene of the changed files,
#                    only when a file outside extensions/gemini, gemini and the
#                    Gemini workflows changed, since those are the only files
#                    they add
#
# Left to CI: the real-CLI tests against three CLI releases, bundling the CLI,
# the site's accessibility and Lighthouse runs, and Snyk. Run the real-CLI
# tests yourself on a change to src/acp/cli, the agent's launch, sessions or
# the protocol (AGENTS.md, "Validating").
#
#   gemini/scripts/ci-checks.sh            # against origin/main
#   gemini/scripts/ci-checks.sh <base>     # against another base
#
# Quick by default, as the pre-push hook runs it: the workflow files, lint of
# the changed fork files, hygiene, the patch series and the type checks, under
# a minute for one extension change. GEMINI_FULL_CHECKS=1 adds what CI runs
# on top: both bundles, the unit tests, the site's build and SEO check, and
# the full compile when an upstream file changed. CI runs the full set on
# every push anyway, so the hook keeps the push fast and CI keeps it honest.
#
# It checks the working tree, so commit or stash other edits first for the
# result to be the pushed commits'. GEMINI_SKIP_CHECKS=1 skips it in the hook.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base_ref=${1:-origin/main}
base=$(git merge-base "$base_ref" HEAD)
changed=$(git diff --name-only "$base" HEAD)
full=${GEMINI_FULL_CHECKS:-0}

if [ -z "$changed" ]; then
	echo "ci-checks: nothing changed against $base_ref."
	exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	echo >&2 "ci-checks: the working tree has uncommitted changes, which these checks see but the push doesn't carry."
fi

step() {
	echo >&2
	echo >&2 "ci-checks: $1"
	shift
	if ! "$@"; then
		echo >&2 "ci-checks: failed: $*"
		exit 1
	fi
}

# grep without -q: with -q it quits on the first match, and on a long list (a
# branch rebased on a new upstream tag) printf then dies of SIGPIPE, which
# pipefail turns into "no match".
touches() {
	printf '%s\n' "$changed" | grep -E "$1" > /dev/null
}

step 'Workflow files parse' node -e '
	const yaml = require("js-yaml");
	for (const file of process.argv.slice(1)) {
		const flow = yaml.load(require("fs").readFileSync(file, "utf8"));
		if (!flow || !flow.on || !flow.jobs) { throw new Error(`${file} has no "on" or "jobs"`); }
	}
' .github/workflows/gemini-*.yml
if [ "$full" = 1 ]; then
	# shellcheck disable=SC2046
	step 'Lint fork files' npx eslint --max-warnings 0 extensions/gemini gemini/site build/hygiene.ts build/filters.ts build/npm/dirs.ts build/gulpfile.extensions.ts build/lib/extensions.ts $(grep '\.ts$' gemini/patches/ADDED)
else
	# Only the changed fork files: the rest passed on the base already.
	lintable=$(printf '%s\n' "$changed" | grep -E '^(extensions/gemini/|gemini/site/).*\.(ts|mts)$' | while read -r file; do [ -f "$file" ] && printf '%s\n' "$file"; done || true)
	if [ -n "$lintable" ]; then
		# A file ESLint's config ignores (test/fixtures/) is skipped, as CI's lint of whole folders skips it, rather than warned about.
		# shellcheck disable=SC2086
		step 'Lint changed fork files' npx eslint --max-warnings 0 --no-warn-ignored $lintable
	fi
fi
# shellcheck disable=SC2046
step 'Hygiene (fork files)' node build/hygiene.ts product.json .eslint-ignore build/lib/extensions.ts $(git ls-files extensions/gemini gemini .github/workflows/gemini-*.yml) $(cat gemini/patches/ADDED)
step 'Patch series matches HEAD' gemini/scripts/upstream-series.sh check

if touches '^extensions/gemini/'; then
	step 'Type check the extension, tests and webview' sh -c '
		npx tsc -p extensions/gemini/tsconfig.json --noEmit &&
		npm run --silent typecheck-tests --prefix extensions/gemini &&
		npx tsc -p extensions/gemini/webview-src/tsconfig.json --noEmit'
	if [ "$full" = 1 ]; then
		step 'Bundle extension and webview' sh -c 'node extensions/gemini/esbuild.mts && node extensions/gemini/esbuild.webview.mts'
		generated=$(git ls-files --others --ignored --exclude-standard extensions/gemini/media | grep -E '\.(css|js)$' || true)
		if [ -n "$generated" ]; then
			# shellcheck disable=SC2086
			step 'Hygiene (generated webview files)' node build/hygiene.ts product.json $generated
		fi
		step 'Unit tests' npm test --silent --prefix extensions/gemini
	fi
fi

if [ "$full" = 1 ] && touches '^gemini/site/'; then
	site=$(mktemp -d)
	trap 'rm -rf "$site"' EXIT
	step 'Build the download page (sample release)' node gemini/site/build.mts "$site" --sample
	step 'Search and link preview tags on the download page' node gemini/site/check-seo.mts "$site"
fi

# Compile & hygiene: the fork's own files are covered above; anything else is upstream code or the build.
if printf '%s\n' "$changed" | grep -vE '^(extensions/gemini/|gemini/|\.github/workflows/gemini-)' > /dev/null; then
	if [ "$full" = 1 ]; then
		step 'Compile' npm run compile
	fi
	# CI runs `npm run hygiene` on a clean checkout. Locally that globs ignored
	# files too (the bundled CLI in extensions/gemini/cli, build output), so check
	# the changed files instead: unchanged ones passed on the base already.
	upstream=$(printf '%s\n' "$changed" | grep -vE '^(extensions/gemini/|gemini/|\.github/workflows/gemini-)' | while read -r file; do [ -f "$file" ] && printf '%s\n' "$file"; done || true)
	if [ -n "$upstream" ]; then
		# shellcheck disable=SC2086
		step 'Hygiene' node build/hygiene.ts $upstream
	fi
fi

echo >&2
if [ "$full" = 1 ]; then
	echo >&2 "ci-checks: all passed."
else
	echo >&2 "ci-checks: the quick checks passed; CI runs the bundles, the unit tests and the compile on the push (GEMINI_FULL_CHECKS=1 runs them here)."
fi

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
#   Compile & hygiene  `npm run compile` and `npm run hygiene`, only when a file
#                    outside extensions/gemini, gemini and the Gemini workflows
#                    changed, since those are the only files they add
#
# Left to CI: the real-CLI tests against three CLI releases, bundling the CLI,
# the site's accessibility and Lighthouse runs, and Snyk. Run the real-CLI
# tests yourself on a change to src/acp/cli, the agent's launch, sessions or
# the protocol (AGENTS.md, "Validating").
#
#   gemini/scripts/ci-checks.sh            # against origin/main
#   gemini/scripts/ci-checks.sh <base>     # against another base
#
# It checks the working tree, so commit or stash other edits first for the
# result to be the pushed commits'. GEMINI_SKIP_CHECKS=1 skips it in the hook.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base_ref=${1:-origin/main}
base=$(git merge-base "$base_ref" HEAD)
changed=$(git diff --name-only "$base" HEAD)

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

touches() {
	printf '%s\n' "$changed" | grep -qE "$1"
}

step 'Workflow files parse' node -e '
	const yaml = require("js-yaml");
	for (const file of process.argv.slice(1)) {
		const flow = yaml.load(require("fs").readFileSync(file, "utf8"));
		if (!flow || !flow.on || !flow.jobs) { throw new Error(`${file} has no "on" or "jobs"`); }
	}
' .github/workflows/gemini-*.yml
# shellcheck disable=SC2046
step 'Lint fork files' npx eslint --max-warnings 0 extensions/gemini gemini/site build/hygiene.ts build/filters.ts build/npm/dirs.ts build/gulpfile.extensions.ts build/lib/extensions.ts $(grep '\.ts$' gemini/patches/ADDED)
# shellcheck disable=SC2046
step 'Hygiene (fork files)' node build/hygiene.ts product.json .eslint-ignore build/lib/extensions.ts $(git ls-files extensions/gemini gemini .github/workflows/gemini-*.yml) $(cat gemini/patches/ADDED)
step 'Patch series matches HEAD' gemini/scripts/upstream-series.sh check

if touches '^extensions/gemini/'; then
	step 'Type check the extension, tests and webview' sh -c '
		npx tsc -p extensions/gemini/tsconfig.json --noEmit &&
		npm run --silent typecheck-tests --prefix extensions/gemini &&
		npx tsc -p extensions/gemini/webview-src/tsconfig.json --noEmit'
	step 'Bundle extension and webview' sh -c 'node extensions/gemini/esbuild.mts && node extensions/gemini/esbuild.webview.mts'
	generated=$(git ls-files --others --ignored --exclude-standard extensions/gemini/media | grep -E '\.(css|js)$' || true)
	if [ -n "$generated" ]; then
		# shellcheck disable=SC2086
		step 'Hygiene (generated webview files)' node build/hygiene.ts product.json $generated
	fi
	step 'Unit tests' npm test --silent --prefix extensions/gemini
fi

if touches '^gemini/site/'; then
	site=$(mktemp -d)
	trap 'rm -rf "$site"' EXIT
	step 'Build the download page (sample release)' node gemini/site/build.mts "$site" --sample
	step 'Search and link preview tags on the download page' node gemini/site/check-seo.mts "$site"
fi

# Compile & hygiene: the fork's own files are covered above; anything else is upstream code or the build.
if printf '%s\n' "$changed" | grep -vqE '^(extensions/gemini/|gemini/|\.github/workflows/gemini-)'; then
	step 'Compile' npm run compile
	step 'Hygiene' npm run hygiene
fi

echo >&2
echo >&2 "ci-checks: all passed."

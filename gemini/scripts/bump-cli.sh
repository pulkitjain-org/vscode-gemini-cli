#!/usr/bin/env bash
# Pins the bundled Gemini CLI to a release, with its checksum from npm, and
# commits that: what the Gemini Upstream workflow runs for a new CLI, on an
# upstream move's branch or on a branch of its own.
#
#   gemini/scripts/bump-cli.sh <version>
#
# The checksum must match the tarball, as the release build will check, so the
# CLI is bundled once here (`pnpm run bundle-cli`) before the commit.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
version=${1:?the Gemini CLI version to pin, such as 0.71.1}
integrity=$(npm view "@google/gemini-cli@$version" dist.integrity)
if [ -z "$integrity" ]; then
	echo "npm has no integrity for @google/gemini-cli@$version" >&2
	exit 1
fi
CLI=$version INTEGRITY=$integrity node -e '
	const fs = require("fs");
	const file = "extensions/gemini/package.json";
	const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
	pkg.bundledCli = { version: process.env.CLI, integrity: process.env.INTEGRITY };
	fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
'
pnpm -C extensions/gemini install --frozen-lockfile --ignore-scripts
pnpm -C extensions/gemini run bundle-cli
git add extensions/gemini/package.json
git commit -q -m "Bump the bundled Gemini CLI to $version"

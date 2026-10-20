#!/bin/sh
# Installs GeminiCode's git hooks (commit-msg, pre-push) into this clone's hooks
# folder, which its worktrees share. Run once per clone.

set -e
here=$(cd "$(dirname "$0")" && pwd)
hooks=$(git config core.hooksPath || true)
[ -n "$hooks" ] || hooks="$(git rev-parse --git-common-dir)/hooks"
mkdir -p "$hooks"
for hook in commit-msg pre-push; do
	cp "$here/$hook" "$hooks/$hook"
	chmod +x "$hooks/$hook"
done
echo "Installed commit-msg and pre-push in $hooks."

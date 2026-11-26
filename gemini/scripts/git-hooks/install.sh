#!/bin/sh
# Installs GeminiCode's git hooks (commit-msg, pre-push) into this clone's hooks
# folder, which its worktrees share. Run once per clone. A hook already there
# that differs is kept beside it as <hook>.backup-<time>.

set -e
here=$(cd "$(dirname "$0")" && pwd)
hooks=$(git config core.hooksPath || true)
[ -n "$hooks" ] || hooks="$(git rev-parse --git-common-dir)/hooks"
mkdir -p "$hooks"
stamp=$(date +%Y%m%d-%H%M%S)
for hook in commit-msg pre-push; do
	if [ -f "$hooks/$hook" ] && ! cmp -s "$here/$hook" "$hooks/$hook"; then
		cp -p "$hooks/$hook" "$hooks/$hook.backup-$stamp"
		echo "Kept your $hook as $hooks/$hook.backup-$stamp."
	fi
	cp "$here/$hook" "$hooks/$hook"
	chmod +x "$hooks/$hook"
done
echo "Installed commit-msg and pre-push in $hooks."

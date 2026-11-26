#!/bin/sh
# The repository's commit and branch rules (AGENTS.md, "Commits, branches and
# pull requests"), in one place: the git hooks in git-hooks/, Gemini CI's
# policy job and a person checking by hand all run this script.
#
#   commit-policy.sh branch <name>                  the branch starts with task/, feature/ or bugfix/
#   commit-policy.sh commits <rev-list arguments>   every commit is the owner's and names no AI tool
#   commit-policy.sh message <file>                 a commit message names no AI tool
#   commit-policy.sh strip <file>                   removes a tool's trailers and footers from a message, in place
#   commit-policy.sh pull-request <base> <branch>   all of the above for a pull request's commits
#
# Each prints what breaks a rule and exits 1, or prints nothing and exits 0.

owner='er.pulkit@gmail.com'
# Matched, ignoring case, against each commit's author, committer and message.
attribution='claude|anthropic|copilot|codex|generated with'
# A tool's trailer or footer line, which `strip` removes before `message` checks what is left.
trailers='^[[:space:]]*(co-authored-by:.*(claude|anthropic|copilot|codex|openai)|claude-session:|.*generated (with|by) .*(claude|copilot|codex|chatgpt))'
branches='^(task|feature|bugfix)/.'

check_branch() {
	if ! printf '%s\n' "$1" | grep -qE "$branches"; then
		echo "Branch '$1' must start with task/, feature/ or bugfix/. Rename it: git branch -m feature/<what-it-is>"
		return 1
	fi
}

# A message as git will keep it: no comment lines, nothing below the scissors line of `git commit -v`.
message_text() {
	sed -e '/^# -* >8 -*$/,$d' -e '/^#/d' "$1"
}

# Removes a tool's trailers and footers from the message file, and the blank lines they leave at its end.
strip_message() {
	kept="$1.kept.$$"
	grep -viE "$trailers" "$1" > "$kept" || true
	sed -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}' "$kept" > "$1"
	rm -f "$kept"
}

check_message() {
	found=$(message_text "$1" | grep -iE "$attribution")
	if [ -n "$found" ]; then
		echo "The commit message names an AI tool or carries its trailer:"
		printf '  %s\n' "$found"
		echo "Write what changed and why, without naming the tool."
		return 1
	fi
}

check_commits() {
	bad=0
	for commit in $(git rev-list "$@"); do
		subject=$(git log -1 --format='%h %s' "$commit")
		for address in $(git log -1 --format='%ae %ce' "$commit"); do
			if [ "$address" != "$owner" ]; then
				echo "$subject: authored or committed as $address, not $owner. Fix it with git commit --amend --reset-author, or a rebase for older commits."
				bad=1
				break
			fi
		done
		if git log -1 --format='%an %ae %cn %ce%n%B' "$commit" | grep -qiE "$attribution"; then
			echo "$subject: names an AI tool or carries its trailer. Reword it."
			bad=1
		fi
	done
	return $bad
}

# The tag commit of the upstream release a branch moves to, when it moves the pin
# in gemini/upstream.json: upstream's own history up to that tag is not the
# fork's to check. Asks GitHub for the tag's commit without fetching upstream.
upstream_tag_commit() {
	base_tag=$(git show "$1:gemini/upstream.json" 2>/dev/null | sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p')
	head_tag=$(git show "HEAD:gemini/upstream.json" 2>/dev/null | sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p')
	if [ -z "$head_tag" ] || [ "$head_tag" = "$base_tag" ]; then
		return 0
	fi
	refs=$(git ls-remote https://github.com/microsoft/vscode.git "refs/tags/$head_tag" "refs/tags/$head_tag^{}")
	# An annotated tag lists its commit on the ^{} line.
	sha=$(printf '%s\n' "$refs" | awk '/\^\{\}$/ { print $1 }')
	[ -n "$sha" ] || sha=$(printf '%s\n' "$refs" | awk 'NR == 1 { print $1 }')
	if [ -n "$sha" ] && git cat-file -e "$sha^{commit}" 2>/dev/null; then
		echo "$sha"
	fi
}

check_pull_request() {
	base=$1
	failed=0
	check_branch "$2" || failed=1
	upstream=$(upstream_tag_commit "$base")
	if [ -n "$upstream" ]; then
		echo "Leaving out upstream's history up to $upstream (the tag in gemini/upstream.json)."
		check_commits "$base..HEAD" "^$upstream" || failed=1
	else
		check_commits "$base..HEAD" || failed=1
	fi
	return $failed
}

command=$1
[ $# -gt 0 ] && shift
case "$command" in
	branch) check_branch "$1" ;;
	message) check_message "$1" ;;
	strip) strip_message "$1" ;;
	commits) check_commits "$@" ;;
	pull-request) check_pull_request "$1" "$2" ;;
	upstream-tag) upstream_tag_commit "$1" ;;
	*)
		echo "Usage: $0 branch <name> | message <file> | strip <file> | commits <rev-list arguments> | pull-request <base> <branch> | upstream-tag <base>" >&2
		exit 2
		;;
esac

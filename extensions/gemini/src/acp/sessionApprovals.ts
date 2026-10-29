/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// "Allow for this session" for shell commands, kept by GeminiCode. gemini-cli
// 0.63 runs a taint check before each shell command: one that reuses a path
// or value from earlier tool output always asks again, and its "Allow for
// this session" is accepted but not saved. In an investigation almost every
// command does that, so the button seems to do nothing. GeminiCode remembers
// the command prefixes the user allowed (`git status`, `npm run lint`, `grep`)
// and answers repeats itself, while still asking for what the check is there
// for: anything that reaches the network, writes outside the folder, runs
// code it builds or is given, or can't be read.
//
// A prefix is the program and, for programs with subcommands, the subcommand:
// allowing `git status` never covers `git grep -O…` or `git push`. Rules come
// from the session ("Allow for this session") or from outside it
// (`permanent`, for an "Always allow" kept by the host); both ask again once
// the agent writes a file that changes what they run.

import * as path from 'node:path';

/** Programs that reach the network, which an approval never covers. */
const networkPrograms = new Set([
	'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat', 'http', 'https', 'xh',
	// Command lines for hosted services: every call reaches them, and their extensions run as subcommands.
	'gh', 'glab', 'gcloud', 'gsutil', 'aws', 'az',
]);

/**
 * Programs that run other programs or code given to them: approving one would
 * approve whatever it runs, so they always ask (but see `builtinPrefixes`).
 */
const wrapperPrograms = new Set([
	'xargs', 'env', 'sudo', 'doas', 'su', 'timeout', 'nice', 'nohup', 'time', 'command', 'builtin', 'exec', 'eval', 'source', '.',
	'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'python', 'python2', 'python3', 'node', 'deno', 'bun', 'perl',
	'ruby', 'php', 'lua', 'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'osascript', 'watch', 'parallel', 'script', 'unbuffer', 'stdbuf', 'chroot',
]);

/** Container tools: `docker inspect` prints a container's environment, where a team server's settings sit, so they always ask. */
const containerPrograms = new Set(['docker', 'podman', 'nerdctl', 'colima', 'lima', 'limactl']);

/**
 * Programs that run what a file in the workspace defines (a package.json
 * script, a Makefile target, a Gradle task). An approval of one lapses when
 * the agent writes such a file, as gemini-cli's own check asks again for a
 * build command after build files changed.
 */
const taskRunners = new Set([
	'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'make', 'gmake', 'gradle', 'gradlew', 'mvn', 'mvnw', 'cargo', 'go', 'rake', 'bundle', 'composer', 'dotnet',
	'just', 'task', 'tox', 'nox', 'poetry', 'pipenv', 'uv', 'pdm', 'sbt', 'mix', 'pytest', 'python', 'python3', 'swift', 'xcodebuild', 'ant',
]);

/** The files that define what a task runner runs, by name. */
const buildFile = /^(package\.json|(gnu)?makefile|.+\.mk|.+\.gradle(\.kts)?|gradle\.properties|gradle-wrapper\.(properties|jar)|gradlew(\.bat)?|mvnw(\.cmd)?|maven-wrapper\.properties|pom\.xml|cargo\.toml|build\.rs|go\.(mod|work)|rakefile|gemfile|composer\.json|.+\.(cs|fs|vb)proj|directory\.build\.(props|targets)|justfile|taskfile\.ya?ml|tox\.ini|noxfile\.py|pyproject\.toml|setup\.(py|cfg)|conftest\.py|pytest\.ini|pipfile|requirements.*\.txt|\.yarnrc(\.yml)?|\.pnpmfile\.c?js|pnpm-workspace\.yaml|bunfig\.toml|mix\.exs|build\.sbt|package\.swift|build\.xml|(vitest|vite|jest|babel|eslint|prettier|webpack|rollup|tsup|playwright|karma|cypress|next|nuxt|svelte|astro)\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|\.babelrc(\.[a-z]+)?|\.mocharc(\.[a-z]+)?)$/i;

/** Folders whose files decide what a task runner runs (installed packages, Cargo and Maven settings). */
const buildFolder = /(^|[\\/])(node_modules|\.cargo|\.mvn)[\\/]/i;

/** Whether `filePath` defines what a build or task runner runs. */
export function isBuildFile(filePath: string): boolean {
	return buildFile.test(path.basename(filePath)) || buildFolder.test(filePath);
}

/** The names git runs hooks by; a file with one of these names can be a hook wherever `core.hooksPath` points. */
const gitHookNames = new Set([
	'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
	'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
	'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist',
	'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
]);

/** Hook managers' files (Husky, pre-commit, lint-staged, lefthook, simple-git-hooks, commitlint), and what makes a folder a repository (a `.git` file, a bare repository's `config` and `HEAD`). */
const hookFile = /^(\.pre-commit-config\.ya?ml|\.pre-commit-hooks\.ya?ml|\.lintstagedrc(\..+)?|lint-staged\.config\.[cm]?[jt]s|\.huskyrc(\..+)?|\.?lefthook(-local)?\.(ya?ml|json|toml)|\.?simple-git-hooks\.(c?js|json)|\.commitlintrc(\..+)?|commitlint\.config\.[cm]?[jt]s|\.overcommit\.ya?ml|\.git|config|HEAD)$/;

/** Whether writing `filePath` changes what git runs: a hook, a hook manager's settings, or what makes a folder a repository. */
export function isGitHookFile(filePath: string): boolean {
	const base = path.basename(filePath);
	return gitHookNames.has(base) || hookFile.test(base) || /(^|[\\/])\.(husky|lefthook|githooks|git-hooks)[\\/]/.test(filePath) || /(^|[\\/])\.git([\\/]|$)/.test(filePath);
}

/**
 * GeminiCode's and the editor's own settings in a repository: the worktree setup script, the CLI's
 * project settings (hooks, MCP servers) and the folder's editor settings and tasks. Writing one decides
 * what runs next, outside any approval, so an agent's write to one always asks (adminPolicy.ts).
 * The ignore files are here too: what git ignores is what an agent may not read (fileAccess.ts),
 * so a write that un-ignores a secret would open it.
 */
const protectedSetting = /(^|[\\/])(\.gemini[\\/]([^\\/]+\.sh|settings\.json)|\.vscode[\\/](settings|tasks)\.json|\.gitignore|\.geminiignore|\.git[\\/]info[\\/]exclude)$/i;

/** Whether `filePath` is one of the settings an agent's write to always asks for. */
export function isProtectedSetting(filePath: string): boolean {
	return protectedSetting.test(filePath);
}

/** Whether `filePath` is one of git's ignore files, whose rules decide what an agent may read. */
export function isIgnoreFile(filePath: string): boolean {
	return /(^|[\\/])(\.gitignore|\.geminiignore|\.git[\\/]info[\\/]exclude)$/i.test(filePath);
}

/**
 * Whether writing `filePath` decides what runs next, outside any approval: a
 * build file (a task runner's scripts, which an approved `npm test` then runs),
 * a git hook or anything under `.git` (hooks, aliases, `core.fsmonitor`, which
 * the user's next commit runs), or a protected setting. In Auto Edit such a
 * write shows a card first (agentClient.ts).
 */
export function decidesWhatRuns(filePath: string): boolean {
	return isBuildFile(filePath) || isGitHookFile(filePath) || isProtectedSetting(filePath);
}

/** `decidesWhatRuns` for a path as a command names it, with a redirect's prefix and quotes removed. */
function changesWhatRuns(filePath: string): boolean {
	return decidesWhatRuns(filePath.replace(/^(of|--output)=/, '').replace(/['"]/g, ''));
}

/** Programs that write the files their arguments name. */
const fileWriters = new Set(['tee', 'cp', 'mv', 'ln', 'install', 'truncate', 'patch', 'dd']);

/**
 * Git commands that run no hook. An approval of any other lapses when the agent writes what a hook
 * may run (a build file, since hooks run the project's scripts), as well as when it writes a hook.
 */
const gitReadCommands = new Set([
	'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'remote', 'describe', 'shortlog', 'reflog',
	'cat-file', 'rev-list', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'symbolic-ref', 'config', 'var', 'version', 'help',
	'check-ignore', 'count-objects', 'whatchanged', 'range-diff', 'diff-tree', 'diff-index', 'diff-files',
]);

/** Git options before the command that take a value as the next word. */
const gitValueOptions = /^(-C|--work-tree|--namespace|--super-prefix|--list-cmds)$/;

/** The index of git's command word in `args` (after `-C <dir>` and the like), or -1. */
function gitCommandIndex(args: readonly string[]): number {
	let at = 0;
	while (at < args.length && args[at].startsWith('-')) {
		at += gitValueOptions.test(args[at]) ? 2 : 1;
	}
	return at < args.length ? at : -1;
}

/** Git commands that run a command they are given, or set one up for later commands to run. */
function gitRunsCode(args: readonly string[]): boolean {
	// `--git-dir` reads another repository's config, which the agent may have written (`core.fsmonitor`, `core.pager`).
	if (args.some(arg => arg === '-c' || /^--(config-env|exec-path|git-dir)/.test(arg))) {
		return true;
	}
	const at = gitCommandIndex(args);
	if (at < 0) {
		return false;
	}
	const command = args[at];
	const rest = args.slice(at + 1);
	// The remote side's program (fetch, pull, push, ls-remote, clone, archive): any command runs locally for a local remote.
	if (rest.some(arg => /^--(upload-pack|receive-pack|exec)(=|$)/.test(arg))) {
		return true;
	}
	switch (command) {
		case 'config': {
			// Reading is fine; writing can set an alias, a pager, a hook path or `core.sshCommand`.
			if (rest.some(arg => /^(--unset(-all)?|--add|--replace-all|--rename-section|--remove-section|-e|--edit|set|unset|rename-section|remove-section|edit)$/.test(arg))) {
				return true;
			}
			const reads = rest.some(arg => /^(--get(-all|-regexp|-urlmatch)?|--list|-l|get|list)$/.test(arg));
			// `git config <key>` reads; `git config <key> <value>` writes.
			return !reads && rest.filter(arg => !arg.startsWith('-')).length > 1;
		}
		case 'grep':
			// `-O<cmd>` opens the matching files with any command, also as part of grouped flags (`-nO…`).
			return rest.some(arg => /^-[a-zA-Z]*O/.test(arg) || arg.startsWith('--open-files-in-pager'));
		case 'clone':
			// `-u` is `--upload-pack`; a template folder or `--config` brings hooks and settings along.
			return rest.some(arg => /^-[a-zA-Z]*u/.test(arg) || /^--(template|config)(=|$)/.test(arg));
		case 'ls-remote':
			return rest.some(arg => /^-[a-zA-Z]*u/.test(arg));
		case 'init':
			return rest.some(arg => /^--template(=|$)/.test(arg));
		case 'diff': case 'log': case 'show': case 'format-patch':
			// `--output` writes a file of its choosing, `--no-index` reads outside the repository and `--ext-diff` runs a diff program.
			return rest.some(arg => /^--(output|no-index|ext-diff)(=|$)/.test(arg));
		case 'rebase':
			return rest.some(arg => arg === '-x' || arg.startsWith('--exec'));
		case 'submodule':
			return rest.includes('foreach');
		case 'bisect':
			return rest.includes('run');
		case 'difftool':
		case 'mergetool':
			return rest.some(arg => arg === '-x' || arg.startsWith('--extcmd') || arg.startsWith('--tool'));
		case 'filter-branch':
		case 'filter-repo':
		// Prints stored passwords, sends mail, or starts a server or a browser.
		case 'credential':
		case 'send-email':
		case 'instaweb':
		case 'daemon':
		case 'web--browse':
			return true;
		default:
			return command.startsWith('credential-');
	}
}

/** `NAME=value` prefixes that only change formatting; any other can make a program run code (`GIT_SSH_COMMAND`, `LD_PRELOAD`). */
const harmlessVariable = /^(LC_\w+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CI|TERM|COLUMNS|LINES)$/;

/** A sed script that runs a command (`e`, GNU `s///e`) or writes a file (`w`). */
const sedRunsOrWrites = /(^|[;{}\n])\s*([0-9]+|\$|\/[^/]*\/)?\s*[ewW](\s|$)|\/[gpIiMm0-9]*[ew]\b/;

/** The package managers' subcommands that run a package or a command they are given. */
const runSubcommands: Readonly<Record<string, ReadonlySet<string>>> = {
	npm: new Set(['exec', 'x', 'explore', 'init', 'create', 'innit']),
	pnpm: new Set(['exec', 'dlx', 'create']),
	yarn: new Set(['exec', 'dlx', 'node', 'create']),
	bundle: new Set(['exec']),
	poetry: new Set(['run']),
	uv: new Set(['run', 'tool']),
	pipenv: new Set(['run']),
	pdm: new Set(['run']),
	conda: new Set(['run']),
	dotnet: new Set(['exec', 'tool']),
	kubectl: new Set(['exec', 'attach', 'debug', 'run', 'cp']),
};

/** Subcommands that add a package from the network when given one by name (`npm install left-pad`); alone they install what the project lists. */
const installSubcommands: Readonly<Record<string, ReadonlySet<string>>> = {
	npm: new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'install-test', 'it']),
	pnpm: new Set(['install', 'i', 'add']),
	yarn: new Set(['add', 'global']),
	pip: new Set(['install', 'download']),
	pip3: new Set(['install', 'download']),
	poetry: new Set(['add']),
	pdm: new Set(['add']),
	cargo: new Set(['install', 'add']),
	go: new Set(['get', 'install']),
	gem: new Set(['install']),
	brew: new Set(['install', 'reinstall', 'tap']),
	composer: new Set(['require']),
	conda: new Set(['install']),
};

/** Options whose value is a local file to install from (`pip install -r requirements.txt`, `-e .`), not a package name. */
const localInstallOption = /^(-r|--requirement|-c|--constraint|-e|--editable)$/;

/** Arguments that make an otherwise plain program run code, by program. */
function runsCode(program: string, args: readonly string[]): boolean {
	switch (program) {
		case 'find':
			return args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(arg));
		case 'awk': case 'gawk': case 'mawk': case 'nawk':
			// `-f` reads the program from a file, `-i`/`-l` load a source file or a library (gawk), `-E` is gawk's `-f`.
			return args.some(arg => /^(-[a-zA-Z]*[fEil]|--(file|exec|include|load))/.test(arg) || /\bsystem\s*\(|\|\s*getline|print[^;]*\|/.test(arg));
		case 'git':
			return gitRunsCode(args);
		case 'rg':
			// `--pre` runs a command on every file searched.
			return args.some(arg => arg.startsWith('--pre') && !arg.startsWith('--pre-glob'));
		case 'tar': case 'gtar': case 'bsdtar':
			return args.some(arg => arg === '-I' || arg === '-F' || /^--(to-command|use-compress-program|checkpoint-action|rsh-command|info-script|new-volume-script)/.test(arg));
		case 'sort': case 'gsort':
			return args.some(arg => arg.startsWith('--compress-program'));
		case 'sed': case 'gsed':
			// `-f` reads the script from a file; `sed -i` on a build file changes what a task runner runs.
			return args.some(arg => /^(-[a-zA-Z]*f|--file)/.test(arg) || (!arg.startsWith('-') && sedRunsOrWrites.test(arg)))
				|| (args.some(arg => /^(-i|--in-place)/.test(arg)) && args.some(changesWhatRuns));
		case 'make': case 'gmake':
			// Another makefile, code to evaluate, or a variable that names the shell or a program.
			return args.some(arg => /^(-[a-zA-Z]*[fE]|--(file|makefile|eval))/.test(arg)
				|| /^(SHELL|MAKESHELL|\.SHELLFLAGS|MAKEFLAGS|MAKEFILES)=/.test(arg)
				|| /^[A-Za-z_][\w.]*=.*[/$`\s]/.test(arg));
		case 'go':
			// A program to run the tests or the build's tools with, or a module fetched at a version.
			return args.some(arg => /^-(exec|toolexec)(=|$)/.test(arg)) || (args[0] === 'env' && args.some(arg => /^-[wu]$/.test(arg)));
		case 'npm': case 'pnpm': case 'yarn':
			// npm's own settings name the shell scripts run in.
			return args.some(arg => /^--(script-shell|node-options|userconfig|globalconfig|prefix)(=|$)/.test(arg))
				|| args[0] === 'set' || (args[0] === 'config' && /^(set|delete|edit|rm|del)$/.test(args[1] ?? ''));
		default:
			return fileWriters.has(program) && args.some(changesWhatRuns);
	}
}

/**
 * Command prefixes that one "Allow for this session" may cover although
 * their program would otherwise always ask (a wrapper, a script in the
 * folder): read-only git, listing and reading, and the test and check commands
 * an agent runs over and over. Each still asks again once the agent writes a
 * file that changes what it runs.
 */
export const builtinPrefixes: readonly (readonly string[])[] = [
	['git', 'status'], ['git', 'diff'], ['git', 'log'], ['git', 'show'],
	['ls'], ['cat'],
	['npm', 'test'], ['npx', 'vitest'], ['npx', 'tsc', '--noEmit'], ['npx', 'eslint'],
	['pytest'], ['python', '-m', 'pytest'], ['python3', '-m', 'pytest'],
	['./gradlew', 'test'], ['go', 'test'], ['cargo', 'test'],
];

/** Programs whose first word says what they do (`git status`, `npm test`, `make lint`): an approval covers that subcommand only. */
const subcommandPrograms = new Set([
	'git', 'npm', 'pnpm', 'yarn', 'kubectl', 'helm', 'cargo', 'go', 'gradle', 'gradlew', 'mvn', 'mvnw', 'dotnet', 'pip', 'pip3', 'poetry', 'uv',
	'pipenv', 'pdm', 'conda', 'brew', 'terraform', 'rustup', 'swift', 'flutter', 'dart', 'composer', 'bundle', 'gem', 'rake', 'make', 'gmake',
	'just', 'task', 'mix', 'sbt', 'hg', 'svn', 'jj', 'nx', 'turbo', 'lerna', 'systemctl', 'launchctl', 'defaults', 'security',
]);

/** Subcommands whose next word says what runs too (`npm run lint`, `go mod tidy`), by program. */
const twoWordSubcommands: Readonly<Record<string, ReadonlySet<string>>> = {
	npm: new Set(['run', 'run-script', 'rum', 'urn']),
	pnpm: new Set(['run']),
	yarn: new Set(['run']),
	kubectl: new Set(['config', 'rollout', 'auth', 'set', 'create']),
	helm: new Set(['repo', 'plugin']),
	go: new Set(['mod', 'work', 'tool', 'env']),
	terraform: new Set(['state', 'workspace']),
	dotnet: new Set(['new', 'nuget']),
};

/**
 * The prefix an approval of `words` (a program and its arguments) covers:
 * the program, and for programs with subcommands the subcommand and, where
 * it matters, the word after it. With options before the subcommand
 * (`kubectl -n ns get`) it runs to the first word that follows a plain word,
 * so it is never shorter than the subcommand, only longer.
 */
function prefixOf(words: readonly string[]): readonly string[] {
	const program = words[0];
	const name = path.basename(program);
	if (!subcommandPrograms.has(name)) {
		return [program];
	}
	const args = words.slice(1);
	if (name === 'git') {
		const at = gitCommandIndex(args);
		return at < 0 ? words : [program, ...args.slice(0, at + 1)];
	}
	if (name === 'yarn' && /^workspaces?$/.test(args[0] ?? '')) {
		// `yarn workspace <name> <script>`: the whole command, since what runs comes last.
		return words;
	}
	if (!args.length || !args[0].startsWith('-')) {
		const sub = args[0];
		const next = args[1];
		return sub && next && !next.startsWith('-') && twoWordSubcommands[name]?.has(sub) ? [program, sub, next] : sub ? [program, sub] : [program];
	}
	const end = args.findIndex((arg, i) => i > 0 && !arg.startsWith('-') && !args[i - 1].startsWith('-'));
	return end < 0 ? words : [program, ...args.slice(0, end + 1)];
}

/** The first word of `args` that is not an option, as a package manager reads its subcommand; undefined when options come first. */
function subcommand(args: readonly string[]): string | undefined {
	return args[0] !== undefined && !args[0].startsWith('-') ? args[0] : undefined;
}

/** Whether a package manager's `args` run a package or add one from the network. */
function packageAction(name: string, args: readonly string[]): 'runs' | 'network' | undefined {
	// Options before the subcommand (`npm --prefix x exec`) hide what it is.
	if (args.length && args[0].startsWith('-') && (runSubcommands[name] || installSubcommands[name])) {
		return args.some(arg => runSubcommands[name]?.has(arg)) ? 'runs' : args.some(arg => installSubcommands[name]?.has(arg)) ? 'network' : undefined;
	}
	const sub = subcommand(args);
	if (sub === undefined) {
		return undefined;
	}
	if (runSubcommands[name]?.has(sub) || (name === 'uv' && sub === 'pip' && args[1] === 'install')) {
		return name === 'uv' && sub === 'pip' ? 'network' : 'runs';
	}
	if (name === 'go' && sub === 'run' && args.some(arg => /@/.test(arg))) {
		return 'network';
	}
	if (installSubcommands[name]?.has(sub)) {
		const packages = args.slice(1).filter((arg, i, rest) => !arg.startsWith('-') && !(i > 0 && localInstallOption.test(rest[i - 1])));
		return packages.length ? 'network' : undefined;
	}
	return undefined;
}

/** Folders whose programs are installed, not written by the agent: an absolute path elsewhere is a script that can be rewritten. */
const installedPrograms = /^\/(bin|sbin|usr|opt\/homebrew|opt\/local|nix|System|Library\/Developer|Applications\/[^/]+\.app\/Contents)\//;

/** Places a command may write without the target being the agent's folder: scratch space. */
const scratchTarget = /^(\/tmp(\/|$)|\/private\/tmp(\/|$)|\/var\/folders\/)/;

/** What an approval knows of the session it belongs to. */
export interface ApprovalContext {
	/** The agent's folders: absolute redirect targets inside them may be approved, others always ask. */
	readonly roots?: readonly string[];
}

/** A shell command as far as approvals go: the prefixes it runs, the files it redirects into, or why it always asks. */
export type ParsedCommand =
	| {
		readonly kind: 'ok';
		/** Each part's program, as written. */
		readonly programs: readonly string[];
		/** Each part's prefix, as approvals key it: `git status`, `npm run lint`, `grep`. */
		readonly prefixes: readonly string[];
		/** The files it writes through a redirection, as written; none for `2>&1` or `>/dev/null`. */
		readonly redirects: readonly string[];
		/** The redirection targets outside the agent's folders, which always ask. */
		readonly outside: readonly string[];
	}
	| { readonly kind: 'asks'; readonly reason: AskReason };

export type AskReason = 'unreadable' | 'network' | 'dynamic';

/** A prefix as one string: its words, a word with spaces in quotes. */
export function formatPrefix(words: readonly string[]): string {
	return words.map(word => /[\s"']/.test(word) || !word ? JSON.stringify(word) : word).join(' ');
}

const builtinKeys = new Set(builtinPrefixes.map(formatPrefix));

/** The git commands that only read the repository a merge request's reviewer works in. */
const gitReads: ReadonlySet<string> = new Set(['git status', 'git diff', 'git log', 'git show']);

/** Options that make those commands write a file (`--output`), read outside the repository (`--no-index`) or run a diff program (`--ext-diff`). */
const gitReadRefused = /(^|\s)["']?(--output|--no-index|--ext-diff)(\b|=)/;

/**
 * Whether `command` only reads the repository with git: every part of it is
 * `git status`, `git diff`, `git log` or `git show`, with no redirect and
 * no option that writes, reads outside the repository or runs a program.
 * A reviewer's checkout is never trusted, so the Gemini CLI asks before
 * every git command there; GeminiCode answers these for it (agentsView.ts).
 */
export function isReadOnlyGitRead(command: string): boolean {
	const parsed = parseCommand(command);
	return parsed.kind === 'ok' && !parsed.redirects.length && parsed.prefixes.every(prefix => gitReads.has(prefix)) && !gitReadRefused.test(command);
}

/** Whether a redirect target is inside the agent's folders (or scratch space), when that can be told. */
function targetInside(target: string, afterCd: boolean, roots: readonly string[]): boolean {
	if (scratchTarget.test(target)) {
		return true;
	}
	if (!path.isAbsolute(target)) {
		// After `cd`, a relative path is relative to a folder the command chose.
		return !afterCd && !target.split(/[\\/]/).includes('..');
	}
	const resolved = path.resolve(target);
	return roots.some(root => {
		const relative = path.relative(path.resolve(root), resolved);
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	});
}

/**
 * Splits `command` on `|`, `||`, `&&`, `;`, `&` and new lines, outside
 * quotes, and takes each part's prefix. Fails safe: anything it is unsure
 * of asks, as do variables that can change what a program runs, programs
 * that run other programs, and scripts the agent can write.
 */
export function parseCommand(command: string, context: ApprovalContext = {}): ParsedCommand {
	const text = command.trim();
	if (!text) {
		return { kind: 'asks', reason: 'unreadable' };
	}
	if (/:\/\/|\b[\w.-]+@[\w-]+(\.[\w-]+)*:/.test(text)) {
		return { kind: 'asks', reason: 'network' };
	}
	const segments: string[][] = [];
	/** The redirect targets of each segment, by the segment's index. */
	const segmentTargets: { readonly segment: number; readonly target: string }[] = [];
	let words: string[] = [];
	let word = '';
	let quote: '"' | '\'' | undefined;
	const endWord = () => {
		if (word) {
			words.push(word);
			word = '';
		}
	};
	const endSegment = () => {
		endWord();
		if (words.length) {
			segments.push(words);
		}
		words = [];
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) {
				quote = undefined;
			} else if (quote === '"' && (c === '`' || (c === '$' && text[i + 1] === '('))) {
				return { kind: 'asks', reason: 'dynamic' };
			} else if (c === '\\' && quote === '"') {
				word += text[++i] ?? '';
			} else {
				word += c;
			}
			continue;
		}
		if (c === '"' || c === '\'') {
			quote = c;
		} else if (c === '`' || (c === '$' && text[i + 1] === '(') || c === '(' || c === ')' || c === '{' || c === '}') {
			return { kind: 'asks', reason: 'dynamic' };
		} else if (c === '<') {
			if (text[i + 1] === '<' || text[i + 1] === '(') {
				// A here-document or process substitution.
				return { kind: 'asks', reason: 'dynamic' };
			}
			endWord();
		} else if (c === '>') {
			endWord();
			let j = i + 1;
			if (text[j] === '>' || text[j] === '|') {
				j++;
			}
			if (text[j] === '(') {
				return { kind: 'asks', reason: 'dynamic' };
			}
			while (/\s/.test(text[j] ?? '')) {
				j++;
			}
			// The target is not a program. `2>&1` and `>/dev/null` write nothing.
			const raw = /^(&\d|"[^"]*"|'[^']*'|[^\s|;&<>]+)/.exec(text.slice(j))?.[0] ?? '';
			const target = raw.replace(/^(["'])(.*)\1$/, '$2');
			if (!target) {
				return { kind: 'asks', reason: 'unreadable' };
			}
			if (changesWhatRuns(target)) {
				// Writing a build file or a git hook decides what a later approved command runs.
				return { kind: 'asks', reason: 'dynamic' };
			}
			if (/[$`~*?[\]]/.test(target)) {
				// A target named by a variable or a glob can be anywhere when it runs.
				return { kind: 'asks', reason: 'dynamic' };
			}
			if (!/^(&\d|\/dev\/(null|stdout|stderr|tty))$/.test(target)) {
				segmentTargets.push({ segment: segments.length, target });
			}
			i = j + raw.length - 1;
		} else if (c === '|' || c === ';' || c === '&' || c === '\n') {
			endSegment();
			if ((c === '|' || c === '&') && text[i + 1] === c) {
				i++;
			}
		} else if (c === '\\') {
			word += text[++i] ?? '';
		} else if (/\s/.test(c)) {
			endWord();
		} else {
			word += c;
		}
	}
	if (quote) {
		return { kind: 'asks', reason: 'unreadable' };
	}
	endSegment();
	const programs: string[] = [];
	const prefixes: string[] = [];
	/** The index of the first segment that changes folder: relative targets after it are relative to a folder the command chose. */
	let firstCd = Infinity;
	for (const [index, segment] of segments.entries()) {
		const start = segment.findIndex(w => !/^[A-Za-z_]\w*=/.test(w));
		if (segment.slice(0, start < 0 ? segment.length : start).some(w => !harmlessVariable.test(w.slice(0, w.indexOf('='))))) {
			return { kind: 'asks', reason: 'dynamic' };
		}
		if (start < 0) {
			continue;
		}
		const words = segment.slice(start);
		const program = words[0];
		const name = path.basename(program);
		const args = words.slice(1);
		if (name === 'cd' || name === 'pushd') {
			firstCd = Math.min(firstCd, index);
		}
		if (networkPrograms.has(name)) {
			return { kind: 'asks', reason: 'network' };
		}
		// A program named by a variable or a glob (`$EDITOR`, `/bin/*sh`) can be anything when it runs.
		if (/[$*?[\]~]/.test(program)) {
			return { kind: 'asks', reason: 'dynamic' };
		}
		const builtin = builtinPrefixes.find(prefix => prefix.every((w, i) => words[i] === w));
		if (!builtin) {
			// A script the agent can write (in its folder, in /tmp) can be rewritten after it was approved.
			if ((program.includes('/') && !installedPrograms.test(program)) || wrapperPrograms.has(name) || containerPrograms.has(name)) {
				return { kind: 'asks', reason: 'dynamic' };
			}
		}
		const action = packageAction(name, args);
		if (action === 'network') {
			return { kind: 'asks', reason: 'network' };
		}
		if (action === 'runs' || runsCode(name, args)) {
			return { kind: 'asks', reason: 'dynamic' };
		}
		programs.push(program);
		prefixes.push(formatPrefix(builtin ?? prefixOf(words)));
	}
	if (!programs.length) {
		return { kind: 'asks', reason: 'unreadable' };
	}
	const roots = context.roots ?? [];
	const redirects = segmentTargets.map(each => each.target);
	const outside = segmentTargets.filter(each => !targetInside(each.target, each.segment >= firstCd, roots)).map(each => each.target);
	return { kind: 'ok', programs, prefixes, redirects, outside };
}

/** Whether an approval may cover a later command, and if not, why it asks. */
export type Coverage =
	| { readonly kind: 'covered' }
	| { readonly kind: 'asks'; readonly reason: AskReason | 'redirect' | 'new-program' };

/** Where an approval rule came from: "Allow for this session", or kept by the host for good ("Always allow"). */
export type ApprovalSource = 'session' | 'permanent';

/** A command prefix the user allowed: `git status` covers `git status -s`, never `git push`. */
export interface ApprovalRule {
	readonly prefix: string;
	readonly source: ApprovalSource;
}

/** One agent session's shell approvals: its own, in memory only, and the permanent ones the host gives it. */
export class SessionApprovals {

	private readonly session = new Set<string>();
	private permanent = new Set<string>();
	/** Permanent rules that lapsed this session, after the agent wrote what they run; asked again until approved. */
	private readonly suspended = new Set<string>();
	/** The redirect targets an approved command wrote, so later commands may write them too. */
	private readonly targets = new Set<string>();

	constructor(private readonly context: () => ApprovalContext = () => ({})) { }

	/** The prefixes approved this session, in the order they were approved. */
	get approved(): readonly string[] {
		return [...this.session];
	}

	/** Every rule in effect: this session's and the permanent ones that have not lapsed. */
	get rules(): readonly ApprovalRule[] {
		return [
			...[...this.session].map(prefix => ({ prefix, source: 'session' as const })),
			...[...this.permanent].filter(prefix => !this.suspended.has(prefix)).map(prefix => ({ prefix, source: 'permanent' as const })),
		];
	}

	/** Replaces the permanent rules, such as a folder's "Always allow" list. */
	setPermanent(prefixes: readonly string[]): void {
		this.permanent = new Set(prefixes);
	}

	/** The prefixes "Allow for this session" on `command` would record, or undefined when it can't be approved this way. */
	prefixesOf(command: string): readonly string[] | undefined {
		const parsed = parseCommand(command, this.context());
		return parsed.kind === 'ok' ? [...new Set(parsed.prefixes)] : undefined;
	}

	/** Remembers `command`'s prefixes and redirect targets; returns the prefixes, or undefined when it can't be approved this way. */
	approve(command: string): readonly string[] | undefined {
		const parsed = parseCommand(command, this.context());
		if (parsed.kind !== 'ok') {
			return undefined;
		}
		for (const prefix of parsed.prefixes) {
			this.session.add(prefix);
			this.suspended.delete(prefix);
		}
		parsed.redirects.filter(target => !parsed.outside.includes(target)).forEach(target => this.targets.add(target));
		return [...new Set(parsed.prefixes)];
	}

	covers(command: string): Coverage {
		const parsed = parseCommand(command, this.context());
		if (parsed.kind !== 'ok') {
			return parsed;
		}
		if (parsed.outside.length || parsed.redirects.some(target => !this.targets.has(target))) {
			return { kind: 'asks', reason: 'redirect' };
		}
		return parsed.prefixes.every(prefix => this.allows(prefix)) ? { kind: 'covered' } : { kind: 'asks', reason: 'new-program' };
	}

	/** Whether `prefix` is a built-in one: read-only or a test, allowed by one approval per session though its program would otherwise always ask. */
	static isBuiltin(prefix: string): boolean {
		return builtinKeys.has(prefix);
	}

	forget(prefix: string): void {
		this.session.delete(prefix);
	}

	/**
	 * The agent wrote `filePath`. A build file changes what a task runner
	 * runs, and what a git hook may run; a hook or a hook manager's settings
	 * change what git runs. The rules for those ask again; returns the ones
	 * that lapsed.
	 */
	noteWrite(filePath: string): readonly string[] {
		const build = isBuildFile(filePath);
		const hook = isGitHookFile(filePath);
		if (!build && !hook) {
			return [];
		}
		const lapses = (prefix: string) => {
			const words = prefix.split(' ');
			const program = words[0];
			const name = path.basename(program);
			if (name === 'git') {
				// A git prefix ends with its command (`git -C src commit`).
				return hook || !gitReadCommands.has(words.at(-1)!);
			}
			return build && (taskRunners.has(name) || program.includes('/'));
		};
		const lapsed = [...this.session, ...[...this.permanent].filter(prefix => !this.suspended.has(prefix))].filter(lapses);
		for (const prefix of lapsed) {
			this.session.delete(prefix);
			if (this.permanent.has(prefix)) {
				this.suspended.add(prefix);
			}
		}
		return [...new Set(lapsed)];
	}

	clear(): void {
		this.session.clear();
		this.suspended.clear();
		this.targets.clear();
	}

	private allows(prefix: string): boolean {
		return this.session.has(prefix) || (this.permanent.has(prefix) && !this.suspended.has(prefix));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// "Allow for this session" for shell commands, kept by GeminiCode. gemini-cli
// 0.63 runs a taint check before each shell command: one that reuses a path
// or value from earlier tool output always asks again, and its "Allow for
// this session" is accepted but not saved. In an investigation almost every
// command does that, so the button seems to do nothing. GeminiCode remembers
// the programs the user allowed and answers repeats itself, while still
// asking for what the check is there for: anything that reaches the network,
// writes through a redirection, runs code it builds, or can't be read.

/** Programs that reach the network, which an approval never covers. */
const networkPrograms = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat', 'http', 'https', 'xh']);

/**
 * Programs that run other programs or code given to them: approving one would
 * approve whatever it runs, so they always ask.
 */
const wrapperPrograms = new Set([
	'xargs', 'env', 'sudo', 'doas', 'su', 'timeout', 'nice', 'nohup', 'time', 'command', 'builtin', 'exec', 'eval', 'source', '.',
	'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'python', 'python2', 'python3', 'node', 'deno', 'bun', 'perl',
	'ruby', 'php', 'lua', 'npx', 'bunx', 'pnpx', 'osascript', 'watch', 'parallel', 'script', 'unbuffer', 'stdbuf', 'chroot',
]);

/**
 * Programs that run what a file in the workspace defines (a package.json
 * script, a Makefile target, a Gradle task). An approval of one lapses when
 * the agent writes such a file, as gemini-cli's own check asks again for a
 * build command after build files changed.
 */
const taskRunners = new Set([
	'npm', 'pnpm', 'yarn', 'make', 'gmake', 'gradle', 'mvn', 'cargo', 'go', 'rake', 'bundle', 'composer', 'dotnet',
	'just', 'task', 'tox', 'nox', 'poetry', 'pipenv', 'uv', 'sbt', 'mix', 'pytest', 'swift', 'xcodebuild', 'ant',
]);

/** The files that define what a task runner runs, by name. */
const buildFile = /^(package\.json|(gnu)?makefile|.+\.mk|(build|settings)\.gradle(\.kts)?|gradle\.properties|pom\.xml|cargo\.toml|build\.rs|go\.mod|rakefile|gemfile|composer\.json|.+\.(cs|fs|vb)proj|directory\.build\.(props|targets)|justfile|taskfile\.ya?ml|tox\.ini|noxfile\.py|pyproject\.toml|setup\.(py|cfg)|conftest\.py|pytest\.ini|pipfile|\.yarnrc\.yml|mix\.exs|build\.sbt|package\.swift|build\.xml)$/i;

/** Whether `filePath` defines what a build or task runner runs. */
export function isBuildFile(filePath: string): boolean {
	return buildFile.test(filePath.split(/[\\/]/).pop() ?? '');
}

/**
 * Whether writing `filePath` changes what a later approved command runs: a
 * build file (a task runner's scripts), or anything under `.git` (hooks,
 * aliases, `core.fsmonitor`).
 */
function changesWhatRuns(filePath: string): boolean {
	const unquoted = filePath.replace(/^of=/, '').replace(/['"]/g, '');
	return isBuildFile(unquoted) || /(^|[\\/])\.git([\\/]|$)/.test(unquoted);
}

/** Programs that write the files their arguments name. */
const fileWriters = new Set(['tee', 'cp', 'mv', 'ln', 'install', 'truncate', 'patch', 'dd']);

/** Git commands that run a command they are given, or set one up for later commands to run. */
function gitRunsCode(args: readonly string[]): boolean {
	if (args.some(arg => arg === '-c' || arg.startsWith('--config-env') || arg.startsWith('--exec-path'))) {
		return true;
	}
	// The first word that is not an option (or the value of `-C`, `--git-dir`, `--work-tree`) is the git command.
	let at = 0;
	while (at < args.length && args[at].startsWith('-')) {
		at += /^(-C|--git-dir|--work-tree|--namespace)$/.test(args[at]) ? 2 : 1;
	}
	const [command, ...rest] = args.slice(at);
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
			return true;
		default:
			return false;
	}
}

/** `NAME=value` prefixes that only change formatting; any other can make a program run code (`GIT_SSH_COMMAND`, `LD_PRELOAD`). */
const harmlessVariable = /^(LC_\w+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CI|TERM|COLUMNS|LINES)$/;

/** Arguments that make an otherwise plain program run code, by program. */
function runsCode(program: string, args: readonly string[]): boolean {
	switch (program) {
		case 'find':
			return args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(arg));
		case 'awk': case 'gawk': case 'mawk': case 'nawk':
			return args.some(arg => /\bsystem\s*\(|\|\s*getline|print[^;]*\|/.test(arg));
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
			// `sed -i` on a build file changes what a task runner runs.
			return args.some(arg => /^(-i|--in-place)/.test(arg)) && args.some(changesWhatRuns);
		default:
			return fileWriters.has(program) && args.some(changesWhatRuns);
	}
}

/** A shell command as far as approvals go: the programs it runs, or why it always asks. */
export type ParsedCommand =
	| { readonly kind: 'ok'; readonly programs: readonly string[]; readonly redirects: boolean }
	| { readonly kind: 'asks'; readonly reason: AskReason };

export type AskReason = 'unreadable' | 'network' | 'dynamic';

/**
 * Splits `command` on `|`, `||`, `&&`, `;`, `&` and new lines, outside
 * quotes, and takes each part's program. Fails safe: anything it is unsure
 * of asks, as do variables that can change what a program runs, programs
 * that run other programs, and scripts in the workspace.
 */
export function parseCommand(command: string): ParsedCommand {
	const text = command.trim();
	if (!text) {
		return { kind: 'asks', reason: 'unreadable' };
	}
	if (/:\/\/|\b[\w.-]+@[\w-]+(\.[\w-]+)*:/.test(text)) {
		return { kind: 'asks', reason: 'network' };
	}
	const segments: string[][] = [];
	let words: string[] = [];
	let word = '';
	let quote: '"' | '\'' | undefined;
	let redirects = false;
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
			if (text[j] === '>') {
				j++;
			}
			if (text[j] === '(') {
				return { kind: 'asks', reason: 'dynamic' };
			}
			while (/\s/.test(text[j] ?? '')) {
				j++;
			}
			// The target is not a program. `2>&1` and `>/dev/null` write nothing.
			const target = /^(&\d|[^\s|;&<>]+)/.exec(text.slice(j))?.[0] ?? '';
			if (changesWhatRuns(target)) {
				// Writing a build file or a git hook decides what a later approved command runs.
				return { kind: 'asks', reason: 'dynamic' };
			}
			if (!/^(&\d|\/dev\/null)$/.test(target)) {
				redirects = true;
			}
			i = j + target.length - 1;
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
	for (const segment of segments) {
		const start = segment.findIndex(w => !/^[A-Za-z_]\w*=/.test(w));
		if (segment.slice(0, start < 0 ? segment.length : start).some(w => !harmlessVariable.test(w.slice(0, w.indexOf('='))))) {
			return { kind: 'asks', reason: 'dynamic' };
		}
		if (start < 0) {
			continue;
		}
		const program = segment[start];
		const name = program.split('/').pop()!;
		if (networkPrograms.has(name)) {
			return { kind: 'asks', reason: 'network' };
		}
		// A script in the workspace can be rewritten by the agent after it was approved.
		// A program named by a variable or a glob (`$EDITOR`, `/bin/*sh`) can be anything when it runs.
		if ((program.includes('/') && !program.startsWith('/')) || /[$*?[\]~]/.test(program)) {
			return { kind: 'asks', reason: 'dynamic' };
		}
		if (wrapperPrograms.has(name) || runsCode(name, segment.slice(start + 1))) {
			return { kind: 'asks', reason: 'dynamic' };
		}
		programs.push(program);
	}
	return programs.length ? { kind: 'ok', programs, redirects } : { kind: 'asks', reason: 'unreadable' };
}

/** Whether an approval may cover a later command, and if not, why it asks. */
export type Coverage =
	| { readonly kind: 'covered' }
	| { readonly kind: 'asks'; readonly reason: AskReason | 'redirect' | 'new-program' };

/** One agent session's "Allow for this session" shell approvals. In memory only; they end with the session. */
export class SessionApprovals {

	private readonly programs = new Set<string>();
	/** Whether an approved command wrote through a redirection, so later ones may too. */
	private redirects = false;

	/** The approved programs, in the order they were approved. */
	get approved(): readonly string[] {
		return [...this.programs];
	}

	/** Remembers `command`'s programs; returns them, or undefined when it can't be approved this way. */
	approve(command: string): readonly string[] | undefined {
		const parsed = parseCommand(command);
		if (parsed.kind !== 'ok') {
			return undefined;
		}
		parsed.programs.forEach(program => this.programs.add(program));
		this.redirects ||= parsed.redirects;
		return parsed.programs;
	}

	covers(command: string): Coverage {
		const parsed = parseCommand(command);
		if (parsed.kind !== 'ok') {
			return parsed;
		}
		if (parsed.redirects && !this.redirects) {
			return { kind: 'asks', reason: 'redirect' };
		}
		return parsed.programs.every(program => this.programs.has(program)) ? { kind: 'covered' } : { kind: 'asks', reason: 'new-program' };
	}

	forget(program: string): void {
		this.programs.delete(program);
	}

	/**
	 * The agent wrote `filePath`. A build file changes what a task runner
	 * runs, so the approved task runners ask again; returns the ones that lapsed.
	 */
	noteWrite(filePath: string): readonly string[] {
		if (!isBuildFile(filePath)) {
			return [];
		}
		const lapsed = [...this.programs].filter(program => taskRunners.has(program.split('/').pop()!));
		lapsed.forEach(program => this.programs.delete(program));
		return lapsed;
	}

	clear(): void {
		this.programs.clear();
		this.redirects = false;
	}
}

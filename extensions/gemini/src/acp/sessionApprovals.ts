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
			// `-c core.sshCommand=…`, `-c alias.x=!…` and friends run what they name.
			return args.some(arg => arg === '-c' || arg.startsWith('--config-env') || arg.startsWith('--exec-path'));
		default:
			return false;
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
		if (program.includes('/') && !program.startsWith('/')) {
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

	clear(): void {
		this.programs.clear();
		this.redirects = false;
	}
}

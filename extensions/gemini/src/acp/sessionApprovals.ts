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

/** A shell command as far as approvals go: the programs it runs, or why it always asks. */
export type ParsedCommand =
	| { readonly kind: 'ok'; readonly programs: readonly string[]; readonly redirects: boolean }
	| { readonly kind: 'asks'; readonly reason: AskReason };

export type AskReason = 'unreadable' | 'network' | 'dynamic';

/**
 * Splits `command` on `|`, `||`, `&&`, `;`, `&` and new lines, outside
 * quotes, and takes each part's program (after any `NAME=value`). Fails
 * safe: anything it is unsure of asks.
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
		const program = segment.find(w => !/^[A-Za-z_]\w*=/.test(w));
		if (!program) {
			continue;
		}
		if (program === 'eval' || program === 'exec' || program === 'source' || program === '.') {
			return { kind: 'asks', reason: 'dynamic' };
		}
		if (networkPrograms.has(program.split('/').pop()!)) {
			return { kind: 'asks', reason: 'network' };
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

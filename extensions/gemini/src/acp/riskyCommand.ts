/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether Run on a reply's command asks first. Most commands run at once; one
// that deletes or discards work, force-pushes, runs as root, pipes a download
// into a shell, writes a disk, or writes outside the folder it runs in asks,
// as does a block of several commands. It reads the words of each command the
// way a shell splits them, without running anything. It is a guess, not a
// sandbox: a script or program can write anywhere, and only the command line
// is read.

import * as path from 'node:path';
import { commandCount } from './runCommands';
import { changesWhatRuns } from './sessionApprovals';

/** Why Run asks first. */
export type RunRisk =
	/** `rm -r`, `find -delete`, `git branch -D`: deletes files or branches. */
	| { readonly kind: 'deletes' }
	/** `git clean`: deletes untracked (and with `-x`, ignored) files. */
	| { readonly kind: 'cleans'; readonly ignored: boolean }
	/** `git reset --hard`, `git checkout -- .`, `git restore .`, `git stash drop`: throws away uncommitted work. */
	| { readonly kind: 'discards' }
	| { readonly kind: 'forcePush' }
	/** `sudo`, `doas`, `su`. */
	| { readonly kind: 'root' }
	/** `curl … | sh`: runs a download. */
	| { readonly kind: 'runsDownload' }
	/** `dd`, `mkfs`, `diskutil erase…`: writes a disk. */
	| { readonly kind: 'disk' }
	/** Writes a file outside the folder it runs in: a redirect or a `cp`, `mv`, `rm` or `tee` target. */
	| { readonly kind: 'outside'; readonly path: string }
	/** Writes a file that decides what runs next: a git hook or anything under `.git`, a build file, a protected setting (sessionApprovals.ts). */
	| { readonly kind: 'configures'; readonly path: string }
	| { readonly kind: 'several'; readonly count: number }
	/** A quote is never closed, so what runs can't be read. */
	| { readonly kind: 'unreadable' };

const shells = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby', 'pwsh', 'powershell']);
const downloaders = new Set(['curl', 'wget', 'iwr', 'irm', 'Invoke-WebRequest', 'Invoke-RestMethod']);
/** A download inside a word a shell is given: `bash -c "$(curl -fsSL https://x/install.sh)"`, or the same in backticks. */
const downloadInWord = /(?:\$\(|`)\s*(?:\S*\/)?(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/;
const elevators = new Set(['sudo', 'doas', 'su', 'pkexec']);
/**
 * Programs that run the command after them as it is: the risk is in that command (`command sudo`,
 * `exec rm -rf`, `xargs rm -r`), so they are stepped over. `sudo` is not among them, since it is a
 * risk of its own; `env` also takes `NAME=value` and options first, `xargs` options with a value.
 */
const wrappers = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'env', 'xargs', 'nice', 'stdbuf', 'unbuffer', 'caffeinate']);
/** The wrappers' options whose value is the next word (`xargs -I {}`, `env -u NAME`, `nice -n 10`). */
const wrapperValueOptions = /^-(I|n|P|L|s|d|E|a|u|C|S|o)$/;
/** Programs that write the files they are given; for these the last argument is the one written. */
const copiers = new Set(['cp', 'mv', 'ln', 'install', 'rsync']);
/** Programs that write or remove every file they are given. */
const writers = new Set(['rm', 'rmdir', 'tee', 'touch', 'truncate', 'mkdir', 'shred', 'unlink', 'chmod', 'chown']);
/** Places outside the folder that a command may write without asking. */
const scratch = /^(\/dev\/(null|stdout|stderr|tty)|\/tmp(\/|$)|\/private\/tmp(\/|$)|\/var\/folders\/)/;

/** One command of a line: its words, the operator before it, and the files it redirects to. */
interface Segment {
	readonly words: readonly string[];
	/** `|` when its input is the previous command's output. */
	readonly after: string;
	readonly redirects: readonly string[];
}

/**
 * Splits a command line into its commands on `|`, `||`, `&&`, `;`, `&` and new
 * lines outside quotes. `$( … )`, `<( … )` and backticks start a command of
 * their own, so what is inside them is checked as a command, with `after`
 * saying which construct it came from.
 */
function segments(command: string): { readonly parts: readonly Segment[]; readonly closed: boolean } {
	const result: Segment[] = [];
	let words: string[] = [];
	let redirects: string[] = [];
	let word = '';
	let after = '';
	let quote: '"' | '\'' | undefined;
	let target = false;
	const endWord = () => {
		if (word) {
			(target ? redirects : words).push(word);
			target = false;
		}
		word = '';
	};
	const endSegment = (operator: string) => {
		endWord();
		if (words.length) {
			result.push({ words, after, redirects });
		}
		words = [];
		redirects = [];
		after = operator;
	};
	const text = command.replace(/\\\n/g, ' ');
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) {
				quote = undefined;
			} else if (c === '\\' && quote === '"') {
				word += text[++i] ?? '';
			} else {
				word += c;
			}
		} else if (c === '"' || c === '\'') {
			quote = c;
		} else if (c === '\\') {
			word += text[++i] ?? '';
		} else if (c === '>') {
			endWord();
			if (text[i + 1] === '>') {
				i++;
			}
			if (text[i + 1] === '&') {
				// `2>&1`: to another descriptor, not a file.
				i++;
				while (/\d/.test(text[i + 1] ?? '')) {
					i++;
				}
			} else {
				target = true;
			}
		} else if (c === '|' || c === ';' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '`') {
			const double = (c === '|' || c === '&') && text[i + 1] === c;
			endSegment(double ? c + c : c);
			if (double) {
				i++;
			}
		} else if ((c === '$' || c === '<') && text[i + 1] === '(') {
			endSegment(c + '(');
			i++;
		} else if (/\s/.test(c)) {
			endWord();
		} else if (/\d/.test(c) && !word && text[i + 1] === '>') {
			// The descriptor of `2> file`.
		} else {
			word += c;
		}
	}
	endSegment('');
	return { parts: result, closed: !quote };
}

/** Whether `file`, as a command running in `folder` names it, is outside `folder` and not a scratch place. */
function isOutside(file: string, folder: string, home: string): boolean {
	if (!file || file.startsWith('-') || /^[a-z][\w+.-]*:\/\//i.test(file) || /^[\w.-]+@[\w.-]+:/.test(file)) {
		return false;
	}
	const expanded = file === '~' ? home : file.startsWith('~/') ? path.join(home, file.slice(2)) : file.replace(/^\$HOME(?=\/|$)/, home);
	if (/[$`]/.test(expanded)) {
		// Named by a variable: where it points is only known when it runs.
		return !expanded.startsWith('$PWD') && !expanded.startsWith('./');
	}
	const resolved = path.resolve(folder, expanded);
	if (scratch.test(resolved)) {
		return false;
	}
	const relative = path.relative(path.resolve(folder), resolved);
	return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** The words after the `NAME=value` prefixes and the wrappers that run what follows: the program and its arguments. */
function commandWords(words: readonly string[]): readonly string[] {
	let rest = words;
	for (;;) {
		const start = rest.findIndex(w => !/^[A-Za-z_]\w*=/.test(w));
		if (start < 0) {
			return [];
		}
		rest = rest.slice(start);
		const name = rest[0].split('/').pop() ?? rest[0];
		if (!wrappers.has(name)) {
			return rest;
		}
		// Past the wrapper's own options: `xargs -I {} rm -r`, `env -u X ls`, `nice -n 10 make`.
		let at = 1;
		while (at < rest.length && rest[at].startsWith('-') && rest[at] !== '--') {
			at += wrapperValueOptions.test(rest[at]) ? 2 : 1;
		}
		if (rest[at] === '--') {
			at++;
		}
		rest = rest.slice(at);
	}
}

/** The git command of `git …` (past `-C dir` and other global options), and its arguments. */
function gitCommand(args: readonly string[]): { readonly name?: string; readonly rest: readonly string[] } {
	let at = 0;
	while (at < args.length && args[at].startsWith('-')) {
		at += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[at]) ? 2 : 1;
	}
	return { name: args[at], rest: args.slice(at + 1) };
}

/** Whether `args` holds the short option `letter`, alone or in a group (`-xfd`), or one of the long `names`. */
function hasOption(args: readonly string[], letter: string, ...names: string[]): boolean {
	return args.some(arg => names.includes(arg) || (/^-[A-Za-z]+$/.test(arg) && arg.includes(letter)));
}

/** The program of a segment, by name, past its prefixes and wrappers. */
function programOf(segment: Segment | undefined): string {
	const program = segment ? commandWords(segment.words)[0] : undefined;
	return program?.split('/').pop() ?? '';
}

/**
 * The risk in one command (the program and its arguments), apart from writing
 * outside the folder. `after` is the operator or construct before it: `|` when
 * its input is the previous command's output, `$(`, `<(` or a backtick when
 * it is inside one.
 */
function segmentRisk(words: readonly string[], after: string, previous: Segment | undefined): RunRisk | undefined {
	const [program, ...args] = words;
	const name = program.split('/').pop() ?? program;
	const piped = after === '|';
	if (elevators.has(name)) {
		return { kind: 'root' };
	}
	if (piped && shells.has(name) && downloaders.has(programOf(previous))) {
		return { kind: 'runsDownload' };
	}
	// `bash -c "$(curl … )"`: the download is a word the shell runs; `bash <(curl …)` and `bash -c $(curl …)`: the download is the command before the shell reads it.
	if (shells.has(name) && args.some(arg => downloadInWord.test(arg))) {
		return { kind: 'runsDownload' };
	}
	if ((after === '<(' || after === '$(' || after === '`') && downloaders.has(name) && shells.has(programOf(previous))) {
		return { kind: 'runsDownload' };
	}
	if (name === 'iex' || name === 'Invoke-Expression') {
		return piped ? { kind: 'runsDownload' } : undefined;
	}
	if (name === 'dd' || /^mkfs(\.|$)/.test(name) || name === 'fdisk' || name === 'parted' || (name === 'diskutil' && /^(erase|partition|zero|secureErase|reformat)/i.test(args[0] ?? ''))) {
		return { kind: 'disk' };
	}
	if (name === 'rm' && (hasOption(args, 'r', '--recursive') || hasOption(args, 'R'))) {
		return { kind: 'deletes' };
	}
	if (name === 'Remove-Item' && args.some(arg => /^-r(ecurse)?$/i.test(arg))) {
		return { kind: 'deletes' };
	}
	if (name === 'find' && args.some(arg => arg === '-delete' || (arg === '-exec' && args.includes('rm')))) {
		return { kind: 'deletes' };
	}
	if (name !== 'git') {
		return undefined;
	}
	const git = gitCommand(args);
	switch (git.name) {
		case 'clean':
			return hasOption(git.rest, 'n', '--dry-run') ? undefined : { kind: 'cleans', ignored: hasOption(git.rest, 'x') || hasOption(git.rest, 'X') };
		case 'reset':
			return git.rest.includes('--hard') || git.rest.includes('--merge') || git.rest.includes('--keep') ? { kind: 'discards' } : undefined;
		case 'checkout':
			// `git checkout -- .`, `git checkout .`, `git checkout -f`: the files' changes go.
			return git.rest.includes('--') || git.rest.includes('.') || hasOption(git.rest, 'f', '--force') ? { kind: 'discards' } : undefined;
		case 'restore':
			return git.rest.includes('--staged') && !git.rest.includes('--worktree') && !hasOption(git.rest, 'W') ? undefined : { kind: 'discards' };
		case 'stash':
			return git.rest[0] === 'drop' || git.rest[0] === 'clear' ? { kind: 'discards' } : undefined;
		case 'branch':
			return git.rest.includes('-D') || (hasOption(git.rest, 'd', '--delete') && hasOption(git.rest, 'f', '--force')) ? { kind: 'deletes' } : undefined;
		case 'push':
			return hasOption(git.rest, 'f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete') || git.rest.some(arg => /^--force-with-lease=/.test(arg) || /^\+/.test(arg) || /^:/.test(arg))
				? { kind: 'forcePush' } : undefined;
		default:
			return undefined;
	}
}

/** The files a command writes or removes, by its arguments: a copy's target, or every file `rm` or `tee` is given. */
function writtenFiles(words: readonly string[]): readonly string[] {
	const [program, ...args] = words;
	const name = program.split('/').pop() ?? program;
	const files = args.filter(arg => !arg.startsWith('-'));
	if (copiers.has(name)) {
		const target = args.findIndex(arg => arg === '-t' || arg === '--target-directory');
		return target >= 0 && args[target + 1] ? [args[target + 1]] : files.slice(-1);
	}
	return writers.has(name) ? files : [];
}

/**
 * Why Run should ask before running `command` in `folder`, or undefined when
 * it can run at once. `home` expands `~`.
 */
export function runRisk(command: string, folder: string, home: string): RunRisk | undefined {
	const { parts, closed } = segments(command);
	if (!closed) {
		return { kind: 'unreadable' };
	}
	let outside: RunRisk | undefined;
	for (let i = 0; i < parts.length; i++) {
		const words = commandWords(parts[i].words);
		if (!words.length) {
			continue;
		}
		const risk = segmentRisk(words, parts[i].after, parts[i - 1]);
		if (risk) {
			return risk;
		}
		const written = [...parts[i].redirects, ...writtenFiles(words)];
		// A git hook, a build file or a protected setting: what it decides runs later, with the user's privileges.
		const configures = written.find(each => !each.startsWith('-') && changesWhatRuns(each));
		if (configures) {
			return { kind: 'configures', path: configures };
		}
		const file = outside ? undefined : written.find(each => isOutside(each, folder, home));
		if (file) {
			outside = { kind: 'outside', path: file };
		}
	}
	if (outside) {
		return outside;
	}
	const count = commandCount(command);
	return count > 1 ? { kind: 'several', count } : undefined;
}

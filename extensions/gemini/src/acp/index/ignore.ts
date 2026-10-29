/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Ignore rules in .gitignore syntax, for `.geminiignore` and the
// `gemini.index.exclude` setting (git applies `.gitignore` itself, through
// `git ls-files`). A pattern with no slash but a trailing one matches a name
// at any depth; one with a slash is anchored to the folder; `*` stays within
// a path segment, `**` crosses them; `!` re-includes; the last match wins.
// As in git, nothing under an ignored folder can be re-included.

interface Rule {
	readonly pattern: RegExp;
	readonly negated: boolean;
	readonly directoryOnly: boolean;
}

export class IgnoreRules {

	private readonly rules: readonly Rule[];

	constructor(patterns: readonly string[]) {
		this.rules = patterns.map(parseRule).filter((rule): rule is Rule => !!rule);
	}

	get empty(): boolean {
		return this.rules.length === 0;
	}

	/** Whether the folder-relative file `relative` (with `/` separators) is ignored. */
	ignores(relative: string): boolean {
		if (!this.rules.length) {
			return false;
		}
		const segments = relative.split('/');
		for (let i = 1; i < segments.length; i++) {
			if (this.matches(segments.slice(0, i).join('/'), true)) {
				return true;
			}
		}
		return this.matches(relative, false);
	}

	private matches(relative: string, directory: boolean): boolean {
		let ignored = false;
		for (const rule of this.rules) {
			if ((!rule.directoryOnly || directory) && rule.pattern.test(relative)) {
				ignored = !rule.negated;
			}
		}
		return ignored;
	}
}

function parseRule(line: string): Rule | undefined {
	let text = line.replace(/(?<!\\)\s+$/, '');
	if (!text || text.startsWith('#')) {
		return undefined;
	}
	const negated = text.startsWith('!');
	if (negated) {
		text = text.slice(1);
	}
	const directoryOnly = text.endsWith('/');
	if (directoryOnly) {
		text = text.slice(0, -1);
	}
	const anchored = text.includes('/');
	text = text.replace(/^\//, '');
	if (!text) {
		return undefined;
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(anchored ? `^${globToRegex(text)}$` : `(?:^|/)${globToRegex(text)}$`);
	} catch {
		// Not a glob that makes sense (`[z-a]`): it matches its own text.
		const literal = text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
		pattern = new RegExp(anchored ? `^${literal}$` : `(?:^|/)${literal}$`);
	}
	return { pattern, negated, directoryOnly };
}

/** `**` segments kept in one pattern; more of them (each can try every position) count as `*`. */
const maxGlobstars = 2;

function globToRegex(source: string): string {
	// Runs of `**` say no more than one does.
	const glob = source.replace(/\*{3,}/g, '**').replace(/(?:\*\*\/)+/g, '**/').replace(/(?:\/\*\*)+$/g, '/**');
	let globstars = 0;
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === '*') {
			if (glob[i + 1] === '*' && globstars++ >= maxGlobstars) {
				out += '[^/]*';
				i++;
			} else if (glob[i + 1] === '*') {
				const slashAfter = glob[i + 2] === '/';
				out += slashAfter ? '(?:.*/)?' : '.*';
				i += slashAfter ? 2 : 1;
			} else {
				out += '[^/]*';
			}
		} else if (char === '?') {
			out += '[^/]';
		} else if (char === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end > i) {
				out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
				i = end;
			} else {
				out += '\\[';
			}
		} else if (char === '\\' && i + 1 < glob.length) {
			out += escape(glob[++i]);
		} else {
			out += escape(char);
		}
	}
	return out;
}

function escape(char: string): string {
	return /[.+^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

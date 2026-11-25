/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A repository's checks, as its team defaults name them
// (`.gemini/geminicode-tools.json`, the `checks` section):
//
//   "checks": {
//     "commands": ["npm test"],
//     "protected": ["**/*.test.ts", "package.json"],   // optional
//     "afterTurn": "ask"                               // "always", "ask" or "never"
//   }
//
// Verify (verify.ts) runs the commands on an agent's work. `protected` names
// the files whose original version counts: when an agent changed one and the
// checks pass, they run again with those files as they were before the agent.
// Kept apart from verify.ts, which runs things: the reader of the team
// defaults is in the bundle every window loads.

/** When checks run after an agent's turn changed files: by themselves, when asked for in the Changes panel, or never. */
export type AfterTurn = 'always' | 'ask' | 'never';

export interface ChecksConfig {
	/** Shell commands, run in order in the repository's top folder; the first that fails ends the run. */
	readonly commands: readonly string[];
	/** Globs, relative to the repository's top folder, of the files whose original version counts. */
	readonly protected: readonly string[];
	readonly afterTurn: AfterTurn;
}

/** How many commands a repository may name, and how long one may be: what a consent dialog can show whole. */
const maxCommands = 8;
const maxCommandLength = 400;

/**
 * What counts as protected when a repository names nothing: tests and what
 * decides how they run. An agent that makes a red test green by editing one of
 * these did not fix the code.
 */
export function defaultProtected(): string[] {
	return [
		'**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**',
		'**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/*Test.java', '**/*Tests.cs',
		'**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
		'**/{vitest,jest,playwright,karma,cypress,mocha}.config.*', '**/.mocharc*', '**/vitest.workspace.*',
		'**/pytest.ini', '**/conftest.py', '**/tox.ini', '**/pyproject.toml',
	];
}

/** The `checks` section as read from the file, or undefined when it names no command: anything malformed is left out, never guessed. */
export function checksConfig(raw: unknown): ChecksConfig | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const strings = (value: unknown, max: number) => Array.isArray(value)
		? value.flatMap(each => typeof each === 'string' && each.trim() && each.length <= max && !/[\r\n\0]/.test(each) ? [each.trim()] : [])
		: [];
	const commands = strings(o.commands, maxCommandLength).slice(0, maxCommands);
	if (!commands.length) {
		return undefined;
	}
	const named = strings(o.protected, 200).slice(0, 100);
	const afterTurn = o.afterTurn === 'always' || o.afterTurn === 'never' ? o.afterTurn : 'ask';
	return { commands, protected: named.length ? named : defaultProtected(), afterTurn };
}

/** A glob as a pattern: `**` crosses folders, `*` and `?` stay in one, `{a,b}` is either. */
function globPattern(glob: string): RegExp {
	let out = '';
	let depth = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			// `**/` also matches nothing, so `**/package.json` is the one at the top too.
			if (glob[i + 2] === '/') {
				out += '(?:.*/)?';
				i += 2;
			} else {
				out += '.*';
				i += 1;
			}
		} else if (c === '*') {
			out += '[^/]*';
		} else if (c === '?') {
			out += '[^/]';
		} else if (c === '{') {
			out += '(?:';
			depth++;
		} else if (c === '}' && depth) {
			out += ')';
			depth--;
		} else if (c === ',' && depth) {
			out += '|';
		} else {
			out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}${')'.repeat(depth)}$`);
}

/** The files among `files` (relative to the repository's top folder, `/` between folders) that `patterns` protect. */
export function protectedAmong(files: readonly string[], patterns: readonly string[]): string[] {
	const tests = patterns.map(each => globPattern(each.replace(/^\.?\//, '')));
	return files.filter(file => tests.some(test => test.test(file)));
}

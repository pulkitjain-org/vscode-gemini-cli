/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The strings the user reads are written one way: an ellipsis is three dots,
// as the Home strings and the chat's status lines have it, never the one
// character "..." (U+2026), which a few strings used while the rest did not.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(import.meta.dirname, '..', '..');
const ellipsis = '\u2026';

/**
 * Strings still on the single character, each to be moved to three dots in
 * its own file; take one off this list with that edit. The test fails on a new one.
 */
const pending: Record<string, readonly string[]> = {
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.ts') ? [file] : [];
	});
}

/** The literals passed to `vscode.l10n.t` in `text`, first argument only. */
function l10nLiterals(text: string): string[] {
	return [...text.matchAll(/l10n\.t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)].map(match => match[1] ?? match[2]);
}

describe('user-visible strings', () => {
	it('write an ellipsis as three dots in every l10n.t literal', () => {
		const found: Record<string, string[]> = {};
		for (const file of sourceFiles(path.join(root, 'src'))) {
			const literals = l10nLiterals(readFileSync(file, 'utf8')).filter(literal => literal.includes(ellipsis));
			if (literals.length) {
				found[path.relative(root, file)] = literals;
			}
		}
		expect(found).toEqual(pending);
	});

	it('write an ellipsis as three dots in package.nls.json', () => {
		const strings = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
		expect(Object.entries(strings).filter(([, value]) => value.includes(ellipsis))).toEqual([]);
	});
});

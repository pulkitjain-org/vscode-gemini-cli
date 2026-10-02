/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { branchNameFrom, isValidBranchName } from '../../src/acp/branchNames';

describe('branchNameFrom', () => {
	it('makes a short slug under gemini/', () => {
		expect(branchNameFrom('Fix the login redirect!')).toBe('gemini/fix-the-login-redirect');
		expect(branchNameFrom('Caf\u00e9 \u2014 na\u00efve r\u00e9sum\u00e9')).toBe('gemini/cafe-naive-resume');
		expect(branchNameFrom('a'.repeat(30) + ' ' + 'b'.repeat(30))).toBe(`gemini/${'a'.repeat(30)}-${'b'.repeat(9)}`);
	});

	it('falls back when nothing is left', () => {
		expect(branchNameFrom('!!!')).toBe('gemini/changes');
	});

	it('gives valid names', () => {
		for (const title of ['Fix the login redirect!', '...', '- leading dash', 'x'.repeat(100)]) {
			expect(isValidBranchName(branchNameFrom(title))).toBe(true);
		}
	});
});

describe('isValidBranchName', () => {
	it('accepts ordinary names', () => {
		expect(isValidBranchName('feature/login')).toBe(true);
		expect(isValidBranchName('fix-123')).toBe(true);
	});

	it('rejects what git rejects', () => {
		for (const name of ['', '-x', '/x', 'x/', 'x.', 'x.lock', 'a..b', 'a//b', 'a@{b', '@', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a/.b', '.a']) {
			expect(isValidBranchName(name), name).toBe(false);
		}
	});
});

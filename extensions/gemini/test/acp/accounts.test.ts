/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { googleAccountsPath, parseActiveAccount, readActiveAccount } from '../../src/acp/accounts';

describe('accounts', () => {
	it('finds the file under ~/.gemini, or under GEMINI_CLI_HOME when set', () => {
		expect(googleAccountsPath({}, '/home/me')).toBe(path.join('/home/me', '.gemini', 'google_accounts.json'));
		expect(googleAccountsPath({ GEMINI_CLI_HOME: '/custom' }, '/home/me')).toBe(path.join('/custom', '.gemini', 'google_accounts.json'));
	});

	it('reads the active account the CLI writes', () => {
		expect(parseActiveAccount(JSON.stringify({ active: 'me@example.com', old: ['old@example.com'] }, null, 2))).toBe('me@example.com');
	});

	it.each([
		['an empty file', ''],
		['no active account', '{"active":null,"old":["old@example.com"]}'],
		['a broken file', '{"active":'],
		['a non-string account', '{"active":42}'],
	])('reports nobody signed in for %s', (_name, content) => {
		expect(parseActiveAccount(content)).toBeUndefined();
	});

	it('reads from disk and treats a missing file as signed out', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'gemini-accounts-'));
		const file = path.join(dir, 'google_accounts.json');
		expect(await readActiveAccount(file)).toBeUndefined();
		writeFileSync(file, '{"active":"me@example.com","old":[]}');
		expect(await readActiveAccount(file)).toBe('me@example.com');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Where the CLI caches the signed-in Google account: `google_accounts.json`
 * in its global directory, `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`
 * (gemini-cli 0.62 `Storage.getGoogleAccountsPath`). The file holds email
 * addresses only, no tokens.
 */
export function googleAccountsPath(env: NodeJS.ProcessEnv, homeDir: string): string {
	return path.join(env.GEMINI_CLI_HOME || homeDir, '.gemini', 'google_accounts.json');
}

/** The active account's email from the file's contents, validated the way the CLI does. */
export function parseActiveAccount(content: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed === 'object' && parsed !== null) {
			const active = (parsed as { active?: unknown }).active;
			return typeof active === 'string' && active ? active : undefined;
		}
	} catch {
		// A missing, empty or broken file means nobody is signed in, as for the CLI.
	}
	return undefined;
}

export async function readActiveAccount(filePath: string): Promise<string | undefined> {
	try {
		return parseActiveAccount(await readFile(filePath, 'utf8'));
	} catch {
		return undefined;
	}
}

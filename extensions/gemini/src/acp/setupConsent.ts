/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether a repository's worktree setup script may run without asking. The
// `gemini.agents.worktreeSetup` command is the user's or the admin's (it is
// machine-scoped), so it runs as set. A repository's own
// `.gemini/worktree-setup.sh` is the repository's: it runs once the user
// allowed that exact content, remembered by hash, and asks again when the
// script changes, as it may after a pull or an agent's edit.

import { createHash } from 'node:crypto';

/** The hash a script's consent is kept by: SHA-256 of its content, with line endings made alike. */
export function setupScriptHash(content: string): string {
	return createHash('sha256').update(content.replace(/\r\n?/g, '\n')).digest('hex');
}

/** What running a repository's setup script needs: the user's consent, unless they allowed this content before. */
export interface SetupConsent {
	readonly needed: boolean;
	/** The hash to remember once the user allows it. */
	readonly hash: string;
}

/** Whether `content`, a repository's setup script, needs consent, given the hashes the user allowed. */
export function setupScriptConsent(content: string, allowed: Iterable<string>): SetupConsent {
	const hash = setupScriptHash(content);
	for (const each of allowed) {
		if (each === hash) {
			return { needed: false, hash };
		}
	}
	return { needed: true, hash };
}

/** The allowed hashes with `hash` added, newest last and at most `limit` kept, for storing. */
export function rememberSetupScript(allowed: readonly string[], hash: string, limit = 200): string[] {
	return [...allowed.filter(each => each !== hash), hash].slice(-limit);
}

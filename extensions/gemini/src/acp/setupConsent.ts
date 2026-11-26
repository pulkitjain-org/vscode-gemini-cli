/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether a repository's worktree setup script may run without asking. The
// `gemini.agents.worktreeSetup` command is the user's own (it is
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

/** What the consent dialog shows of a script: its first lines, and how many lines it leaves out. */
export interface ScriptPreview {
	readonly text: string;
	/** Lines left out at the end; 0 when the whole script shows. */
	readonly moreLines: number;
}

/**
 * A script cut for the consent dialog: blank lines at either end dropped, at
 * most `maxLines` lines, each at most 200 characters, and `maxChars` in all,
 * so a long script still leaves the dialog's buttons on screen.
 */
export function scriptPreview(content: string, maxLines = 30, maxChars = 1_500): ScriptPreview {
	const lines = content.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '').split('\n');
	const shown: string[] = [];
	let chars = 0;
	for (const line of lines) {
		const cut = line.length > 200 ? `${line.slice(0, 199)}…` : line;
		if (shown.length >= maxLines || chars + cut.length > maxChars) {
			break;
		}
		shown.push(cut);
		chars += cut.length + 1;
	}
	return { text: shown.join('\n'), moreLines: lines.length - shown.length };
}

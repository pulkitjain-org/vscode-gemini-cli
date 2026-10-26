/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Commit messages for the chat's commit and Merge Back, written by the quick
// model from the diff, as Generate Commit Message writes them for Source
// Control. The caller falls back to the agent's name when none is written.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { cleanCommitMessage, commitMessagePrompt } from './quickPrompts';
import { git } from './worktrees';

/**
 * The diff a commit of `files` (absolute paths in `folder`; all of its work
 * when unset) would make, against `HEAD`, with files Git doesn't track yet as
 * new files: what a commit message is written from. Cut near `maxLength`.
 */
export async function diffAgainstHead(folder: string, files?: readonly string[], maxLength = 60_000): Promise<string> {
	const relative = files?.map(file => path.relative(folder, file)).filter(file => file && !file.startsWith('..') && !path.isAbsolute(file));
	if (relative && !relative.length) {
		return '';
	}
	const pathspecs = relative ? ['--', ...relative.map(file => `:(literal)${file.split(path.sep).join('/')}`)] : [];
	const [tracked, untracked] = await Promise.all([
		git(folder, ['diff', '--no-color', '--no-ext-diff', 'HEAD', ...pathspecs]).catch(() => git(folder, ['diff', '--no-color', '--no-ext-diff', '--cached', ...pathspecs])),
		git(folder, ['ls-files', '-z', '--others', '--exclude-standard', ...pathspecs]),
	]);
	let diff = tracked;
	for (const file of untracked.split('\0').filter(Boolean)) {
		if (diff.length >= maxLength) {
			break;
		}
		const text = await readFile(path.join(folder, file), 'utf8').catch(() => undefined);
		if (text !== undefined) {
			diff += newFileDiff(file, text.slice(0, maxLength - diff.length));
		}
	}
	return diff.slice(0, maxLength);
}

/** A new file as `git diff` shows one, for text that isn't in the index yet. */
export function newFileDiff(file: string, text: string): string {
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}`;
}

/** A direct request to the quick model, as the agents view has it. */
export type DirectWriter = (request: { readonly system: string; readonly prompt: string }) => Promise<string | undefined>;

/** How long a commit message may take to write before the suggested one is used. */
const writeTimeoutMs = 20_000;

/**
 * A commit message for `files` in `folder` (all of its work when unset),
 * written by the quick model from their diff and the repository's recent
 * subjects, as Generate Commit Message does; undefined when there is nothing
 * to describe, or the message can't be written (inline edit turned off, a
 * sign-in that can't make direct requests, a failure).
 */
export async function writeCommitMessage(folder: string, files: readonly string[] | undefined, direct: DirectWriter | undefined): Promise<string | undefined> {
	if (!direct) {
		return undefined;
	}
	try {
		const [diff, log] = await Promise.all([diffAgainstHead(folder, files), git(folder, ['log', '-8', '--format=%s']).catch(() => '')]);
		if (!diff.trim()) {
			return undefined;
		}
		const { system, prompt } = commitMessagePrompt(diff, log.split('\n').filter(Boolean));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), writeTimeoutMs));
		const reply = await Promise.race([direct({ system, prompt }), timeout]).finally(() => clearTimeout(timer));
		return reply ? cleanCommitMessage(reply) || undefined : undefined;
	} catch {
		return undefined;
	}
}

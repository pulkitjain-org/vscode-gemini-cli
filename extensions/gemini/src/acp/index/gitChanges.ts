/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What git says changed in a folder, for keeping an agent's worktree index
// current when its turn ends: the files `git status` lists, and those changed
// by the commits made since the last look. That is a few paths, where a
// reconcile reads the whole folder (about 8 s of CPU at 200,000 files).

import { execFile } from 'node:child_process';
import * as path from 'node:path';

const timeoutMs = 15_000;
const maxOutputBytes = 32 * 1024 * 1024;

function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('git', [...args], { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout));
	});
}

/** The commit HEAD points at, from git, so packed refs and reftable repositories work too. */
export async function gitHead(root: string): Promise<string | undefined> {
	return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() || undefined;
}

/**
 * The files changed in `root`'s worktree (absolute paths), with the commit
 * HEAD is at now: uncommitted and untracked ones, and those the commits
 * since `since` changed. Undefined when git can't tell (no repository, or
 * `since` is no longer known), so the caller looks at everything.
 */
export async function changedSince(root: string, since: string | undefined): Promise<{ readonly head: string | undefined; readonly paths: readonly string[] } | undefined> {
	const [top, head, status] = await Promise.all([
		git(root, ['rev-parse', '--show-toplevel']),
		gitHead(root),
		git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
	]);
	if (top === undefined || status === undefined) {
		return undefined;
	}
	// Both commands name files from the repository's top folder.
	const repository = top.trim();
	const paths = new Set(porcelainPaths(status));
	if (head && since !== head) {
		if (!since) {
			return undefined;
		}
		const diff = await git(root, ['diff', '--name-only', '-z', '--no-renames', since, head, '--']);
		if (diff === undefined) {
			return undefined;
		}
		for (const file of diff.split('\0')) {
			if (file) {
				paths.add(file);
			}
		}
	}
	return { head, paths: [...paths].map(file => path.join(repository, file)) };
}

/** The paths in `git status --porcelain -z` output: each entry's path, and a rename's or copy's source too. */
export function porcelainPaths(output: string): string[] {
	const paths: string[] = [];
	const fields = output.split('\0');
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		if (entry.length < 4) {
			continue;
		}
		paths.push(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C') {
			const source = fields[++i];
			if (source) {
				paths.push(source);
			}
		}
	}
	return paths;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The branch a folder is on, for the Agents pane. Reading `.git/HEAD`
// directly costs one or two small file reads; asking the git extension would
// open the repository in Source Control, and spawning git costs a process.
// Only `filesMatchingHead`, which runs once a commit lands, spawns git.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { folderInRepository, git } from './worktrees';

/** The checked-out branch, a short commit id when detached, or `undefined` outside a repository. */
export async function readGitHead(folder: string): Promise<string | undefined> {
	const gitDir = await findGitDir(folder);
	if (!gitDir) {
		return undefined;
	}
	let head: string;
	try {
		head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
	} catch {
		return undefined;
	}
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
	if (ref) {
		return ref[1];
	}
	return /^[0-9a-f]{40,64}$/i.test(head) ? head.slice(0, 7) : undefined;
}

/** The repository's git directory: `.git`, or where a worktree's `.git` file points. */
export async function findGitDir(folder: string): Promise<string | undefined> {
	for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, '.git');
		try {
			if ((await stat(candidate)).isDirectory()) {
				return candidate;
			}
			const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(candidate, 'utf8'));
			if (pointer) {
				return path.resolve(dir, pointer[1].trim());
			}
		} catch {
			// Not here; try the parent.
		}
		if (path.dirname(dir) === dir) {
			return undefined;
		}
	}
}

/** Where to watch for a commit, checkout or pull: the repository's git directory and, for a worktree, the shared one with its branches. */
export async function gitDirs(folder: string): Promise<{ readonly gitDir: string; readonly commonDir: string } | undefined> {
	const gitDir = await findGitDir(folder);
	if (!gitDir) {
		return undefined;
	}
	const common = (await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
	return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
}

/**
 * Of `files` (absolute paths in `folder`), those whose text on disk is what
 * `HEAD` has: committed, so no longer waiting for review. A file Git doesn't
 * track, or that differs from `HEAD` (staged or not), is not.
 */
export async function filesMatchingHead(folder: string, files: readonly string[]): Promise<string[]> {
	const prefix = await folderInRepository(folder);
	// Paths from the top of the repository, as Git prints them, for the files inside `folder`.
	const byTopPath = new Map<string, string>();
	for (const file of files) {
		const relative = path.relative(folder, file);
		if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
			byTopPath.set(path.posix.join(prefix, relative.split(path.sep).join('/')), file);
		}
	}
	if (!byTopPath.size) {
		return [];
	}
	const pathspecs = [...byTopPath.keys()].map(top => `:(top,literal)${top}`);
	const [tracked, status] = await Promise.all([
		git(folder, ['ls-files', '-z', '--full-name', '--', ...pathspecs]),
		git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs]),
	]);
	const changed = new Set(porcelainPaths(status));
	return tracked.split('\0').filter(top => top && !changed.has(top) && byTopPath.has(top)).map(top => byTopPath.get(top)!);
}

/** The paths in `git status --porcelain=v1 -z` output, from the top of the repository; a rename gives both. */
export function porcelainPaths(output: string): string[] {
	const entries = output.split('\0');
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) {
			continue;
		}
		paths.push(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C') {
			paths.push(entries[++i] ?? '');
		}
	}
	return paths.filter(Boolean);
}


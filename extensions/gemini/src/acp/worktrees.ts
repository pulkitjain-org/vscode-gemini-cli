/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent worktrees: an agent can work on its own branch in its own folder
// (`git worktree`), so agents running side by side never edit the same files.
// The folders live under ~/.geminicode/worktrees rather than inside the
// repository, so the open workspace's search, file watchers and language
// servers don't see every file twice.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** An agent's own branch and folder. Plain data, kept with the agent. */
export interface AgentWorktree {
	/** The worktree's top folder. */
	readonly folder: string;
	/** Where the agent runs: the workspace's place inside the worktree. */
	readonly cwd: string;
	readonly branch: string;
	/** The branch (or short commit) it was made from, which Merge Back merges into by default. */
	readonly base: string;
}

export class GitError extends Error {
	constructor(message: string, readonly stderr: string) {
		super(message);
	}
}

/** Runs git in `cwd`; rejects with its stderr. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
			if (err) {
				const detail = String(stderr).trim() || err.message;
				reject(new GitError(detail.split('\n').filter(line => !/^hint:/.test(line)).join('\n'), String(stderr)));
			} else {
				resolve(String(stdout));
			}
		});
	});
}

/** The top folder of the repository `folder` is in, or undefined outside one. */
export async function repositoryRoot(folder: string): Promise<string | undefined> {
	try {
		return (await git(folder, ['rev-parse', '--show-toplevel'])).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * `folder`'s path inside its repository ('' at the top). Asked of Git rather
 * than worked out from `repositoryRoot`, which is the real path: through a
 * symlink (such as /tmp on macOS) the two would not line up.
 */
export async function folderInRepository(folder: string): Promise<string> {
	return (await git(folder, ['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '');
}

/** Where agent worktrees for `repository` go: ~/.geminicode/worktrees/<repository name>. */
export function worktreesHome(repository: string, home: string = os.homedir()): string {
	return path.join(home, '.geminicode', 'worktrees', path.basename(repository) || 'repository');
}

/** A free folder name in `parent` for `branch`: its last part, with -2, -3... if taken. */
export async function freeFolder(parent: string, branch: string): Promise<string> {
	const name = branch.split('/').pop()?.replace(/[^\w.-]+/g, '-') || 'agent';
	for (let n = 1; ; n++) {
		const candidate = path.join(parent, n === 1 ? name : `${name}-${n}`);
		try {
			await fs.access(candidate);
		} catch {
			return candidate;
		}
	}
}

/** Whether `branch` already exists in `repository`. */
export async function branchExists(repository: string, branch: string): Promise<boolean> {
	try {
		await git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Makes a new branch from what `repository` has checked out, in a new folder.
 * `subfolder` is the workspace's path inside the repository, for the agent's `cwd`.
 */
export async function createWorktree(repository: string, branch: string, subfolder = '', home?: string): Promise<AgentWorktree> {
	const base = await currentBranch(repository);
	const parent = worktreesHome(repository, home);
	await fs.mkdir(parent, { recursive: true });
	const folder = await freeFolder(parent, branch);
	await git(repository, ['worktree', 'add', '--quiet', '-b', branch, folder, 'HEAD']);
	return { folder, cwd: path.join(folder, subfolder), branch, base };
}

export interface WorktreeStatus {
	/** Files changed in the worktree and not committed. */
	readonly uncommitted: number;
	/** Commits on the agent's branch that `into` does not have. */
	readonly commits: number;
}

export async function worktreeStatus(worktree: AgentWorktree, into: string): Promise<WorktreeStatus> {
	const [status, count] = await Promise.all([
		git(worktree.folder, ['status', '--porcelain']),
		git(worktree.folder, ['rev-list', '--count', `${into}..${worktree.branch}`]).catch(() => '0'),
	]);
	return { uncommitted: status.split('\n').filter(Boolean).length, commits: Number(count.trim()) || 0 };
}

/** Commits everything in the worktree. */
export async function commitAll(folder: string, message: string): Promise<void> {
	await git(folder, ['add', '-A']);
	await git(folder, ['commit', '--quiet', '-m', message]);
}

export type MergeResult =
	| { readonly kind: 'merged' }
	| { readonly kind: 'conflicts'; readonly files: readonly string[] };

/**
 * Merges the agent's branch into what `repository` has checked out. On
 * conflicts the merge is left in progress for the user to finish in Source
 * Control; any other failure (such as local changes in the way) rejects.
 */
export async function mergeBranch(repository: string, branch: string): Promise<MergeResult> {
	try {
		await git(repository, ['merge', '--no-ff', '--no-edit', branch]);
		return { kind: 'merged' };
	} catch (err) {
		const files = (await git(repository, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
		if (files.length) {
			return { kind: 'conflicts', files };
		}
		throw err;
	}
}

/** The branch `repository` has checked out, or a short commit when detached. */
export async function currentBranch(repository: string): Promise<string> {
	const head = (await git(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
	return head === 'HEAD' ? (await git(repository, ['rev-parse', '--short', 'HEAD'])).trim() : head;
}

/** Deletes the worktree's folder and, with `deleteBranch`, its branch, even with unmerged work. */
export async function removeWorktree(repository: string, worktree: AgentWorktree, deleteBranch: boolean): Promise<void> {
	try {
		await git(repository, ['worktree', 'remove', '--force', worktree.folder]);
	} catch (err) {
		// Already gone from disk: forget it.
		await fs.access(worktree.folder).then(() => { throw err; }, () => git(repository, ['worktree', 'prune']));
	}
	if (deleteBranch && await branchExists(repository, worktree.branch)) {
		await git(repository, ['branch', '-D', worktree.branch]);
	}
}

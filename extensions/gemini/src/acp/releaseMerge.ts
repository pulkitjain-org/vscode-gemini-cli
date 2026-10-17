/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Git for the team flows: whether a release branch merges cleanly into a later
// one (`git merge-tree`, which touches no checkout), the merge itself in a
// worktree of its own, a worktree checked out at someone else's branch for a
// review, and pushing. The user's own checkout is never changed.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseMergeTree } from './teamFlowLogic';
import { AgentWorktree, freeFolder, git, worktreesHome } from './worktrees';

/** Runs git and resolves with its exit code and output, rejecting only when git can't run. */
function gitCode(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
			const code = err ? (err as { code?: unknown }).code : 0;
			if (err && typeof code !== 'number') {
				reject(err);
				return;
			}
			resolve({ code: code as number, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** Fetches `branches` from `remote`, so checks see what GitLab has. */
export async function fetchBranches(repository: string, remote: string, branches: readonly string[]): Promise<void> {
	if (branches.length) {
		await git(repository, ['fetch', '--quiet', remote, ...branches.map(b => `+refs/heads/${b}:refs/remotes/${remote}/${b}`)]);
	}
}

export interface MergeCheck {
	readonly target: string;
	/** Commits `source` has that `target` doesn't. */
	readonly behind: number;
	/** Undefined when Git is too old to tell (before 2.38). */
	readonly clean?: boolean;
	readonly conflicts: readonly string[];
}

/** Whether `remote/source` merges cleanly into `remote/target`, without touching any checkout. */
export async function checkMerge(repository: string, remote: string, source: string, target: string): Promise<MergeCheck> {
	const from = `${remote}/${source}`;
	const into = `${remote}/${target}`;
	const count = await git(repository, ['rev-list', '--count', `${into}..${from}`]).then(text => Number(text.trim()) || 0, () => 0);
	if (!count) {
		return { target, behind: 0, clean: true, conflicts: [] };
	}
	const result = await gitCode(repository, ['merge-tree', '--write-tree', '--name-only', into, from]);
	if (result.code > 1) {
		return { target, behind: count, conflicts: [] };
	}
	const parsed = parseMergeTree(result.stdout, result.code);
	return { target, behind: count, clean: parsed.clean, conflicts: parsed.files };
}

export type ReleaseMergeResult =
	| { readonly kind: 'merged'; readonly worktree: AgentWorktree }
	| { readonly kind: 'conflicts'; readonly worktree: AgentWorktree; readonly files: readonly string[] };

/**
 * Makes `branch` from `remote/target` in a worktree of its own and merges
 * `remote/source` into it. On conflicts the merge is left in progress there,
 * for an agent to resolve.
 */
export async function mergeInWorktree(repository: string, remote: string, source: string, target: string, branch: string, home?: string): Promise<ReleaseMergeResult> {
	const parent = worktreesHome(repository, home);
	await fs.mkdir(parent, { recursive: true });
	const folder = await freeFolder(parent, branch);
	await git(repository, ['worktree', 'add', '--quiet', '-B', branch, folder, `${remote}/${target}`]);
	const worktree: AgentWorktree = { folder, cwd: folder, branch, base: target };
	const merge = await gitCode(folder, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${source} into ${target}`, `${remote}/${source}`]);
	if (merge.code === 0) {
		return { kind: 'merged', worktree };
	}
	const files = (await git(folder, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
	if (!files.length) {
		throw new Error(merge.stderr.trim() || 'The merge failed.');
	}
	return { kind: 'conflicts', worktree, files };
}

/** Whether a worktree still has a merge in progress or files with conflict markers. */
export async function mergeUnfinished(folder: string): Promise<boolean> {
	const head = await gitCode(folder, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
	const unmerged = (await git(folder, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
	return head.code === 0 || !!unmerged;
}

/**
 * Checks out `remote/branch` (someone else's MR) in a worktree of its own, on
 * a local branch `local`, for a review. Fetches it first.
 */
export async function reviewWorktree(repository: string, remote: string, branch: string, local: string, subfolder = '', home?: string): Promise<AgentWorktree> {
	await fetchBranches(repository, remote, [branch]);
	const parent = worktreesHome(repository, home);
	await fs.mkdir(parent, { recursive: true });
	const folder = await freeFolder(parent, local);
	await git(repository, ['worktree', 'add', '--quiet', '-B', local, folder, `${remote}/${branch}`]);
	return { folder, cwd: path.join(folder, subfolder), branch: local, base: branch };
}

/** Pushes `branch` from `folder` to `remote`, setting it as upstream. */
export async function pushBranch(folder: string, remote: string, branch: string): Promise<void> {
	await git(folder, ['push', '--quiet', '-u', remote, `HEAD:refs/heads/${branch}`]);
}

/** The commits, diffstat and diff of `HEAD` against `remote/target`, for a merge request's description. */
export async function branchSummary(folder: string, base: string): Promise<{ commits: string; diffStat: string; diff: string }> {
	const range = `${base}...HEAD`;
	const [commits, diffStat, diff] = await Promise.all([
		git(folder, ['log', '--no-merges', '--format=- %s%n%b', `${base}..HEAD`]).catch(() => ''),
		git(folder, ['diff', '--stat=120', range]).catch(() => ''),
		git(folder, ['diff', '--unified=2', range]).catch(() => ''),
	]);
	return { commits: commits.replace(/\n{2,}/g, '\n').trim(), diffStat: diffStat.trim(), diff };
}

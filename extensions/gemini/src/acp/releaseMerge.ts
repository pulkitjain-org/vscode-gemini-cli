/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Git for the team flows: fetching branches, a worktree checked out at someone
// else's branch for a review, pushing, and a branch's summary for a merge
// request's description. The user's own checkout is never changed.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AgentWorktree, freeFolder, git, worktreesHome } from './worktrees';

/** Fetches `branches` from `remote`, so checks see what GitLab has. */
export async function fetchBranches(repository: string, remote: string, branches: readonly string[]): Promise<void> {
	if (branches.length) {
		await git(repository, ['fetch', '--quiet', remote, ...branches.map(b => `+refs/heads/${b}:refs/remotes/${remote}/${b}`)]);
	}
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

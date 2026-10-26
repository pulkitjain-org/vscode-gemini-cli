/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Git for the team flows: fetching branches, a worktree checked out at someone
// else's branch for a review, pushing, and a branch's summary for a merge
// request's description. The user's own checkout is never changed.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isInside } from './fileAccess';
import { AgentWorktree, branchExists, checkoutOf, freeFolder, git, pathExists, reviewsHome, worktreesHome } from './worktrees';

/** Fetches `branches` from `remote`, so checks see what GitLab has. */
export async function fetchBranches(repository: string, remote: string, branches: readonly string[]): Promise<void> {
	if (branches.length) {
		await git(repository, ['fetch', '--quiet', remote, ...branches.map(b => `+refs/heads/${b}:refs/remotes/${remote}/${b}`)]);
	}
}

/**
 * A worktree for the review of `remote/branch` (someone else's MR) on
 * GeminiCode's own local branch `local` (review/...), fetched first, in the
 * repository's reviews folder (`reviewsHome`), which the Gemini CLI never
 * trusts: the merge request's own Gemini settings, hooks and MCP servers
 * never run. A second review of the same merge request reuses the worktree
 * already on `local`, moved to the branch's new head; nothing in it is the
 * user's, since the reviewer only reads. One left in the agents' worktrees
 * folder by an earlier version, which is trusted with the repository, is made
 * again in the reviews folder, unless `inUse` says an agent works there.
 * Only a name GeminiCode owns is ever reset like this.
 */
export async function reviewWorktree(repository: string, remote: string, branch: string, local: string, options: { readonly subfolder?: string; readonly home?: string; readonly inUse?: (folder: string) => boolean } = {}): Promise<AgentWorktree> {
	if (!local.startsWith('review/')) {
		throw new Error(`${local} isn't a review branch; GeminiCode resets only its own review/ branches.`);
	}
	const subfolder = options.subfolder ?? '';
	await fetchBranches(repository, remote, [branch]);
	const existing = await checkoutOf(repository, local);
	if (existing && await pathExists(existing)) {
		const trusted = isInside(path.dirname(worktreesHome(repository, options.home)), existing);
		const moved = trusted && !options.inUse?.(existing) && await git(repository, ['worktree', 'remove', '--force', existing]).then(() => true, () => false);
		if (!moved) {
			await git(existing, ['reset', '--quiet', '--hard', `${remote}/${branch}`]);
			return { folder: existing, cwd: path.join(existing, subfolder), branch: local, base: branch };
		}
	}
	// A folder removed by hand is still listed until pruned, and git refuses its branch meanwhile.
	await git(repository, ['worktree', 'prune']);
	const parent = reviewsHome(repository, options.home);
	await fs.mkdir(parent, { recursive: true });
	const folder = await freeFolder(parent, local);
	await git(repository, ['worktree', 'add', '--quiet', '-B', local, folder, `${remote}/${branch}`]);
	return { folder, cwd: path.join(folder, subfolder), branch: local, base: branch };
}

/** The local branch has commits its remote copy lacks: working on it from the remote's copy would drop them. */
export class UnpushedCommitsError extends Error {
	constructor(readonly branch: string, readonly count: number) {
		super(count === 1
			? `Your local ${branch} has 1 commit that isn't pushed. Push it, or move it to another branch, then try again.`
			: `Your local ${branch} has ${count} commits that aren't pushed. Push them, or move them to another branch, then try again.`);
	}
}

/**
 * A worktree on `branch` itself (a merge request's source branch, to fix it),
 * fetched first. Never drops or moves back a commit of the user's:
 * - where the branch is checked out already (the clone or a worktree), that
 *   checkout is used as it is;
 * - a local branch with commits `remote` lacks is refused (UnpushedCommitsError);
 * - a local branch behind its remote copy is moved forward to it, then checked out;
 * - a branch only on the remote gets a local branch that tracks it.
 * `parent` is the folder new worktrees go in (the repository's worktrees folder by default).
 */
export async function branchWorktree(repository: string, remote: string, branch: string, options: { readonly parent?: string; readonly home?: string; readonly subfolder?: string } = {}): Promise<AgentWorktree & { readonly existing?: boolean }> {
	const subfolder = options.subfolder ?? '';
	await fetchBranches(repository, remote, [branch]);
	const existing = await checkoutOf(repository, branch);
	if (existing && await pathExists(existing)) {
		return { folder: existing, cwd: path.join(existing, subfolder), branch, base: branch, existing: true };
	}
	await git(repository, ['worktree', 'prune']);
	const parent = options.parent ?? worktreesHome(repository, options.home);
	await fs.mkdir(parent, { recursive: true });
	const folder = await freeFolder(parent, branch);
	const upstream = `${remote}/${branch}`;
	const onRemote = await git(repository, ['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`]).then(() => true, () => false);
	if (await branchExists(repository, branch)) {
		if (onRemote) {
			const ahead = Number((await git(repository, ['rev-list', '--count', `${upstream}..refs/heads/${branch}`])).trim()) || 0;
			if (ahead) {
				throw new UnpushedCommitsError(branch, ahead);
			}
			// Not ahead, so the local branch is in the remote's history: moving it forward loses nothing.
			await git(repository, ['branch', '--quiet', '-f', branch, upstream]);
		}
		await git(repository, ['worktree', 'add', '--quiet', folder, branch]);
	} else {
		await git(repository, ['worktree', 'add', '--quiet', '--track', '-b', branch, folder, upstream]);
	}
	return { folder, cwd: path.join(folder, subfolder), branch, base: branch };
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run Checks on any branch, before a merge request exists: which branches to
// offer, and a checkout to run the checks in. A branch that is checked out
// already (the repository itself, or an agent's worktree) is used as it is; any
// other gets a worktree of its own under ~/.geminicode/worktrees/<repository>/checks/,
// reused on the next run. The user's own checkout is never changed.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { branchWorktree } from './releaseMerge';
import { AgentWorktree, branchExists, checkoutOf, freeFolder, git, worktreesHome } from './worktrees';

export type BranchChoiceKind = 'current' | 'agent' | 'local' | 'remote';

export interface BranchChoice {
	readonly branch: string;
	readonly kind: BranchChoiceKind;
	/** The agent working on the branch, for `agent`. */
	readonly agent?: string;
}

/** The branches Run Checks offers: the current one first, then agents' branches, then local, then remote-only ones, once each. */
export function branchChoices(current: string | undefined, agents: readonly { readonly branch: string; readonly title: string }[], locals: readonly string[], remotes: readonly string[]): BranchChoice[] {
	const seen = new Set<string>();
	const choices: BranchChoice[] = [];
	const add = (branch: string, kind: BranchChoiceKind, agent?: string) => {
		if (branch && !seen.has(branch)) {
			seen.add(branch);
			choices.push({ branch, kind, ...agent ? { agent } : {} });
		}
	};
	if (current) {
		add(current, 'current');
	}
	for (const agent of agents) {
		add(agent.branch, 'agent', agent.title);
	}
	for (const branch of [...locals].sort()) {
		add(branch, 'local');
	}
	for (const branch of [...remotes].sort()) {
		add(branch, 'remote');
	}
	return choices;
}

/** The repository's local branches and `remote`'s branches (without the remote's name). */
export async function listBranches(repository: string, remote = 'origin'): Promise<{ readonly locals: string[]; readonly remotes: string[] }> {
	const text = await git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads', `refs/remotes/${remote}`]);
	const locals: string[] = [];
	const remotes: string[] = [];
	const remotePrefix = `refs/remotes/${remote}/`;
	for (const ref of text.split('\n').map(line => line.trim()).filter(Boolean)) {
		if (ref.startsWith('refs/heads/')) {
			locals.push(ref.slice('refs/heads/'.length));
		} else if (ref.startsWith(remotePrefix) && ref !== `${remotePrefix}HEAD`) {
			remotes.push(ref.slice(remotePrefix.length));
		}
	}
	return { locals, remotes };
}

export { checkoutOf };

export interface ChecksCheckout {
	/** Where to run the checks. */
	readonly cwd: string;
	/** The worktree made or found for the branch; none when the repository itself has it checked out. */
	readonly worktree?: AgentWorktree;
	/** Whether a worktree was made by this call, so the repository's setup should run in it. */
	readonly created: boolean;
}

/**
 * A checkout of `branch` to run checks in: the repository or an existing
 * worktree when one has it, else a new worktree on the branch (a remote-only
 * branch is fetched and given a local branch of the same name).
 */
export async function checkoutForChecks(repository: string, remote: string, branch: string, home?: string): Promise<ChecksCheckout> {
	const existing = await checkoutOf(repository, branch);
	if (existing) {
		const real = await fs.realpath(existing).catch(() => existing);
		const repo = await fs.realpath(repository).catch(() => repository);
		return real === repo ? { cwd: repository, created: false } : { cwd: existing, worktree: { folder: existing, cwd: existing, branch, base: branch }, created: false };
	}
	if (await branchExists(repository, branch)) {
		const parent = path.join(worktreesHome(repository, home), 'checks');
		await fs.mkdir(parent, { recursive: true });
		const folder = await freeFolder(parent, branch);
		await git(repository, ['worktree', 'add', '--quiet', folder, branch]);
		const base = (await git(repository, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]).catch(() => '')).trim() || branch;
		return { cwd: folder, worktree: { folder, cwd: folder, branch, base }, created: true };
	}
	// Only on the remote: a new local branch of the same name, made from it.
	const worktree = await branchWorktree(repository, remote, branch, { parent: path.join(worktreesHome(repository, home), 'checks') });
	return { cwd: worktree.cwd, worktree, created: true };
}

/**
 * The files a branch changed: what it committed since it left `target` (its remote copy, else the
 * local branch), and what isn't committed yet. Paths are relative to `cwd`; deleted files are left out.
 */
export async function changedFiles(cwd: string, target: string, remote = 'origin'): Promise<string[]> {
	const files = new Set<string>();
	for (const base of [`${remote}/${target}`, target]) {
		const mergeBase = (await git(cwd, ['merge-base', 'HEAD', base]).catch(() => '')).trim();
		if (mergeBase) {
			for (const file of (await git(cwd, ['diff', '--name-only', '--relative', '--diff-filter=ACMR', `${mergeBase}...HEAD`])).split('\n')) {
				if (file.trim()) {
					files.add(file.trim());
				}
			}
			break;
		}
	}
	// Git names the top folder by its real path (/private/var, not /var), so `cwd` is compared the same way.
	const top = await repositoryTop(cwd);
	const here = await fs.realpath(cwd).catch(() => cwd);
	for (const line of (await git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', '.'])).split('\n')) {
		// "XY path" or "XY old -> new"; a deleted file has nothing left to analyse.
		if (line.length > 3 && !line.startsWith(' D') && !line.startsWith('D ')) {
			const file = line.slice(3).split(' -> ').pop()!.trim().replace(/^"(.*)"$/, '$1');
			files.add(path.relative(here, path.join(top, file)));
		}
	}
	return [...files].sort();
}

async function repositoryTop(cwd: string): Promise<string> {
	return (await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => cwd)).trim() || cwd;
}

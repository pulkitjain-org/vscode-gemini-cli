/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The worktrees Settings' Clean Up may offer, with what git says of each
// (storageUsage.ts offers only those with nothing uncommitted and nothing
// unmerged): merged threads', reviewers' whose review is over, and folders
// in ~/.geminicode/worktrees that no agent has any more. Agents running in
// this window are never offered.

import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentRecord } from './agents';
import { samePath } from './fsUtil';
import { foldersTwoDown, type WorktreeCandidate } from './storageUsage';
import { type AgentWorktree, currentBranch, git, mainRepository, pathExists, worktreeStatus, type WorktreeStatus } from './worktrees';

export interface CleanupAgents {
	readonly records: readonly AgentRecord[];
	/** The repository a single-repository agent's worktree belongs to. */
	repositoryOf(record: AgentRecord): Promise<string | undefined>;
	/** Running in this window: its folder is in use. */
	running(id: string): boolean;
	/** A reviewer whose review is still in progress. */
	reviewing(id: string): boolean;
}

/** What Clean Up may offer of the agents' worktrees; `home` holds ~/.geminicode. */
export async function cleanupWorktrees(agents: CleanupAgents, home: string = os.homedir()): Promise<WorktreeCandidate[]> {
	const found: WorktreeCandidate[] = [];
	const statusOf = (worktree: AgentWorktree, into: string | undefined) => into ? worktreeStatus(worktree, into).catch(() => undefined) : Promise.resolve(undefined);
	for (const record of agents.records) {
		if (agents.running(record.id)) {
			continue;
		}
		const project = record.project;
		if (project?.role === 'thread' && project.resolved) {
			const parts = record.repos?.length
				? record.repos.filter(repo => !repo.merged).map(repo => ({ repository: repo.repository as string | undefined, worktree: repo as AgentWorktree }))
				: record.worktree ? [{ repository: await agents.repositoryOf(record), worktree: record.worktree }] : [];
			for (const { repository, worktree } of parts) {
				if (repository && await pathExists(worktree.folder)) {
					// Merged into what its repository has checked out, with nothing left over.
					found.push({ agent: record.id, kind: 'merged', repository, worktree, status: await statusOf(worktree, await currentBranch(repository).catch(() => undefined)) });
				}
			}
		} else if (record.worktree?.branch.startsWith('review/') && !agents.reviewing(record.id)) {
			const repository = await agents.repositoryOf(record);
			if (repository && await pathExists(record.worktree.folder)) {
				// A review/ branch is GeminiCode's own copy of the merge request: only uncommitted changes would be lost.
				found.push({ agent: record.id, kind: 'review', repository, worktree: record.worktree, status: await statusOf(record.worktree, record.worktree.branch) });
			}
		}
	}
	const known = agents.records.flatMap(record => [record.worktree?.folder, ...(record.repos ?? []).map(repo => repo.folder)].filter((folder): folder is string => !!folder));
	for (const folder of await foldersTwoDown(path.join(home, '.geminicode', 'worktrees'))) {
		if (!known.some(each => samePath(each, folder))) {
			const removed = await removedWorktree(folder);
			if (removed) {
				found.push({ agent: folder, kind: 'removed', ...removed });
			}
		}
	}
	return found;
}

/**
 * A worktree no agent has any more, with its repository and git's status;
 * undefined for a folder that isn't a linked worktree's top. Its commits
 * count as unmerged unless another branch or a remote has them.
 */
async function removedWorktree(folder: string): Promise<{ readonly repository: string; readonly worktree: AgentWorktree; readonly status: WorktreeStatus | undefined } | undefined> {
	try {
		const [top, repository, branch] = await Promise.all([git(folder, ['rev-parse', '--show-toplevel']).then(out => out.trim()), mainRepository(folder), currentBranch(folder)]);
		if (!samePath(top, folder) || samePath(repository, folder)) {
			return undefined;
		}
		const worktree: AgentWorktree = { folder, cwd: folder, branch, base: '' };
		const status = await Promise.all([
			git(folder, ['status', '--porcelain']),
			// --exclude names a branch as --branches lists it, without refs/heads/; branch names can't hold glob characters.
			git(folder, ['rev-list', '--count', 'HEAD', '--not', `--exclude=${branch}`, '--branches', '--remotes']),
		]).then(([changes, count]) => ({ uncommitted: changes.split('\n').filter(Boolean).length, commits: Number(count.trim()) || 0 }), () => undefined);
		return { repository, worktree, status };
	} catch {
		return undefined;
	}
}

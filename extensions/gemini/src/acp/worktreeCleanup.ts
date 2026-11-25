/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The worktrees Settings' Clean Up may offer, with what git says of each
// (storageUsage.ts offers only those with nothing uncommitted and nothing
// unmerged): merged threads', reviewers' whose review is over, and folders
// in ~/.geminicode/worktrees, ~/.geminicode/reviews or ~/.geminicode/threads
// that no agent has any more. Agents running in this window are never
// offered. A removal that could not finish leaves a folder that is no
// worktree any more, only files: those are offered as left-over folders, and
// the ones a removal remembered (`rememberLeftover`) are tried again at the
// next start (`retryLeftovers`).

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentRecord } from './agents';
import { samePath, writeFileAtomic } from './fsUtil';
import { foldersTwoDown, type WorktreeCandidate } from './storageUsage';
import { allReviewsHome, allThreadsHome, type AgentWorktree, currentBranch, git, inBatches, isAgentFolder, mainRepository, pathExists, worktreeStatus, type WorktreeStatus } from './worktrees';

/** How many agents' worktrees are asked of git at once. */
const batchSize = 8;

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
	// A count git couldn't give is no status at all: such a worktree is never offered.
	const statusOf = (worktree: AgentWorktree, into: string | undefined) => into ? worktreeStatus(worktree, into).then(status => status.commits === undefined ? undefined : status, () => undefined) : Promise.resolve(undefined);
	const ofRecord = async (record: AgentRecord): Promise<WorktreeCandidate[]> => {
		const found: WorktreeCandidate[] = [];
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
		return found;
	};
	const found = (await inBatches(agents.records.filter(record => !agents.running(record.id)), batchSize, ofRecord)).flat();
	const known = agents.records.flatMap(record => [record.worktree?.folder, ...(record.repos ?? []).map(repo => repo.folder)].filter((folder): folder is string => !!folder));
	// Review checkouts are in ~/.geminicode/reviews, and were in ~/.geminicode/worktrees before.
	const owned = (folder: string) => known.some(each => samePath(each, folder));
	const leftOver = (await Promise.all([path.join(home, '.geminicode', 'worktrees'), allReviewsHome(home)].map(root => foldersTwoDown(root)))).flat();
	// A thread in several repositories has a folder of its own, with a worktree of each inside.
	const threadFolders = (await foldersTwoDown(allThreadsHome(home))).filter(folder => !owned(folder));
	const inThreads = (await Promise.all(threadFolders.map(subfolders))).flat();
	const unknown = [...leftOver, ...inThreads].filter(folder => !owned(folder));
	const removed = await inBatches(unknown, batchSize, removedWorktree);
	for (const [i, each] of removed.entries()) {
		if (each) {
			found.push({ agent: unknown[i], kind: 'removed', ...each });
		}
	}
	// What a removal that could not finish left: files, with nothing of git's to say whose they were.
	const plain = [...leftOver.filter(folder => !owned(folder)), ...threadFolders];
	for (const [i, isPlain] of (await inBatches(plain, batchSize, plainFolder)).entries()) {
		if (isPlain) {
			found.push(leftoverCandidate(plain[i]));
		}
	}
	return found;
}

/** A left-over folder as Clean Up lists it: no repository, and nothing git could count. */
function leftoverCandidate(folder: string): WorktreeCandidate {
	return { agent: folder, kind: 'leftover', repository: '', worktree: { folder, cwd: folder, branch: '', base: '' }, status: { uncommitted: 0, commits: 0 } };
}

async function subfolders(folder: string): Promise<string[]> {
	return (await fs.readdir(folder, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => path.join(folder, entry.name));
}

/**
 * Whether `folder` holds no checkout: no `.git` of its own, and none in the
 * folders right inside it (a thread's worktrees). A checkout whose repository
 * forgot it still has its `.git` file, and may hold work: never offered.
 */
async function plainFolder(folder: string): Promise<boolean> {
	const tops = [folder, ...await subfolders(folder)];
	return !(await Promise.all(tops.map(top => pathExists(path.join(top, '.git'))))).some(Boolean);
}

/** The folders removals left behind, as `file` lists them; none when it is missing or unreadable. */
async function leftovers(file: string): Promise<string[]> {
	try {
		const listed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
		return Array.isArray(listed) ? listed.filter((each): each is string => typeof each === 'string') : [];
	} catch {
		return [];
	}
}

/** Adds `folder` to the folders a removal could not delete, kept in `file`. */
export async function rememberLeftover(file: string, folder: string): Promise<void> {
	const listed = await leftovers(file);
	if (!listed.includes(folder)) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await writeFileAtomic(file, JSON.stringify([...listed, folder]));
	}
}

/**
 * Deletes the folders `file` lists, which removals could not: each only when
 * it is one GeminiCode made (`isAgentFolder`), no agent in `owned` has it now
 * (a new thread may have taken the name) and it holds no checkout. Resolves
 * with those still there, which stay listed; the file goes once none is.
 */
export async function retryLeftovers(file: string, owned: readonly string[], home: string = os.homedir()): Promise<string[]> {
	const listed = await leftovers(file);
	const still: string[] = [];
	for (const folder of listed) {
		if (!isAgentFolder(folder, home) || owned.some(each => samePath(each, folder)) || !await pathExists(folder) || !await plainFolder(folder)) {
			continue;
		}
		await fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
		if (await pathExists(folder)) {
			still.push(folder);
		}
	}
	if (still.length) {
		await writeFileAtomic(file, JSON.stringify(still));
	} else if (listed.length) {
		await fs.rm(file, { force: true });
	}
	return still;
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

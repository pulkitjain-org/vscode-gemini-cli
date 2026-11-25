/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../src/acp/agents';
import { cleanupPlan, runCleanup } from '../../src/acp/storageUsage';
import { cleanupWorktrees, rememberLeftover, retryLeftovers } from '../../src/acp/worktreeCleanup';
import { allReviewsHome, allThreadsHome, type AgentWorktree, commitAll, createWorktree, createWorktreeAt, git, mergeBranch, pathExists, removeWorktree } from '../../src/acp/worktrees';

let root: string;
let repo: string;
let home: string;

beforeAll(() => {
	Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' });
});

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-cleanup-')));
	repo = path.join(root, 'shop');
	home = path.join(root, 'home');
	await fs.mkdir(repo, { recursive: true });
	await git(repo, ['init', '--quiet', '--initial-branch=main']);
	await fs.writeFile(path.join(repo, 'cart.ts'), 'export const total = 1;\n');
	await commitAll(repo, 'Initial');
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

function record(id: string, fields: Partial<AgentRecord>): AgentRecord {
	return { id, workspaceId: 'w', title: id, createdAt: 1, updatedAt: 1, ...fields };
}

describe('the worktrees Clean Up may offer', () => {
	it('never offers a worktree whose commits git cannot count', async () => {
		const gone = await createWorktree(repo, 'gemini/gone', '', home);
		await fs.writeFile(path.join(gone.folder, 'a.ts'), 'a\n');
		await commitAll(gone.folder, 'A');
		// Its branch's ref was removed by hand: nothing says whether its commit is anywhere else.
		await git(repo, ['update-ref', '-d', 'refs/heads/gemini/gone']);
		const records = [record('gone', { worktree: gone, project: { role: 'thread', coordinator: 'c', byCoordinator: false, resolved: true } })];
		const candidates = await cleanupWorktrees({ records, repositoryOf: async () => repo, running: () => false, reviewing: () => false }, home);
		const plan = await cleanupPlan({ globalStorage: path.join(root, 'global'), agents: new Set(['gone']), merged: new Set(), keepLogsDays: 90, now: new Date(), running: () => true, worktrees: candidates });
		expect({ status: candidates.map(each => each.status), offered: plan.filter(item => item.area === 'worktrees') }).toEqual({ status: [undefined], offered: [] });
	});

	it('offers merged threads\', ended reviews\' and removed agents\' worktrees only when nothing would be lost', async () => {
		const merged = await createWorktree(repo, 'gemini/merged', '', home);
		await fs.writeFile(path.join(merged.folder, 'a.ts'), 'a\n');
		await commitAll(merged.folder, 'A');
		await mergeBranch(repo, merged.branch);
		const unmerged = await createWorktree(repo, 'gemini/unmerged', '', home);
		await fs.writeFile(path.join(unmerged.folder, 'b.ts'), 'b\n');
		await commitAll(unmerged.folder, 'B');
		const review = await createWorktree(repo, 'review/482-rate-limit', '', home);
		const reviewing = await createWorktree(repo, 'review/483-other', '', home);
		// Review checkouts made since they moved to ~/.geminicode/reviews: one with its reviewer, one without.
		const inReviews = async (branch: string): Promise<AgentWorktree> => {
			const folder = path.join(allReviewsHome(home), 'shop', branch.split('/').pop()!);
			await fs.mkdir(path.dirname(folder), { recursive: true });
			await git(repo, ['worktree', 'add', '--quiet', '-b', branch, folder]);
			return { folder, cwd: folder, branch, base: 'main' };
		};
		const newReview = await inReviews('review/484-new');
		await inReviews('review/485-left');
		const running = await createWorktree(repo, 'gemini/running', '', home);
		await createWorktree(repo, 'gemini/removed-clean', '', home);
		const removedAhead = await createWorktree(repo, 'gemini/removed-ahead', '', home);
		await fs.writeFile(path.join(removedAhead.folder, 'c.ts'), 'c\n');
		await commitAll(removedAhead.folder, 'C');
		const removedDirty = await createWorktree(repo, 'gemini/removed-dirty', '', home);
		await fs.writeFile(path.join(removedDirty.folder, 'cart.ts'), 'changed\n');
		const thread = (id: string, worktree: typeof merged) => record(id, { worktree, project: { role: 'thread', coordinator: 'c', byCoordinator: false, resolved: true } });
		const records = [
			thread('merged', merged), thread('unmerged', unmerged), thread('running', running),
			record('reviewer', { worktree: review }), record('reviewing', { worktree: reviewing }), record('newReviewer', { worktree: newReview }),
		];
		const candidates = await cleanupWorktrees({
			records,
			repositoryOf: async () => repo,
			running: id => id === 'running',
			reviewing: id => id === 'reviewing',
		}, home);
		const plan = await cleanupPlan({ globalStorage: path.join(root, 'global'), agents: new Set(records.map(each => each.id)), merged: new Set(), keepLogsDays: 90, now: new Date(), running: () => true, worktrees: candidates });
		expect({
			candidates: candidates.map(each => [each.kind, path.basename(each.worktree.folder), each.status]).sort(),
			offered: plan.filter(item => item.area === 'worktrees').map(item => [item.reason, path.basename(item.path)]).sort(),
		}).toEqual({
			candidates: [
				['merged', 'merged', { uncommitted: 0, commits: 0 }],
				['merged', 'unmerged', { uncommitted: 0, commits: 1 }],
				['removed', '485-left', { uncommitted: 0, commits: 0 }],
				['removed', 'removed-ahead', { uncommitted: 0, commits: 1 }],
				['removed', 'removed-clean', { uncommitted: 0, commits: 0 }],
				['removed', 'removed-dirty', { uncommitted: 1, commits: 0 }],
				['review', '482-rate-limit', { uncommitted: 0, commits: 0 }],
				['review', '484-new', { uncommitted: 0, commits: 0 }],
			],
			offered: [
				['mergedWorktree', 'merged'],
				['removedWorktree', '485-left'],
				['removedWorktree', 'removed-clean'],
				['reviewWorktree', '482-rate-limit'],
				['reviewWorktree', '484-new'],
			],
		});
	});
});

describe('folders a removal left behind', () => {
	/** A folder as git leaves it when something still wrote there: files, and no checkout. */
	async function halfRemoved(folder: string): Promise<string> {
		await fs.mkdir(path.join(folder, 'node_modules'), { recursive: true });
		await fs.writeFile(path.join(folder, 'node_modules', 'index.js'), 'x'.repeat(100));
		return folder;
	}

	it('are offered by Clean Up, with the worktrees of threads no agent has any more, and never a checkout its repository forgot', async () => {
		const single = await halfRemoved(path.join(home, '.geminicode', 'worktrees', 'shop', 'half'));
		const thread = await halfRemoved(path.join(allThreadsHome(home), 'project', 'half-thread'));
		// A thread in two repositories whose agent is gone: its worktree is whole, with nothing of its own.
		const whole = await createWorktreeAt(repo, 'gemini/whole', path.join(allThreadsHome(home), 'project', 'whole', 'shop'));
		// Its repository forgot it, but its files and its .git are there: it may hold work.
		const forgotten = await createWorktree(repo, 'gemini/forgotten', '', home);
		await fs.writeFile(path.join(forgotten.folder, 'work.ts'), 'work\n');
		await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(forgotten.folder)), { recursive: true });
		// An agent's own folders are never offered, whatever they hold.
		const owned = await halfRemoved(path.join(allThreadsHome(home), 'project', 'owned'));
		const records = [record('owner', { worktree: { folder: owned, cwd: owned, branch: 'gemini/owned', base: 'main' } })];
		const candidates = await cleanupWorktrees({ records, repositoryOf: async () => repo, running: () => false, reviewing: () => false }, home);
		const plan = await cleanupPlan({ globalStorage: path.join(root, 'global'), agents: new Set(['owner']), merged: new Set(), keepLogsDays: 90, now: new Date(), running: () => true, worktrees: candidates });
		const offered = plan.filter(item => item.area === 'worktrees');
		const failed = await runCleanup(offered, (repository, worktree) => removeWorktree(repository, worktree, false, home));
		expect({
			offered: offered.map(item => [item.reason, path.relative(home, item.path), !!item.worktree]).sort(),
			failed,
			left: await Promise.all([single, thread, whole.folder, forgotten.folder, owned].map(pathExists)),
		}).toEqual({
			offered: [
				['leftoverFolder', path.join('.geminicode', 'threads', 'project', 'half-thread'), false],
				['leftoverFolder', path.join('.geminicode', 'worktrees', 'shop', 'half'), false],
				['removedWorktree', path.join('.geminicode', 'threads', 'project', 'whole', 'shop'), true],
			],
			failed: [],
			left: [false, false, false, true, true],
		});
	});

	it('are remembered and deleted at the next start, unless an agent has the folder again or it holds a checkout', async () => {
		const file = path.join(root, 'global', 'leftover-folders.json');
		const gone = await halfRemoved(path.join(home, '.geminicode', 'worktrees', 'shop', 'gone'));
		const taken = await halfRemoved(path.join(home, '.geminicode', 'worktrees', 'shop', 'taken'));
		const checkout = await createWorktree(repo, 'gemini/again', '', home);
		const outside = await halfRemoved(path.join(root, 'elsewhere'));
		for (const folder of [gone, gone, taken, checkout.folder, outside, path.join(home, '.geminicode', 'worktrees', 'shop', 'never-there')]) {
			await rememberLeftover(file, folder);
		}
		const listed = JSON.parse(await fs.readFile(file, 'utf8'));
		const still = await retryLeftovers(file, [taken], home);
		expect({
			listed: listed.length,
			still,
			left: await Promise.all([gone, taken, checkout.folder, outside].map(pathExists)),
			file: await pathExists(file),
			again: await retryLeftovers(file, [], home),
		}).toEqual({ listed: 5, still: [], left: [false, true, true, true], file: false, again: [] });
	});
});

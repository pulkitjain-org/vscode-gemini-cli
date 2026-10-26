/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../src/acp/agents';
import { cleanupPlan } from '../../src/acp/storageUsage';
import { cleanupWorktrees } from '../../src/acp/worktreeCleanup';
import { commitAll, createWorktree, git, mergeBranch } from '../../src/acp/worktrees';

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
		const running = await createWorktree(repo, 'gemini/running', '', home);
		const removedClean = await createWorktree(repo, 'gemini/removed-clean', '', home);
		const removedAhead = await createWorktree(repo, 'gemini/removed-ahead', '', home);
		await fs.writeFile(path.join(removedAhead.folder, 'c.ts'), 'c\n');
		await commitAll(removedAhead.folder, 'C');
		const removedDirty = await createWorktree(repo, 'gemini/removed-dirty', '', home);
		await fs.writeFile(path.join(removedDirty.folder, 'cart.ts'), 'changed\n');
		const thread = (id: string, worktree: typeof merged) => record(id, { worktree, project: { role: 'thread', coordinator: 'c', byCoordinator: false, resolved: true } });
		const records = [
			thread('merged', merged), thread('unmerged', unmerged), thread('running', running),
			record('reviewer', { worktree: review }), record('reviewing', { worktree: reviewing }),
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
				['removed', 'removed-ahead', { uncommitted: 0, commits: 1 }],
				['removed', 'removed-clean', { uncommitted: 0, commits: 0 }],
				['removed', 'removed-dirty', { uncommitted: 1, commits: 0 }],
				['review', '482-rate-limit', { uncommitted: 0, commits: 0 }],
			],
			offered: [
				['mergedWorktree', 'merged'],
				['removedWorktree', 'removed-clean'],
				['reviewWorktree', '482-rate-limit'],
			],
		});
	});
});

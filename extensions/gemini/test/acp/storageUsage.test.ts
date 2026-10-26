/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { debugLogName } from '../../src/acp/mcpDiagnostics';
import { applyLogRetention, cleanupPlan, keepLogsDays, measureStorage, runCleanup, storageAreas } from '../../src/acp/storageUsage';

describe('storage usage', () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function storage() {
		const root = await mkdtemp(path.join(tmpdir(), 'storage-'));
		dirs.push(root);
		const globalStorage = path.join(root, 'global');
		const put = async (relative: string, text = 'x') => {
			await mkdir(path.dirname(path.join(globalStorage, relative)), { recursive: true });
			await writeFile(path.join(globalStorage, relative), text);
		};
		return { root, globalStorage, put };
	}

	it('measures every area, under global storage and ~/.geminicode', async () => {
		const { root, globalStorage, put } = await storage();
		await put('agents/a.json', '12345');
		await put('checkpoints/a.json', '123');
		const sizes = await measureStorage(storageAreas(globalStorage, root));
		expect(sizes.find(area => area.id === 'chats')?.bytes).toBe(5);
		expect(sizes.find(area => area.id === 'checkpoints')?.bytes).toBe(3);
		expect(sizes.find(area => area.id === 'worktrees')).toMatchObject({ folder: path.join(root, '.geminicode', 'worktrees'), bytes: 0 });
	});

	it('lists what Clean Up would remove, never a worktree with work that is not merged, and removes only that', async () => {
		const { root, globalStorage, put } = await storage();
		await put('agents/kept.json');
		await put('agents/gone.json');
		await put('checkpoints/kept.json');
		await put('checkpoints/merged.json');
		await put('agents/merged.json');
		await put('agents/x.json.broken');
		await put('audit/2026-01-01.jsonl');
		await put('audit/2026-04-29.jsonl');
		await put('pilot/2025-12-31.jsonl');
		await put('traces/geminicode-trace-1.jsonl');
		await put(`cli-logs/${debugLogName()}`);
		await put(`cli-logs/${debugLogName(11)}`);
		await put('cli-debug.log');
		const worktree = (name: string) => ({ folder: path.join(root, name), cwd: path.join(root, name), branch: name, base: 'main' });
		for (const name of ['clean', 'dirty', 'ahead', 'unknown']) {
			await mkdir(path.join(root, name));
		}
		const plan = await cleanupPlan({
			globalStorage,
			agents: new Set(['kept', 'merged']),
			merged: new Set(['merged']),
			keepLogsDays: 90,
			now: new Date('2026-04-30T00:00:00Z'),
			running: () => false,
			worktrees: [
				{ agent: 'merged', repository: '/repo', worktree: worktree('clean'), status: { uncommitted: 0, commits: 0 } },
				{ agent: 'merged', repository: '/repo', worktree: worktree('dirty'), status: { uncommitted: 2, commits: 0 } },
				{ agent: 'merged', repository: '/repo', worktree: worktree('ahead'), status: { uncommitted: 0, commits: 1 } },
				{ agent: 'merged', repository: '/repo', worktree: worktree('unknown'), status: undefined },
			],
		});
		expect(plan.map(item => [item.area, path.relative(root, item.path), item.reason]).sort()).toEqual([
			['auditLog', 'global/audit/2026-01-01.jsonl', 'oldLog'],
			['chats', 'global/agents/gone.json', 'orphaned'],
			['chats', 'global/agents/x.json.broken', 'broken'],
			['checkpoints', 'global/checkpoints/merged.json', 'merged'],
			['cliLogs', 'global/cli-debug.log', 'oldDebugLog'],
			['cliLogs', `global/cli-logs/${debugLogName(11)}`, 'oldDebugLog'],
			['pilotLog', 'global/pilot/2025-12-31.jsonl', 'oldLog'],
			['traces', 'global/traces/geminicode-trace-1.jsonl', 'trace'],
			['worktrees', 'clean', 'mergedWorktree'],
		]);
		const removedWorktrees: string[] = [];
		expect(await runCleanup(plan, async (_repository, tree) => void removedWorktrees.push(tree.folder))).toEqual([]);
		expect(removedWorktrees).toEqual([path.join(root, 'clean')]);
		expect((await readdir(path.join(globalStorage, 'agents'))).sort()).toEqual(['kept.json', 'merged.json']);
		expect(await readdir(path.join(globalStorage, 'checkpoints'))).toEqual(['kept.json']);
	});

	it('keeps the logs for the days set, at least a week, or forever with 0', async () => {
		const { globalStorage, put } = await storage();
		await put('audit/2026-01-01.jsonl');
		await put('audit/2026-04-29.jsonl');
		await put('pilot/2026-01-02.jsonl');
		expect(await applyLogRetention(globalStorage, 0, new Date('2026-04-30T00:00:00Z'))).toBe(0);
		expect(await applyLogRetention(globalStorage, 90, new Date('2026-04-30T00:00:00Z'))).toBe(2);
		expect(await readdir(path.join(globalStorage, 'audit'))).toEqual(['2026-04-29.jsonl']);
		expect([undefined, 90, 3, 0, -1, 30.5, 'x'].map(keepLogsDays)).toEqual([90, 90, 7, 0, 0, 30, 90]);
	});
});

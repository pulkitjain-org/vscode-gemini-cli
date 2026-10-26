/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRecord, AgentTried, TriedRepo } from '../../src/acp/agents';
import { afterTakeBack, changedKeys, discardOffer, editsToSend, foldersMoved, keptRepo, paused, settleConflicts, takeBackTree, triedPaths, withProblems } from '../../src/acp/tryState';

const repo: TriedRepo = { key: '', repository: '/work/shop', worktree: '/threads/fix', base: 'base', start: 'c0', tree: 'tree', files: ['src/cart.ts', 'src/tax.ts'] };

describe('tryState', () => {
	it('takes back to the base, to what was kept, or to either with the edits the user sent', () => {
		expect([
			takeBackTree(repo),
			takeBackTree({ ...repo, kept: 'kept' }),
			takeBackTree({ ...repo, kept: 'kept', back: 'kept+edits' }),
			takeBackTree({ ...repo, back: 'base+edits' }),
		]).toEqual(['base', 'kept', 'kept+edits', 'base+edits']);
	});

	it('leaves nothing after Take Back, or the kept part with the sent edits, or the repositories it didn\'t reach', () => {
		const tried: AgentTried = { state: 'trying', repos: [repo], at: 1, updates: 2 };
		const kept: AgentTried = { state: 'trying', repos: [{ ...repo, kept: 'kept', back: 'kept+edits', applied: 'applied', conflicts: ['src/cart.ts'] }], at: 1 };
		const two: AgentTried = { state: 'trying', repos: [{ ...repo, key: 'shop' }, { ...repo, key: 'api', repository: '/work/api' }], at: 1 };
		expect([
			afterTakeBack(tried, new Set(['']), 5),
			afterTakeBack(kept, new Set(['']), 5),
			afterTakeBack(two, new Set(['shop']), 5),
		]).toEqual([
			undefined,
			{ state: 'kept', repos: [{ key: '', repository: '/work/shop', worktree: '/threads/fix', base: 'base', start: 'c0', tree: 'kept+edits', files: ['src/cart.ts', 'src/tax.ts'] }], at: 5 },
			{ state: 'trying', repos: [{ ...repo, key: 'api', repository: '/work/api' }], at: 5 },
		]);
	});

	it('keeps a repository\'s trees and files, and drops what only an update needs', () => {
		expect(keptRepo({ ...repo, kept: 'k', applied: 'a', back: 'b', conflicts: ['x'], unmerged: ['y'], deferred: ['z'], mixed: ['w'] })).toEqual(repo);
	});

	it('drops conflicts once their markers are gone and unmerged files once they hold the thread\'s version', () => {
		const stuck = withProblems(repo, { conflicts: ['src/cart.ts', 'src/tax.ts'], unmerged: ['logo.png'], deferred: [] });
		const resolved = settleConflicts(stuck, ['src/tax.ts'], []);
		const clear = settleConflicts(resolved, [], ['logo.png']);
		expect({
			stuck: paused({ state: 'trying', repos: [stuck], at: 0 }),
			unchanged: settleConflicts(stuck, ['src/cart.ts', 'src/tax.ts'], []) === stuck,
			resolved: [resolved.conflicts, resolved.unmerged],
			clear,
			paused: paused({ state: 'trying', repos: [clear], at: 0 }),
		}).toEqual({ stuck: true, unchanged: true, resolved: [['src/tax.ts'], ['logo.png']], clear: repo, paused: false });
	});

	it('sends the files the user edited since Try wrote them, not ones with markers, named by repository in a thread with several', () => {
		expect([
			editsToSend(repo, ['src/cart.ts', 'src/tax.ts'], ['src/tax.ts'], 1),
			editsToSend({ ...repo, key: 'api' }, ['src/cart.ts'], [], 2),
		]).toEqual([['src/cart.ts'], ['api/src/cart.ts']]);
	});

	it('offers Restore without replacing anything only while the folders hold what Discard left', () => {
		expect([
			foldersMoved(['r1', 'r2'], ['r1', 'r2']),
			foldersMoved(['r1', 'r2'], ['r1', 'new']),
			// Unknown either way: nothing to say it moved.
			foldersMoved([undefined, 'r2'], ['x', undefined]),
		]).toEqual([false, true, false]);
	});

	it('offers discarded work as the main button, or from the menu once later turns replaced it', () => {
		const saved = { key: '', folder: '/threads/fix', commit: 'c1', head: 'c0', reset: 'r' };
		expect([discardOffer(undefined), discardOffer([saved]), discardOffer([saved, { ...saved, key: 'api', superseded: true }])]).toEqual([undefined, 'restore', 'menu']);
	});

	it('marks the files being tried, and reports only the ones whose mark changed', () => {
		const agent = (id: string, title: string, tried?: AgentTried): AgentRecord => ({ id, workspaceId: 'w', title, createdAt: 0, updatedAt: 0, ...tried ? { tried } : {} });
		const before = triedPaths([agent('a', 'Fix total', { state: 'trying', repos: [repo], at: 0 }), agent('b', 'Kept', { state: 'kept', repos: [repo], at: 0 })]);
		const after = triedPaths([agent('a', 'Fix total', { state: 'trying', repos: [{ ...repo, files: ['src/cart.ts', 'src/new.ts'] }], at: 0 })]);
		expect({
			before: [...before].map(([file, owner]) => [file, owner.title]),
			changed: changedKeys(before, after),
			same: changedKeys(after, triedPaths([agent('a', 'Fix total', { state: 'trying', repos: [{ ...repo, files: ['src/cart.ts', 'src/new.ts'] }], at: 9 })])),
		}).toEqual({
			before: [[path.resolve('/work/shop/src/cart.ts'), 'Fix total'], [path.resolve('/work/shop/src/tax.ts'), 'Fix total']],
			changed: [path.resolve('/work/shop/src/tax.ts'), path.resolve('/work/shop/src/new.ts')],
			same: [],
		});
	});
});

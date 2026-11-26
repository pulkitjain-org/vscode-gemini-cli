/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../src/acp/agents';
import { canMoveToBranch, moveBranchName, moveChoices, moveNote, moveRefusal, moveSteps } from '../../src/acp/moveToBranch';

const worktree = { folder: '/w/shop/fix', cwd: '/w/shop/fix', branch: 'gemini/fix', base: 'main' };

function record(fields: Partial<AgentRecord> = {}): AgentRecord {
	return { id: 'a', workspaceId: 'w', title: 'Fix the cart', createdAt: 1, updatedAt: 1, ...fields };
}

describe('moveToBranch', () => {
	it('applies to an agent in the user\'s checkout of a Git folder, and says why not otherwise', () => {
		const here = { git: true, busy: false };
		expect([
			moveRefusal(record(), here),
			moveRefusal(undefined, here),
			moveRefusal(record({ project: { role: 'coordinator' } }), here),
			moveRefusal(record({ worktree, repos: [{ ...worktree, key: 'shop', repository: '/w/shop' }] }), here),
			moveRefusal(record({ worktree }), here),
			moveRefusal(record(), { git: false, busy: false }),
			moveRefusal(record(), { git: true, busy: true }),
		]).toEqual([undefined, 'gone', 'project', 'repos', 'ownBranch', 'noGit', 'busy']);
	});

	it('offers it on the row and tab of such an agent whether or not a turn runs, and not elsewhere', () => {
		expect([
			canMoveToBranch(record(), true),
			canMoveToBranch(record({ forkedFrom: { agent: 'p', at: 1, sharedFolder: '/w/shop/other' } }), true),
			canMoveToBranch(record(), false),
			canMoveToBranch(record({ worktree }), true),
			canMoveToBranch(record({ project: { role: 'coordinator' } }), true),
			canMoveToBranch(undefined, true),
		]).toEqual([true, true, false, false, false, false]);
	});

	it('offers Move and undo here only when the agent has changes that can be undone', () => {
		expect([moveChoices(0), moveChoices(2)]).toEqual([['move'], ['move', 'moveAndUndo']]);
	});

	it('moves first, undoes here only when asked, and archives the original last', () => {
		expect([moveSteps('move'), moveSteps('moveAndUndo')]).toEqual([['move', 'archive'], ['move', 'undo', 'archive']]);
	});

	it('names the branch after the agent, under the repository\'s prefix', () => {
		expect([moveBranchName('Fix the cart'), moveBranchName('Fix the cart', 'pj/')]).toEqual(['gemini/fix-the-cart', 'pj/fix-the-cart']);
	});

	it('tells the moved agent where it works now and that the old folder is the user\'s', () => {
		const note = moveNote('/w/shop', '/w/worktrees/shop/gemini/fix-the-cart', 'gemini/fix-the-cart');
		expect(note).toContain('you now work in /w/worktrees/shop/gemini/fix-the-cart');
		expect(note).toContain('never in /w/shop');
	});
});

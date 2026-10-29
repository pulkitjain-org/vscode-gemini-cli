/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentChanges, EditedFile, othersChanging, reviewBase, reviewOrder } from '../../src/acp/agentChanges';
import { diffLines, splitLines } from '../../src/acp/lineDiff';

const root = path.resolve('/work/app');
const file = (name: string) => path.join(root, name);

describe('AgentChanges', () => {
	it('counts lines against the text before the first edit', () => {
		vi.useFakeTimers({ now: 1000 });
		const changes = new AgentChanges(root);
		let fired = 0;
		changes.onDidChange(() => fired++);
		changes.record([{ path: file('a.ts'), oldText: 'one\ntwo', newText: 'one\nTWO' }]);
		changes.record([{ path: file('a.ts'), oldText: 'one\nTWO', newText: 'one\nTWO\nthree' }]);
		vi.useRealTimers();
		expect(changes.files).toEqual([{ path: file('a.ts'), created: false, original: 'one\ntwo', added: 2, removed: 1, agentText: 'one\nTWO\nthree', editedAt: 1000 }]);
		expect(changes.totals).toEqual({ files: 1, added: 2, removed: 1 });
		expect(fired).toBe(2);
	});

	it('marks new files and resolves relative paths against the folder', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: 'src/new.ts', oldText: null, newText: 'a\nb' }, { path: file('b.ts'), oldText: 'x', newText: 'y' }]);
		expect(changes.files.map(f => [f.path, f.created, f.added, f.removed])).toEqual([
			[file('b.ts'), false, 1, 1],
			[file(path.join('src', 'new.ts')), true, 2, 0],
		]);
	});

	it('leaves out the CLI\'s own files, such as Plan mode\'s plans, also when restoring', () => {
		const cliFolder = path.resolve('/home/.gemini/tmp');
		const plan = path.join(cliFolder, 'app', 'session', 'plans', 'plan.md');
		const changes = new AgentChanges(root, cliFolder);
		changes.record([{ path: plan, oldText: null, newText: '# Plan' }, { path: file('a.ts'), oldText: 'x', newText: 'y' }]);
		const restored = new AgentChanges(root, cliFolder);
		let fired = 0;
		restored.onDidChange(() => fired++);
		restored.restore([{ path: plan, created: true, original: '', added: 1, removed: 0 }]);
		expect({ files: changes.files.map(f => f.path), restored: restored.totals, fired }).toEqual({ files: [file('a.ts')], restored: { files: 0, added: 0, removed: 0 }, fired: 1 });
	});

	it('drops files the agent changed back or created and then deleted', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'x', newText: 'y' }, { path: file('tmp.ts'), oldText: '', newText: 'z' }]);
		changes.record([{ path: file('a.ts'), oldText: 'y', newText: 'x' }, { path: file('tmp.ts'), oldText: 'z', newText: '' }]);
		expect(changes.files).toEqual([]);
	});

	it('does not keep very large originals but still counts the file', () => {
		const changes = new AgentChanges(root);
		const big = 'x\n'.repeat(600_000);
		changes.record([{ path: file('big.txt'), oldText: big, newText: `${big}y` }]);
		expect(changes.files[0]).toMatchObject({ added: 1, removed: 1 });
		expect(changes.files[0].original).toBeUndefined();
	});

	it('keeps all texts together under a cap, dropping the largest files\' texts and keeping their counts', () => {
		const changes = new AgentChanges(root);
		const big = 'x\n'.repeat(450_000);
		for (let i = 0; i < 12; i++) {
			changes.record([{ path: file(`big${i}.txt`), oldText: big, newText: `${big}y` }]);
		}
		changes.record([{ path: file('small.ts'), oldText: 'a', newText: 'b' }]);
		const kept = changes.files.reduce((sum, f) => sum + (f.original?.length ?? 0) + (f.agentText?.length ?? 0), 0);
		expect(kept).toBeLessThanOrEqual(8_000_000);
		expect(changes.files).toHaveLength(13);
		expect(changes.files.every(f => f.added >= 1)).toBe(true);
		expect(changes.file(file('small.ts'))?.original).toBe('a');
	});

	it('restores saved files unless edits came first, and skips bad records', () => {
		const changes = new AgentChanges(root);
		changes.restore([{ path: file('a.ts'), created: false, original: 'x', added: 1, removed: 1 }, { path: 'relative.ts', created: false, added: 1, removed: 0 }]);
		expect(changes.files.map(f => f.path)).toEqual([file('a.ts')]);

		const edited = new AgentChanges(root);
		edited.record([{ path: file('b.ts'), oldText: 'x', newText: 'y' }]);
		edited.restore([{ path: file('a.ts'), created: false, original: 'x', added: 1, removed: 1 }]);
		expect(edited.files.map(f => f.path)).toEqual([file('b.ts')]);
	});

	it('clears', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'x', newText: 'y' }]);
		changes.clear();
		expect(changes.totals).toEqual({ files: 0, added: 0, removed: 0 });
	});

	it('clears one folder\'s changes, such as one repository of a thread in several', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('shop/a.ts'), oldText: 'x', newText: 'y' }, { path: file('shopping/b.ts'), oldText: 'x', newText: 'y' }]);
		changes.clear(file('shop'));
		expect(changes.files.map(f => f.path)).toEqual([file('shopping/b.ts')]);
	});
});

describe('AgentChanges.keep', () => {
	it('moves the baseline to what was kept, and forgets the file once all is kept', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'a\nb\nc', newText: 'a\nB\nC' }]);
		changes.keep(file('a.ts'), 'a\nB\nc', 'a\nB\nC');
		expect(changes.file(file('a.ts'))).toMatchObject({ original: 'a\nB\nc', added: 1, removed: 1 });
		changes.keep(file('a.ts'), 'a\nB\nC', 'a\nB\nC');
		expect(changes.files).toEqual([]);
	});
});

describe('the agent\'s own changes', () => {
	/** The hunks Review shows: against the original with later edits in it. */
	const agentHunks = (changes: AgentChanges, name: string, current: string) => {
		const base = reviewBase(changes.file(file(name))!, current)!;
		return { foreign: base.foreign, hunks: diffLines(splitLines(base.base), splitLines(current)).map(h => splitLines(current).slice(h.modifiedStart, h.modifiedEnd)) };
	};

	it('does not count lines the user typed after the agent as its changes', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'a\nb\nc\nd\ne', newText: 'a\nB\nc\nd\ne' }]);
		expect(agentHunks(changes, 'a.ts', 'a\nB\nc\nd\ne')).toEqual({ foreign: false, hunks: [['B']] });
		// The user changes another line, and adds one right after the agent's.
		expect(agentHunks(changes, 'a.ts', 'a\nB\nmine\nc\nd\nE')).toEqual({ foreign: true, hunks: [['B']] });
	});

	it('takes the user\'s edits between two of the agent\'s out of its changes', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'a\nb\nc', newText: 'A\nb\nc' }]);
		// The user edits c; the agent then edits b, reading the file with the user's edit.
		changes.record([{ path: file('a.ts'), oldText: 'A\nb\nmine', newText: 'A\nB\nmine' }]);
		expect(changes.file(file('a.ts'))).toMatchObject({ original: 'a\nb\nmine', added: 2, removed: 2 });
		expect(agentHunks(changes, 'a.ts', 'A\nB\nmine')).toEqual({ foreign: false, hunks: [['A', 'B']] });
	});

	it('keeps an edit inside the agent\'s lines with the agent\'s change', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'a\nb\nc', newText: 'a\nB\nc' }]);
		expect(agentHunks(changes, 'a.ts', 'a\nB2\nc')).toEqual({ foreign: true, hunks: [['B2']] });
	});

	it('makes the remaining changes the agent\'s text once some are kept', () => {
		const changes = new AgentChanges(root);
		changes.record([{ path: file('a.ts'), oldText: 'a\nb\nc', newText: 'A\nb\nC' }]);
		changes.keep(file('a.ts'), 'A\nb\nc', 'A\nb\nC');
		expect(changes.file(file('a.ts'))).toMatchObject({ original: 'A\nb\nc', agentText: 'A\nb\nC' });
		expect(agentHunks(changes, 'a.ts', 'A\nb\nC')).toEqual({ foreign: false, hunks: [['C']] });
	});

	it('settles committed files', () => {
		const changes = new AgentChanges(root);
		let fired = 0;
		changes.onDidChange(() => fired++);
		changes.record([{ path: file('a.ts'), oldText: 'x', newText: 'y' }, { path: file('b.ts'), oldText: 'x', newText: 'y' }]);
		changes.settle([file('a.ts'), file('other.ts')]);
		changes.settle([file('other.ts')]);
		expect([changes.files.map(f => f.path), fired]).toEqual([[file('b.ts')], 2]);
	});

	it('reviews first the agent whose text the file has, then the latest to edit it', () => {
		const at = (name: string, editedAt: number, agentText?: string) => ({ name, file: { path: file('a.ts'), created: false, original: '', added: 1, removed: 0, editedAt, ...agentText === undefined ? {} : { agentText } } satisfies EditedFile });
		expect(reviewOrder([at('first', 1), at('second', 2)], 'now').map(c => c.name)).toEqual(['second', 'first']);
		expect(reviewOrder([at('first', 1, 'now'), at('second', 2, 'then')], 'now').map(c => c.name)).toEqual(['first', 'second']);
	});

	it('finds the other agents changing a file', () => {
		const mine = new AgentChanges(root);
		const theirs = new AgentChanges(root);
		const idle = new AgentChanges(root);
		mine.record([{ path: file('a.ts'), oldText: 'x', newText: 'y' }]);
		theirs.record([{ path: file('a.ts'), oldText: 'y', newText: 'z' }]);
		const sources = [{ id: 'mine', changes: mine }, { id: 'theirs', changes: theirs }, { id: 'idle', changes: idle }];
		expect(othersChanging(file('a.ts'), sources, mine).map(s => s.id)).toEqual(['theirs']);
		expect(othersChanging(file('b.ts'), sources, mine)).toEqual([]);
	});
});

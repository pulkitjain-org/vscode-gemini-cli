/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentChanges } from '../../src/acp/agentChanges';

const root = path.resolve('/work/app');
const file = (name: string) => path.join(root, name);

describe('AgentChanges', () => {
	it('counts lines against the text before the first edit', () => {
		const changes = new AgentChanges(root);
		let fired = 0;
		changes.onDidChange(() => fired++);
		changes.record([{ path: file('a.ts'), oldText: 'one\ntwo', newText: 'one\nTWO' }]);
		changes.record([{ path: file('a.ts'), oldText: 'one\nTWO', newText: 'one\nTWO\nthree' }]);
		expect(changes.files).toEqual([{ path: file('a.ts'), created: false, original: 'one\ntwo', added: 2, removed: 1 }]);
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

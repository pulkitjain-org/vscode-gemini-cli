/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Checkpoints } from '../../src/acp/checkpoints';

const root = path.resolve('/work/app');
const file = (name: string) => path.join(root, name);

describe('Checkpoints', () => {
	it('keeps each file as it was before the turn first edited it', () => {
		const checkpoints = new Checkpoints(root);
		checkpoints.beginTurn();
		checkpoints.record([{ path: 'a.ts', oldText: 'one', newText: 'two' }]);
		checkpoints.record([{ path: 'a.ts', oldText: 'two', newText: 'three' }, { path: 'new.ts', oldText: null, newText: 'x' }]);
		expect(checkpoints.running).toBe(2);
		expect(checkpoints.endTurn('t1')).toEqual({ undoable: true, dropped: [] });
		expect(checkpoints.fileCount('t1')).toBe(2);
		expect(checkpoints.plan('t1')).toEqual({
			restores: [
				{ path: file('a.ts'), text: 'one', agentText: 'three' },
				{ path: file('new.ts'), text: undefined, agentText: 'x' },
			],
			laterTurns: 0,
		});
	});

	it('undoes later turns along with an earlier one, back to the earliest text', () => {
		const checkpoints = new Checkpoints(root);
		checkpoints.beginTurn();
		checkpoints.record([{ path: 'a.ts', oldText: 'v0', newText: 'v1' }]);
		checkpoints.endTurn('t1');
		checkpoints.beginTurn();
		checkpoints.record([{ path: 'a.ts', oldText: 'v1', newText: 'v2' }, { path: 'b.ts', oldText: 'b0', newText: 'b1' }]);
		checkpoints.endTurn('t2');
		expect(checkpoints.plan('t1')?.restores).toEqual([
			{ path: file('a.ts'), text: 'v0', agentText: 'v2' },
			{ path: file('b.ts'), text: 'b0', agentText: 'b1' },
		]);
		expect(checkpoints.plan('t1')?.laterTurns).toBe(1);
		expect(checkpoints.undone('t2')).toEqual(['t2']);
		// After undoing t2, a.ts is what t1 left, so undoing t1 sees no outside change.
		expect(checkpoints.plan('t1')?.restores).toEqual([{ path: file('a.ts'), text: 'v0', agentText: 'v1' }]);
	});

	it('keeps nothing for turns without edits, and nothing while a turn runs', () => {
		const checkpoints = new Checkpoints(root);
		checkpoints.beginTurn();
		expect(checkpoints.endTurn('t1')).toEqual({ undoable: false, dropped: [] });
		expect(checkpoints.plan('t1')).toBeUndefined();
		checkpoints.beginTurn();
		checkpoints.record([{ path: 'a.ts', oldText: 'x', newText: 'y' }]);
		checkpoints.endTurn('t2');
		checkpoints.beginTurn();
		expect(checkpoints.plan('t2')).toBeUndefined();
	});

	it('drops the oldest turns and turns too large to keep', () => {
		const checkpoints = new Checkpoints(root, { maxTurns: 2, maxTurnBytes: 10 });
		for (const id of ['t1', 't2', 't3']) {
			checkpoints.beginTurn();
			checkpoints.record([{ path: `${id}.ts`, oldText: 'x', newText: 'y' }]);
			const ended = checkpoints.endTurn(id);
			expect(ended.dropped).toEqual(id === 't3' ? ['t1'] : []);
		}
		expect(checkpoints.canUndo('t1')).toBe(false);
		expect(checkpoints.canUndo('t2')).toBe(true);
		checkpoints.beginTurn();
		checkpoints.record([{ path: 'big.ts', oldText: 'x'.repeat(11), newText: 'y' }]);
		expect(checkpoints.endTurn('t4').undoable).toBe(false);
		// An earlier turn cannot be undone past one that was not kept in full.
		expect(checkpoints.canUndo('t3')).toBe(false);
	});
});

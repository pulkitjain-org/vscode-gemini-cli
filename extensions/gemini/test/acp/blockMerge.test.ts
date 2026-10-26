/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { AdfNode } from '../../src/acp/confluence';
import { blockChanges, mergeBlocks, type BlockPart } from '../../src/acp/blockMerge';

const p = (text: string): AdfNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const blocks = (...texts: string[]) => texts.map(p);
const texts = (nodes: readonly AdfNode[]) => nodes.map(n => n.content?.[0]?.text);
/** The parts as text: a kept block as itself, a change as `removed -> added` at its place. */
const shown = (parts: readonly BlockPart[]) => parts.map(part => part.kind === 'same' ? `${part.at}:${texts([part.node])}` : `${part.at}:[${texts(part.removed)}]->[${texts(part.added)}]`);

describe('mergeBlocks', () => {
	it('keeps both sides\' changes to different blocks', () => {
		const result = mergeBlocks(blocks('A', 'B', 'C'), blocks('A', 'B2', 'C'), blocks('A', 'B', 'C', 'D'));
		expect([texts(result.merged), result.conflicts]).toEqual([['A', 'B2', 'C', 'D'], []]);
	});

	it('lists a block both sides changed, keeping theirs in place', () => {
		const result = mergeBlocks(blocks('A', 'B', 'C'), blocks('A', 'B theirs', 'C'), blocks('A', 'B mine', 'C'));
		expect([texts(result.merged), result.conflicts.map(c => ({ at: c.at, theirs: texts(c.theirs), mine: texts(c.mine) }))]).toEqual([
			['A', 'B theirs', 'C'],
			[{ at: 1, theirs: ['B theirs'], mine: ['B mine'] }],
		]);
	});

	it('takes the same change on both sides once', () => {
		const result = mergeBlocks(blocks('A', 'B'), blocks('A', 'B2'), blocks('A', 'B2'));
		expect([texts(result.merged), result.conflicts.length]).toEqual([['A', 'B2'], 0]);
	});

	it('carries insertions and deletions from both sides, and places a conflict after them', () => {
		// Theirs added X at the top, deleted B and rewrote F; mine deleted D, added Y and rewrote F too.
		const result = mergeBlocks(blocks('A', 'B', 'C', 'D', 'E', 'F'), blocks('X', 'A', 'C', 'D', 'E', 'F theirs'), blocks('A', 'B', 'C', 'E', 'Y', 'F mine'));
		expect([texts(result.merged), result.conflicts.map(c => ({ at: c.at, theirs: texts(c.theirs), mine: texts(c.mine) }))]).toEqual([
			['X', 'A', 'C', 'E', 'F theirs'],
			[{ at: 4, theirs: ['F theirs'], mine: ['Y', 'F mine'] }],
		]);
	});
});

describe('blockChanges', () => {
	it('splits the draft into kept blocks and changes, with keys that stay put', () => {
		const base = blocks('A', 'B', 'C', 'D');
		const parts = blockChanges(base, blocks('A', 'B2', 'C', 'D', 'E'));
		const again = blockChanges(base, blocks('A', 'B2', 'C', 'D', 'E'));
		const keys = (all: readonly BlockPart[]) => all.flatMap(part => part.kind === 'change' ? [part.key] : []);
		expect({ shown: shown(parts), same: keys(parts).join() === keys(again).join(), distinct: new Set(keys(parts)).size }).toEqual({
			shown: ['0:A', '1:[B]->[B2]', '2:C', '3:D', '4:[]->[E]'],
			same: true,
			distinct: 2,
		});
	});

	it('marks deletions at the start and the end', () => {
		expect(shown(blockChanges(blocks('A', 'B', 'C'), blocks('B')))).toEqual(['0:[A]->[]', '1:B', '2:[C]->[]']);
	});
});

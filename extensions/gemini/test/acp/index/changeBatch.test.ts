/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChangeBatch, maxBatchPaths } from '../../../src/acp/index/changeBatch';

describe('ChangeBatch', () => {
	it('passes on a few changed paths, and asks for a reconcile past what the indexer applies one by one', () => {
		const few = new ChangeBatch();
		['a.ts', 'b.ts', 'a.ts'].forEach(p => few.add(p));
		const many = new ChangeBatch();
		for (let i = 0; i < 100_000; i++) {
			many.add(`f${i}.ts`);
		}
		const edge = new ChangeBatch();
		for (let i = 0; i < maxBatchPaths - 1; i++) {
			edge.add(`f${i}.ts`);
		}
		expect([few.changed, many.changed, edge.changed?.length]).toEqual([['a.ts', 'b.ts'], undefined, 300]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { mapLimit } from '../../src/acp/concurrency';

describe('mapLimit', () => {
	it('runs at most the limit at a time and keeps the items\' order', async () => {
		let running = 0;
		let most = 0;
		const results = await mapLimit([5, 1, 4, 2, 3], 2, async (item, index) => {
			running++;
			most = Math.max(most, running);
			await new Promise(resolve => setTimeout(resolve, item));
			running--;
			return `${index}:${item}`;
		});
		expect(results).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3']);
		expect(most).toBe(2);
	});

	it('handles no items and a limit past the count', async () => {
		expect(await mapLimit([], 4, async () => 1)).toEqual([]);
		expect(await mapLimit([1, 2], 16, async item => item * 2)).toEqual([2, 4]);
	});

	it('rejects with the first failure', async () => {
		await expect(mapLimit([1, 2, 3], 2, async item => {
			if (item === 2) {
				throw new Error('two');
			}
			return item;
		})).rejects.toThrow('two');
	});
});

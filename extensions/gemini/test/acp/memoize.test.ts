/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { memoizeAsync } from '../../src/acp/memoize';

describe('memoizeAsync', () => {
	it('runs the lookup once per key while fresh, and again after it expires', async () => {
		let time = 0;
		const calls: string[] = [];
		const lookup = memoizeAsync(async (key: string) => {
			calls.push(key);
			return key.length;
		}, { ttlMs: 100, maxEntries: 10, now: () => time });
		expect(await Promise.all([lookup('a'), lookup('a'), lookup('bb')])).toEqual([1, 1, 2]);
		expect(calls).toEqual(['a', 'bb']);
		time = 150;
		await lookup('a');
		expect(calls).toEqual(['a', 'bb', 'a']);
	});

	it('does not keep failures and evicts the oldest entries', async () => {
		let fail = true;
		const calls: string[] = [];
		const lookup = memoizeAsync(async (key: string) => {
			calls.push(key);
			if (fail) {
				throw new Error('boom');
			}
			return key;
		}, { ttlMs: 1000, maxEntries: 2 });
		await expect(lookup('a')).rejects.toThrow('boom');
		fail = false;
		expect(await lookup('a')).toBe('a');
		await lookup('b');
		await lookup('c');
		await lookup('a');
		expect(calls).toEqual(['a', 'a', 'b', 'c', 'a']);
	});
});

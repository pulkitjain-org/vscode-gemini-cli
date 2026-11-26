/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { BoundedStore, diffBytes, textBytes, ToolOutputStore, trimOutput } from '../../src/acp/chatMemory';

describe('BoundedStore', () => {
	it('drops the oldest values once over its bytes or its count, and keeps nothing larger than the cap', () => {
		const store = new BoundedStore<string, string>(20, textBytes, 3);
		store.set('a', 'aaaa');
		store.set('b', 'bbbb');
		// Setting again makes it the newest.
		store.set('a', 'aaaa');
		// 8 + 8 + 8 bytes is over 20: the oldest, b, goes.
		store.set('c', 'cccc');
		const afterBytes = { keys: ['a', 'b', 'c'].filter(key => store.get(key) !== undefined), bytes: store.bytes };
		const kept = store.set('huge', 'x'.repeat(11));
		const counted = new BoundedStore<number, string>(1000, textBytes, 3);
		for (let i = 0; i < 5; i++) {
			counted.set(i, 'v');
		}
		store.clear();
		expect({ afterBytes, kept, counted: [counted.size, counted.get(0), counted.get(4)], cleared: [store.size, store.bytes] }).toEqual({
			afterBytes: { keys: ['a', 'c'], bytes: 16 },
			kept: false,
			counted: [3, undefined, 'v'],
			cleared: [0, 0],
		});
	});

	it('caps a chat\'s proposed edits by their text before and after', () => {
		const diff = (n: number) => [{ type: 'diff' as const, path: 'a', oldText: 'x'.repeat(n), newText: 'y'.repeat(n) }];
		expect(diffBytes(diff(10))).toBe(2 + 40);
		const store = new BoundedStore(20 * 1024 * 1024, diffBytes, 200);
		// 200 edits to a 1 MB file once held about 400 MB; now the newest that fit in 20 MB.
		for (let i = 0; i < 200; i++) {
			store.set(`tool-${i}`, diff(1024 * 1024 / 2));
		}
		expect(store.bytes).toBeLessThanOrEqual(20 * 1024 * 1024);
		expect([store.size, store.get('tool-199') !== undefined, store.get('tool-0')]).toEqual([9, true, undefined]);
	});
});

describe('trimOutput and ToolOutputStore', () => {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

	it('shows output up to 80 lines whole, and longer output as its first and last 20 lines', () => {
		expect(trimOutput(lines(80))).toEqual({ head: lines(80), tail: '', hiddenLines: 0 });
		const long = trimOutput(lines(100));
		expect({ head: long.head.split('\n').at(-1), tail: long.tail.split('\n')[0], hidden: long.hiddenLines }).toEqual({ head: 'line 20', tail: 'line 81', hidden: 60 });
	});

	it('keeps long output whole for Show All, within its cap, oldest dropped first', () => {
		const store = new ToolOutputStore(textBytes(lines(100)) * 2);
		expect(store.put('tool-1', 0, lines(10)).hiddenLines).toBe(0);
		store.put('tool-2', 0, lines(100));
		store.put('tool-3', 1, lines(100));
		store.put('tool-4', 0, lines(100));
		expect([store.get('tool-1', 0), store.get('tool-2', 0), store.get('tool-3', 1), store.get('tool-4', 0)]).toEqual([undefined, undefined, lines(100), lines(100)]);
		// Output that became short is not kept.
		store.put('tool-4', 0, 'done');
		expect(store.get('tool-4', 0)).toBeUndefined();
	});
});

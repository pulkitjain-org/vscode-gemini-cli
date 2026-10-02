/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBatcher } from '../../src/acp/updateBatcher';

describe('UpdateBatcher', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function create() {
		const sent: string[][] = [];
		const batcher = new UpdateBatcher<{ id: string; text: string }>(items => sent.push(items.map(i => `${i.id}=${i.text}`)), 30);
		return { batcher, sent };
	}

	it('sends the first update at once and coalesces the rest of a burst', () => {
		const { batcher, sent } = create();
		batcher.push({ id: 'a', text: 'H' });
		expect(sent).toEqual([['a=H']]);
		batcher.push({ id: 'a', text: 'He' });
		batcher.push({ id: 'b', text: 'x' });
		batcher.push({ id: 'a', text: 'Hello' });
		expect(sent).toHaveLength(1);
		vi.advanceTimersByTime(30);
		expect(sent).toEqual([['a=H'], ['a=Hello', 'b=x']]);
	});

	it('goes back to sending at once after a quiet interval', () => {
		const { batcher, sent } = create();
		batcher.push({ id: 'a', text: '1' });
		vi.advanceTimersByTime(30);
		vi.advanceTimersByTime(30);
		batcher.push({ id: 'a', text: '2' });
		expect(sent).toEqual([['a=1'], ['a=2']]);
	});

	it('flushes on demand and can drop pending updates', () => {
		const { batcher, sent } = create();
		batcher.push({ id: 'a', text: '1' });
		batcher.push({ id: 'a', text: '2' });
		batcher.flush();
		batcher.push({ id: 'a', text: '3' });
		batcher.clear();
		vi.advanceTimersByTime(100);
		expect(sent).toEqual([['a=1'], ['a=2']]);
		batcher.dispose();
	});
});

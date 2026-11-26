/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayTracker } from '../../src/acp/replayTracker';

describe('ReplayTracker', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	async function settled(promise: Promise<void> | undefined): Promise<boolean> {
		let done = false;
		void promise?.then(() => done = true);
		await vi.advanceTimersByTimeAsync(0);
		return done;
	}

	it('ends once the counted updates came, however long they pause', async () => {
		const tracker = new ReplayTracker(250, 3_000);
		tracker.begin(Promise.resolve(3));
		await vi.advanceTimersByTimeAsync(0);
		const done = tracker.done;
		tracker.received();
		tracker.received();
		await vi.advanceTimersByTimeAsync(2_000);
		expect({ active: tracker.active, done: await settled(done) }).toEqual({ active: true, done: false });
		tracker.received();
		expect({ active: tracker.active, done: await settled(done) }).toEqual({ active: false, done: true });
	});

	it('ends an uncounted replay after a quiet spell, and a miscounted one after a longer spell', async () => {
		const tracker = new ReplayTracker(250, 3_000);
		tracker.begin(Promise.resolve(undefined));
		const done = tracker.done;
		await vi.advanceTimersByTimeAsync(0);
		tracker.received();
		await vi.advanceTimersByTimeAsync(249);
		expect(tracker.active).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect({ active: tracker.active, done: await settled(done) }).toEqual({ active: false, done: true });

		tracker.begin(Promise.resolve(5));
		await vi.advanceTimersByTimeAsync(0);
		tracker.received();
		await vi.advanceTimersByTimeAsync(2_999);
		expect(tracker.active).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(tracker.active).toBe(false);
	});

	it('waits for the count before ending, and a new replay ends the old one', async () => {
		const tracker = new ReplayTracker(250, 3_000);
		let count!: (n: number) => void;
		tracker.begin(new Promise(resolve => count = resolve));
		const first = tracker.done;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(tracker.active).toBe(true);
		tracker.begin(Promise.resolve(0));
		expect(await settled(first)).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(tracker.active).toBe(false);
		count(1);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StallWatch, TurnStall } from '../../src/acp/stallWatch';

describe('StallWatch', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => vi.useRealTimers());

	function watch(afterMs = 1_000) {
		let running = true;
		const stalls: (TurnStall | undefined)[] = [];
		const watch = new StallWatch(afterMs, () => running, Date.now);
		watch.onDidChange(stall => stalls.push(stall));
		return { watch, stalls, stop: () => running = false };
	}

	it('reports a turn with no update for the time given, and clears it on the next update', () => {
		const { watch: w, stalls } = watch();
		w.begin();
		vi.advanceTimersByTime(999);
		expect(stalls).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(stalls).toEqual([{ since: 0 }]);
		vi.setSystemTime(1_500);
		w.noteActivity();
		expect(stalls.at(-1)).toBeUndefined();
		expect(w.stall).toBeUndefined();
		// Quiet again from the last update, not from the start.
		vi.advanceTimersByTime(1_000);
		expect(stalls.at(-1)).toEqual({ since: 1_500 });
		w.end();
		expect(stalls.at(-1)).toBeUndefined();
	});

	it('is not a stall while a tool runs or a question for the user is open', () => {
		const { watch: w, stalls } = watch();
		w.begin();
		w.toolCall('t1', 'in_progress', true);
		vi.advanceTimersByTime(3_000);
		expect(stalls).toEqual([]);
		w.toolCall('t1', 'completed', false);
		vi.advanceTimersByTime(1_000);
		expect(stalls).toEqual([{ since: 0 }]);
		w.end();
		w.begin();
		w.waitBegin();
		vi.advanceTimersByTime(3_000);
		expect(stalls.filter(Boolean)).toHaveLength(1);
		w.waitEnd();
		vi.advanceTimersByTime(1_000);
		expect(stalls.filter(Boolean)).toHaveLength(2);
	});

	it('carries the CLI\'s last retry with the stall, and counts nothing while no turn runs', () => {
		const { watch: w, stalls, stop } = watch();
		w.begin();
		vi.advanceTimersByTime(1_000);
		w.retry({ attempt: 2, status: 503 });
		expect(stalls.at(-1)).toEqual({ since: 0, retry: { attempt: 2, status: 503 } });
		stop();
		w.noteActivity();
		w.retry({ attempt: 3, status: 503 });
		expect(stalls).toHaveLength(2);
		w.dispose();
	});
});

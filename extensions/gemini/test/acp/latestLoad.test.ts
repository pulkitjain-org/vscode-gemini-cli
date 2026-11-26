/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { LatestLoad } from '../../src/acp/latestLoad';

describe('LatestLoad', () => {
	it('reads one at a time, drops a superseded read, and resolves each call with the newest state', async () => {
		let stored = 'a';
		let running = 0;
		let overlapped = 0;
		const reads: string[] = [];
		const applied: string[] = [];
		const loader = new LatestLoad(async () => {
			running++;
			overlapped = Math.max(overlapped, running);
			const value = stored;
			reads.push(value);
			await new Promise(resolve => setTimeout(resolve, 5));
			running--;
			return value;
		}, value => applied.push(value));
		const first = loader.load();
		await new Promise(resolve => setTimeout(resolve, 1));
		stored = 'b';
		// Asked for while the first reads: the first's answer ('a') is dropped, and one more read gets 'b'.
		const second = loader.load();
		const third = loader.load();
		const seenByFirst = await first.then(() => applied.at(-1));
		await Promise.all([second, third]);
		expect({ reads, applied, overlapped, seenByFirst }).toEqual({ reads: ['a', 'b'], applied: ['b'], overlapped: 1, seenByFirst: 'b' });
	});

	it('passes a failed read to its caller and goes on with the next', async () => {
		let fail = true;
		const applied: number[] = [];
		const loader = new LatestLoad(async () => {
			if (fail) {
				throw new Error('keychain locked');
			}
			return 1;
		}, value => applied.push(value));
		const failed = await loader.load().then(() => 'ok', (err: Error) => err.message);
		fail = false;
		await loader.load();
		expect({ failed, applied }).toEqual({ failed: 'keychain locked', applied: [1] });
	});
});

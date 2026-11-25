/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { renderGap } from '../../webview-src/streaming';

describe('how often a streamed reply\'s unfinished tail is drawn', () => {
	it('is every update while the tail is short and draws are quick', () => {
		expect([renderGap(200, undefined), renderGap(3_000, 1), renderGap(3_000, 3.9)]).toEqual([0, 0, 0]);
	});

	it('waits for a long tail, as before', () => {
		expect([renderGap(4_001, undefined), renderGap(4_001, 2)]).toEqual([150, 150]);
	});

	it('follows what the last draw cost, so drawing takes about a fifth of the time', () => {
		expect([renderGap(2_000, 10), renderGap(20_000, 60), renderGap(20_000, 20)]).toEqual([40, 240, 150]);
	});

	it('never waits more than a second', () => {
		expect(renderGap(500_000, 900)).toBe(1_000);
	});
});

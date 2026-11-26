/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { releaseAfterMs, SharedTab } from '../../src/acp/sharedTab';

describe('SharedTab', () => {
	it('shows one agent at a time, handing back the one it showed before', () => {
		const tab = new SharedTab();
		expect([tab.show('a', 1), tab.show('a', 2), tab.show('b', 3), tab.shown]).toEqual([undefined, undefined, 'a', 'b']);
		// The one it moved on from is without a tab from then.
		expect(tab.dueForRelease(3 + releaseAfterMs)).toEqual(['a']);
	});

	it('makes the shared tab an agent\'s own when it is pinned, so the next click gets a new shared one', () => {
		const tab = new SharedTab();
		tab.show('a', 1);
		tab.pin('a');
		expect([tab.shown, tab.isPinned('a')]).toEqual([undefined, true]);
		expect(tab.show('b', 2)).toBeUndefined();
	});

	it('releases agents without a tab for ten minutes, oldest first, and forgets the ones opened again', () => {
		const tab = new SharedTab();
		tab.pin('a');
		tab.closed('a', 10);
		tab.closed('b', 5);
		tab.show('c', 20);
		tab.show('d', 30);
		expect([tab.isPinned('a'), tab.tracking, tab.dueForRelease(10 + releaseAfterMs - 1)]).toEqual([false, true, ['b']]);
		expect(tab.dueForRelease(30 + releaseAfterMs)).toEqual(['b', 'a', 'c']);
		tab.forget('b');
		tab.show('a', 40);
		expect(tab.dueForRelease(40 + releaseAfterMs)).toEqual(['c', 'd']);
		tab.forget('c');
		tab.forget('d');
		expect(tab.tracking).toBe(false);
	});

	it('clears the shared tab when the agent it shows closes its tab', () => {
		const tab = new SharedTab();
		tab.show('a', 1);
		tab.closed('a', 2);
		expect([tab.shown, tab.dueForRelease(2 + releaseAfterMs)]).toEqual([undefined, ['a']]);
	});
});

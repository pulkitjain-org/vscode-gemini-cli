/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { TextDeltas } from '../../src/acp/textDeltas';

const agent = (text: string): TranscriptItem => ({ id: 'item-1', kind: 'agent', text });

describe('TextDeltas', () => {
	it('sends a reply in full once, then only its new text', () => {
		const deltas = new TextDeltas();
		expect(deltas.toUpdates([agent('Hello')])).toEqual([agent('Hello')]);
		expect(deltas.toUpdates([agent('Hello, wor')])).toEqual([{ kind: 'append', id: 'item-1', append: ', wor' }]);
		expect(deltas.toUpdates([agent('Hello, world')])).toEqual([{ kind: 'append', id: 'item-1', append: 'ld' }]);
	});

	it('appends to thoughts too, but sends other items whole', () => {
		const deltas = new TextDeltas();
		const thought = (text: string): TranscriptItem => ({ id: 'item-2', kind: 'thought', text });
		const user: TranscriptItem = { id: 'item-0', kind: 'user', text: 'Hi' };
		deltas.toUpdates([user, thought('Hm')]);
		expect(deltas.toUpdates([user, thought('Hmm')])).toEqual([user, { kind: 'append', id: 'item-2', append: 'm' }]);
	});

	it('sends the whole item when its text did not just grow', () => {
		const deltas = new TextDeltas();
		deltas.toUpdates([agent('Hello')]);
		expect(deltas.toUpdates([agent('Goodbye')])).toEqual([agent('Goodbye')]);
		expect(deltas.toUpdates([agent('Goodbye')])).toEqual([agent('Goodbye')]);
	});

	it('counts what a reset sent as already there', () => {
		const deltas = new TextDeltas();
		deltas.toUpdates([agent('Old')]);
		deltas.reset([agent('Hello')]);
		expect(deltas.toUpdates([agent('Hello!')])).toEqual([{ kind: 'append', id: 'item-1', append: '!' }]);
		deltas.reset([]);
		expect(deltas.toUpdates([agent('Hello!!')])).toEqual([agent('Hello!!')]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { attentionChange, waitingCount } from '../../src/acp/attention';

const idle = { busy: false, needsPermission: false };
const working = { busy: true, needsPermission: false };
const asking = { busy: true, needsPermission: true };

describe('attentionChange', () => {
	it('tells when an agent starts waiting for permission', () => {
		expect(attentionChange(working, asking)).toBe('permission');
		expect(attentionChange(asking, asking)).toBeUndefined();
	});

	it('tells when a turn ends', () => {
		expect(attentionChange(working, idle)).toBe('done');
		expect(attentionChange(asking, idle)).toBe('done');
	});

	it('says nothing when a turn starts or a permission is answered', () => {
		expect(attentionChange(idle, working)).toBeUndefined();
		expect(attentionChange(asking, working)).toBeUndefined();
	});
});

describe('waitingCount', () => {
	it('counts agents asking for permission or with an unseen reply', () => {
		expect(waitingCount([
			{ activity: asking, unread: false },
			{ activity: idle, unread: true },
			{ activity: working, unread: false },
			{ activity: idle, unread: false },
		])).toBe(2);
	});
});

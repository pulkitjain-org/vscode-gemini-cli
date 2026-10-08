/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { agentRowMeta } from '../../src/acp/agentRow';

const now = 1_000_000;

describe('agentRowMeta', () => {
	it('shows each state the way the side bar does', () => {
		expect([
			agentRowMeta({ state: 'working', startedAt: now - 42_000 }, now),
			agentRowMeta({ state: 'working' }, now),
			agentRowMeta({ state: 'waiting', startedAt: now - 42_000, added: 3 }, now),
			agentRowMeta({ state: 'done', added: 38 }, now),
			agentRowMeta({ state: 'done', added: 0 }, now),
			agentRowMeta({ state: 'done' }, now),
			agentRowMeta({ state: 'idle', added: 12 }, now),
			agentRowMeta({ state: 'stopped' }, now),
			agentRowMeta({ state: 'error' }, now),
		]).toEqual([
			{ kind: 'clock', text: '0:42' },
			{ kind: 'age' },
			{ kind: 'waiting' },
			{ kind: 'added', text: '+38' },
			{ kind: 'age' },
			{ kind: 'age' },
			{ kind: 'age' },
			{ kind: 'age' },
			{ kind: 'age' },
		]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { agentRowMeta, branchAgentActions } from '../../src/acp/agentRow';

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

describe('branchAgentActions', () => {
	it('offers Try with changes on a branch, Keep and Take Back while tried, and Stop while working', () => {
		const base = { hasChanges: true, onBranch: true, forkable: true, checks: true };
		expect([
			branchAgentActions({ ...base, state: 'done' }),
			branchAgentActions({ ...base, state: 'done', trying: true, checkoutChanged: true, conflicts: true }),
			branchAgentActions({ ...base, state: 'working' }),
			branchAgentActions({ state: 'kept', hasChanges: true, onBranch: true, discarded: true }),
			branchAgentActions({ state: 'planned', hasChanges: false, onBranch: false }),
		].map(actions => [...actions.primary, '|', ...actions.work, '|', ...actions.check, '|', ...actions.plan, '|', ...actions.branch].join(' '))).toEqual([
			'open | try | review checks | | discard terminal fork',
			'open | resolve keep takeBack send | review checks | | terminal fork',
			'open stop | | | | discard terminal fork',
			'open | | review | | discard restore terminal',
			'open | | | approve | terminal',
		]);
	});
});

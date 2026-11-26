/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => import('./vscodeStub'));
import { AgentsModel } from '../../src/acp/agents';
import { AgentPersistence, SavedLiveAgent } from '../../src/host/agents/agentPersistence';
import { Uri } from './vscodeStub';

function setUp() {
	const live = new Map<string, SavedLiveAgent>();
	const persistence = new AgentPersistence(
		{ globalStorageUri: Uri.file('/nowhere') as never, globalState: { update: async () => undefined, get: () => undefined } as never },
		new AgentsModel(),
		undefined,
		live,
		{ log: () => undefined, running: () => false, reviewing: () => false, removeAgent: async () => undefined },
	);
	const saves = vi.spyOn(persistence.transcripts, 'save').mockResolvedValue(undefined);
	const agent: SavedLiveAgent = {
		controller: { conversation: [] },
		changes: { files: [] },
		activity: { busy: true, needsPermission: false },
	};
	live.set('a', agent);
	return { persistence, agent, saves };
}

describe('AgentPersistence.scheduleSave', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('saves a second after the last change, once', () => {
		const { persistence, agent, saves } = setUp();
		persistence.scheduleSave('a', agent);
		vi.advanceTimersByTime(500);
		persistence.scheduleSave('a', agent);
		vi.advanceTimersByTime(999);
		expect(saves).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(saves).toHaveBeenCalledTimes(1);
	});

	it('saves a reply that keeps streaming at the longest wait, so a crash mid-reply loses little', () => {
		const { persistence, agent, saves } = setUp();
		// A change every 100 ms, as a streaming reply's bursts come in: each alone would put the save off by a second.
		for (let at = 0; at < 10_000; at += 100) {
			persistence.scheduleSave('a', agent);
			vi.advanceTimersByTime(100);
		}
		expect(saves).toHaveBeenCalledTimes(1);
		// The next change starts a new wait.
		persistence.scheduleSave('a', agent);
		vi.advanceTimersByTime(1_000);
		expect(saves).toHaveBeenCalledTimes(2);
	});
});

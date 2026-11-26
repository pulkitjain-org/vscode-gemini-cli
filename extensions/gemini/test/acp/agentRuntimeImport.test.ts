/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, AgentRuntimeState } from '../../src/acp/agentRuntime';
import { AgentSidecar } from '../../src/acp/sidecar';
import { fakeAgentCommand, waitFor } from '../helpers';

vi.mock('../../src/acp/agentConnection', () => {
	throw new Error('the bundle is missing a chunk');
});

describe('AgentRuntime without its protocol code', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;

	afterEach(() => {
		runtime?.dispose();
		sidecar?.dispose();
	});

	it('reports an error when the ACP code fails to load, instead of staying connecting', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(), cwd: undefined, restartDelaysMs: [] });
		runtime = new AgentRuntime(sidecar);
		const failed = waitFor<AgentRuntimeState>(runtime.onDidChangeState, s => s.kind === 'error');
		sidecar.start();
		expect(await failed).toMatchObject({ kind: 'error', error: { kind: 'unknown' } });
	});
});

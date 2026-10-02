/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { AgentSidecar, SidecarState } from '../../src/acp/sidecar';
import { fakeAgentCommand, waitFor } from '../helpers';

describe('AgentSidecar', () => {
	let sidecar: AgentSidecar | undefined;

	afterEach(() => sidecar?.dispose());

	function record(s: AgentSidecar): SidecarState['kind'][] {
		const kinds: SidecarState['kind'][] = [];
		s.onDidChangeState(state => kinds.push(state.kind));
		return kinds;
	}

	it('restarts a crashing agent with backoff, then gives up', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 3 }), cwd: undefined, restartDelaysMs: [10, 20] });
		const kinds = record(sidecar);
		sidecar.start();
		const failed = await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed');
		expect(failed).toMatchObject({ kind: 'failed', reason: 'agent-exited', exitCode: 3, message: 'fake-agent: exiting with 3' });
		expect(kinds).toEqual(['starting', 'running', 'restarting', 'starting', 'running', 'restarting', 'starting', 'running', 'failed']);
	});

	it('does not restart after a fatal authentication exit', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 41 }), cwd: undefined, restartDelaysMs: [10] });
		const kinds = record(sidecar);
		sidecar.start();
		const failed = await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed');
		expect(failed).toMatchObject({ reason: 'auth-failed', exitCode: 41 });
		expect(kinds).not.toContain('restarting');
	});

	it('reports a missing CLI without retrying', async () => {
		sidecar = new AgentSidecar({ command: () => ({ command: 'definitely-not-gemini', args: [], env: process.env, shell: false }), cwd: undefined, restartDelaysMs: [10] });
		sidecar.start();
		expect(await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed')).toMatchObject({ reason: 'agent-not-found' });
	});

	it('stops without treating the exit as a crash', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(), cwd: undefined, restartDelaysMs: [10] });
		sidecar.start();
		const running = sidecar.state;
		expect(running.kind).toBe('running');
		const exited = new Promise(resolve => running.kind === 'running' && running.process.once('exit', resolve));
		sidecar.stop();
		await exited;
		expect(sidecar.state.kind).toBe('stopped');
	});

	it('forwards stderr line by line', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 41 }), cwd: undefined });
		const line = waitFor(sidecar.onStderr);
		sidecar.start();
		expect(await line).toBe('fake-agent: exiting with 41');
	});
});

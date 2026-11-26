/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { spawnAgent } from '../../src/acp/agentProcess';
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

	it('ends a process it is asked to end as a crash, and restarts it', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(), cwd: undefined, restartDelaysMs: [10] });
		const kinds = record(sidecar);
		sidecar.start();
		const running = await waitFor(sidecar.onDidChangeState, s => s.kind === 'running');
		const restarted = waitFor(sidecar.onDidChangeState, s => s.kind === 'running');
		if (running.kind === 'running') {
			// Another process than the running one is left alone.
			sidecar.endProcess({ ...running.process } as typeof running.process);
			sidecar.endProcess(running.process);
		}
		await restarted;
		expect(kinds).toEqual(['starting', 'running', 'restarting', 'starting', 'running']);
	});

	it('restarts a crashing agent with backoff, then gives up', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 3 }), cwd: undefined, restartDelaysMs: [10, 20] });
		const kinds = record(sidecar);
		sidecar.start();
		const failed = await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed');
		expect(failed).toMatchObject({ kind: 'failed', reason: 'agent-exited', exitCode: 3, message: 'fake-agent: exiting with 3' });
		expect(kinds).toEqual(['starting', 'running', 'restarting', 'starting', 'running', 'restarting', 'starting', 'running', 'failed']);
	});

	it('gets its restart budget back once it served a prompt, not from uptime', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 3 }), cwd: undefined, restartDelaysMs: [10] });
		const kinds = record(sidecar);
		sidecar.start();
		await waitFor(sidecar.onDidChangeState, s => s.kind === 'restarting');
		sidecar.markHealthy();
		await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed');
		// One restart from the budget, then the mark gave a second one, then it gave up.
		expect(kinds.filter(kind => kind === 'restarting')).toHaveLength(2);
	});

	it('reports a command that cannot be worked out, or spawned, as not started', async () => {
		sidecar = new AgentSidecar({ command: () => Promise.reject(new Error('no CLI picked')), cwd: undefined, restartDelaysMs: [10] });
		sidecar.start();
		expect(await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed')).toMatchObject({ kind: 'failed', reason: 'not-started', message: 'Error: no CLI picked' });
	});

	it('starts the agent again at once when the CLI asks to be relaunched', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 199 }), cwd: undefined, restartDelaysMs: [10] });
		const kinds = record(sidecar);
		sidecar.start();
		await waitFor(sidecar.onDidChangeState, s => s.kind === 'failed');
		// Three immediate relaunches, then the normal crash handling.
		expect(kinds).toEqual([
			'starting', 'running',
			'restarting', 'starting', 'running',
			'restarting', 'starting', 'running',
			'restarting', 'starting', 'running',
			'restarting', 'starting', 'running', 'failed',
		]);
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
		const started = waitFor(sidecar.onDidChangeState, state => state.kind === 'running');
		sidecar.start();
		const running = await started;
		expect(running.kind).toBe('running');
		const exited = new Promise(resolve => running.kind === 'running' && running.process.once('exit', resolve));
		sidecar.stop();
		await exited;
		expect(sidecar.state.kind).toBe('stopped');
	});

	it('starts nothing when stopped while its command was still being read', async () => {
		let release!: () => void;
		const read = new Promise<void>(resolve => release = resolve);
		let spawned = 0;
		sidecar = new AgentSidecar({ command: async () => { await read; return fakeAgentCommand(); }, cwd: undefined, spawn: (command, cwd) => { spawned++; return spawnAgent(command, cwd); } });
		sidecar.start();
		sidecar.stop();
		release();
		await new Promise(resolve => setTimeout(resolve, 20));
		expect([spawned, sidecar.state.kind]).toEqual([0, 'stopped']);
	});

	it('forwards stderr line by line', async () => {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand({ exitCode: 41 }), cwd: undefined });
		const line = waitFor(sidecar.onStderr);
		sidecar.start();
		expect(await line).toBe('fake-agent: exiting with 41');
	});
});

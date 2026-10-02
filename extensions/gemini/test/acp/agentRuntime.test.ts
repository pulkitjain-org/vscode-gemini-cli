/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientOptions, AgentClientState } from '../../src/acp/agentClient';
import { AgentRuntime } from '../../src/acp/agentRuntime';
import { createFileHandlers } from '../../src/acp/fileAccess';
import { AgentSidecar, SidecarState } from '../../src/acp/sidecar';
import type { FakeAgentScript } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

const cancelled = async () => ({ outcome: { outcome: 'cancelled' as const } });
const permissionStep = {
	step: 'permission' as const,
	request: { toolCall: { toolCallId: 't1', title: 'Write file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }] },
};

describe('AgentRuntime', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	const clients: AgentClient[] = [];

	afterEach(() => {
		clients.splice(0).forEach(c => c.dispose());
		runtime?.dispose();
		sidecar?.dispose();
	});

	function start(script: FakeAgentScript, options?: ConstructorParameters<typeof AgentRuntime>[1]) {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		runtime = new AgentRuntime(sidecar, options);
		const spawned: SidecarState[] = [];
		sidecar.onDidChangeState(s => s.kind === 'running' && spawned.push(s));
		sidecar.start();
		return { sidecar, runtime, spawned };
	}

	async function session(cwd: string, options: Partial<AgentClientOptions> = {}) {
		const client = new AgentClient(runtime!, { cwd, requestPermission: cancelled, ...options });
		clients.push(client);
		const texts: string[] = [];
		client.onDidReceiveEvent(e => e.kind === 'text' && texts.push(e.text));
		const state = client.state.kind === 'ready' ? client.state : await waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready' || s.kind === 'error');
		return { client, texts, state };
	}

	it('serves sessions in different folders from one process', async () => {
		const { spawned } = start({ turns: [[{ step: 'session' }], [{ step: 'session' }]] });
		const a = await session('/work/a');
		const b = await session('/work/b');
		expect([a.state, b.state]).toMatchObject([{ kind: 'ready', sessionId: 'fake-session-1' }, { kind: 'ready', sessionId: 'fake-session-2' }]);

		await a.client.prompt('who');
		await b.client.prompt('who');
		expect(a.texts).toEqual(['session:fake-session-1:/work/a']);
		expect(b.texts).toEqual(['session:fake-session-2:/work/b']);
		expect(spawned).toHaveLength(1);
		expect(runtime!.sessionCount).toBe(2);
	});

	it('keeps concurrent turns apart', async () => {
		start({
			turns: [
				[{ step: 'delay', ms: 100 }, { step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slow' } } }],
				[{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fast' } } }],
			],
		});
		const a = await session('/work/a');
		const b = await session('/work/b');
		const slow = a.client.prompt('slow');
		await b.client.prompt('fast');
		expect(b.texts).toEqual(['fast']);
		expect(a.texts).toEqual([]);
		await slow;
		expect(a.texts).toEqual(['slow']);
	});

	it('asks the session that owns the request for permission', async () => {
		start({ turns: [[permissionStep]] });
		const asked: string[] = [];
		await session('/work/a', { requestPermission: async () => (asked.push('a'), { outcome: { outcome: 'cancelled' } }) });
		const b = await session('/work/b', { requestPermission: async () => (asked.push('b'), { outcome: { outcome: 'selected', optionId: 'allow' } }) });
		await b.client.prompt('write');
		expect(asked).toEqual(['b']);
		expect(b.texts).toEqual(['permission:allow']);
	});

	it('answers cancelled for a session that was closed', async () => {
		start({ turns: [[permissionStep]] });
		const asked: string[] = [];
		const a = await session('/work/a', { requestPermission: async () => (asked.push('a'), { outcome: { outcome: 'selected', optionId: 'allow' } }) });
		const closedId = a.state.kind === 'ready' ? a.state.sessionId : '';
		a.client.dispose();
		expect(runtime!.sessionCount).toBe(0);

		// Prompt the closed session over the shared connection: nobody is asked.
		const { connection } = await runtime!.newSession('/work/b');
		expect(await connection.prompt(closedId, [{ type: 'text', text: 'write' }])).toMatchObject({ stopReason: 'end_turn' });
		expect(asked).toEqual([]);
		expect(a.texts).toEqual([]);
	});

	it('authenticates once for sessions that open together', async () => {
		start({ requireAuth: true, turns: [[{ step: 'auth' }]] });
		const [a, b] = await Promise.all([session('/work/a'), session('/work/b')]);
		expect([a.state.kind, b.state.kind]).toEqual(['ready', 'ready']);
		await a.client.prompt('auth');
		expect(a.texts).toEqual(['auth:1']);
	});

	it('opens new sessions for every client after a restart', async () => {
		const { sidecar } = start({});
		const a = await session('/work/a');
		const b = await session('/work/b');
		expect([a.state, b.state]).toMatchObject([{ sessionId: 'fake-session-1' }, { sessionId: 'fake-session-2' }]);

		const readyAgain = Promise.all([a.client, b.client].map(c => waitFor<AgentClientState>(c.onDidChangeState, s => s.kind === 'ready')));
		sidecar.stop();
		sidecar.start();
		const states = await readyAgain;
		expect(states.map(s => s.kind === 'ready' && s.sessionId).sort()).toEqual(['fake-session-1', 'fake-session-2']);
		expect(runtime!.sessionCount).toBe(2);
	});

	it('serves a session from its own file handlers', async () => {
		const root = path.resolve(tmpdir());
		const file = path.join(root, 'a.ts');
		const shared = createFileHandlers({ readTextFile: async () => 'shared', writeTextFile: async () => undefined }, () => ({ roots: [root] }));
		const own = createFileHandlers({ readTextFile: async () => 'own', writeTextFile: async () => undefined }, () => ({ roots: [root] }));
		start({ turns: [[{ step: 'readFile', path: file }], [{ step: 'readFile', path: file }]] }, { fileSystem: shared });
		const a = await session(root);
		const b = await session(root, { fileSystem: own });
		await a.client.prompt('read');
		await b.client.prompt('read');
		expect(a.texts).toEqual(['read:shared']);
		expect(b.texts).toEqual(['read:own']);
	});
});

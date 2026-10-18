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
		// Busy and idle fire once each, for the first turn to start and the last to end.
		const events: string[] = [];
		runtime!.onDidBecomeBusy(() => events.push('busy'));
		runtime!.onDidBecomeIdle(() => events.push('idle'));
		const slow = a.client.prompt('slow');
		await b.client.prompt('fast');
		expect(b.texts).toEqual(['fast']);
		expect(a.texts).toEqual([]);
		expect(events).toEqual(['busy']);
		await slow;
		expect(a.texts).toEqual(['slow']);
		expect(events).toEqual(['busy', 'idle']);
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

	it('reopens the same session after a restart when the agent can load sessions', async () => {
		const { sidecar } = start({ storedSessions: ['fake-session-1'], turns: [[{ step: 'session' }]] });
		const a = await session('/work/a');
		expect(a.state).toMatchObject({ sessionId: 'fake-session-1' });

		const replayed: string[] = [];
		a.client.onDidReplayEvent(e => e.kind === 'text' && replayed.push(e.text));
		const readyAgain = waitFor<AgentClientState>(a.client.onDidChangeState, s => s.kind === 'ready');
		sidecar.stop();
		sidecar.start();
		expect(await readyAgain).toMatchObject({ sessionId: 'fake-session-1' });
		await a.client.prompt('who');
		// The replayed history comes apart from the turn.
		expect(replayed).toEqual(['history:fake-session-1']);
		expect(a.texts).toEqual(['session:fake-session-1:/work/a']);
	});

	it('holds a prompt sent while the history replays until the replay is over, and keeps the replay out of the turn', async () => {
		const { sidecar } = start({ storedSessions: ['fake-session-1'], replay: { updates: 6, delayMs: 30 }, turns: [[{ step: 'session' }]] });
		const a = await session('/work/a', { findSavedSession: async () => ({ replayUpdates: 7 }) });
		const replayed: string[] = [];
		a.client.onDidReplayEvent(e => e.kind === 'text' && replayed.push(e.text));
		const readyAgain = waitFor<AgentClientState>(a.client.onDidChangeState, s => s.kind === 'ready');
		sidecar.stop();
		sidecar.start();
		await readyAgain;
		// Sent at once, while most of the replay is still to come.
		await a.client.prompt('who');
		expect(replayed).toEqual(['history:fake-session-1', 'Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6']);
		expect(a.texts).toEqual(['session:fake-session-1:/work/a']);
	});

	it('reopens a session from an earlier run on first open', async () => {
		start({ storedSessions: ['earlier'], turns: [[{ step: 'session' }]] });
		const a = await session('/work/a', { resumeSessionId: 'earlier' });
		expect(a.state).toMatchObject({ kind: 'ready', sessionId: 'earlier' });
		await a.client.prompt('who');
		expect(a.texts.at(-1)).toBe('session:earlier:/work/a');
	});

	it('switches a ready chat to a saved session, and says when it could not', async () => {
		start({ storedSessions: ['earlier'] });
		const a = await session('/work/a', { findSavedSession: async () => undefined });
		expect(await a.client.loadSession('earlier')).toBe(true);
		expect(a.client.state).toMatchObject({ kind: 'ready', sessionId: 'earlier', savedSessionId: 'earlier' });
		expect(await a.client.loadSession('missing')).toBe(false);
		expect(a.client.state).toMatchObject({ kind: 'ready', savedSessionId: 'fake-session-2' });
	});

	it('opens a new session when the agent no longer has the old one', async () => {
		start({ storedSessions: [] });
		const a = await session('/work/a', { resumeSessionId: 'gone' });
		expect(a.state).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
	});

	it('opens a new session when the agent cannot load sessions', async () => {
		start({});
		const a = await session('/work/a', { resumeSessionId: 'earlier' });
		expect(a.state).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
	});

	it('does not reopen a session the client forgot or replaced', async () => {
		const { sidecar } = start({ storedSessions: ['fake-session-1'] });
		const a = await session('/work/a');
		a.client.forgetSession();
		const readyAgain = waitFor<AgentClientState>(a.client.onDidChangeState, s => s.kind === 'ready');
		sidecar.stop();
		sidecar.start();
		expect(await readyAgain).toMatchObject({ sessionId: 'fake-session-1' });
		// A new process numbers sessions from 1 again; no history replay shows it is a new one.
		expect(a.texts).toEqual([]);
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

	async function ready(runtime: AgentRuntime): Promise<void> {
		if (runtime.state.kind !== 'ready') {
			await waitFor(runtime.onDidChangeState, s => s.kind === 'ready');
		}
	}

	it('gives a session prepared ahead to the next chat in the same folder', async () => {
		start({ turns: [[{ step: 'session' }]] });
		await ready(runtime!);
		runtime!.prepareSession('/work/a');
		runtime!.prepareSession('/work/a');
		const b = await session('/work/b');
		const a = await session('/work/a');
		expect([a.state, b.state]).toMatchObject([{ kind: 'ready', sessionId: 'fake-session-1' }, { kind: 'ready', sessionId: 'fake-session-2' }]);
		await a.client.prompt('who');
		expect(a.texts).toEqual(['session:fake-session-1:/work/a']);
	});

	it('closes a spare it replaces when the agent can close sessions', async () => {
		start({ initialize: { agentCapabilities: { sessionCapabilities: { close: {} } } }, turns: [[{ step: 'closed' }]] });
		await ready(runtime!);
		runtime!.prepareSession('/work/a', [], 'agent:/work/a:no-tools');
		runtime!.prepareSession('/work/a', [], 'agent:/work/a:tools');
		const a = await session('/work/a', { spareKey: () => 'agent:/work/a:tools' });
		expect(a.state).toMatchObject({ kind: 'ready', sessionId: 'fake-session-2' });
		// The old spare is closed once it has opened, which may be after the new chat started.
		await new Promise(resolve => setTimeout(resolve, 150));
		await a.client.prompt('which');
		expect(a.texts).toEqual(['closed:fake-session-1']);
	});

	it('does not give a prepared session to a chat with other servers', async () => {
		start({});
		await ready(runtime!);
		runtime!.prepareSession('/work/a', [{ name: 'browser', command: 'x', args: [], env: [] }]);
		const a = await session('/work/a');
		expect(a.state).toMatchObject({ kind: 'ready', sessionId: 'fake-session-2' });
	});

	it('gives a spare prepared with a key to any chat with that key, with the spare\'s own servers', async () => {
		start({});
		await ready(runtime!);
		const spareServers = [{ type: 'http' as const, name: 'browser', url: 'http://127.0.0.1:1/mcp/slot-1', headers: [] }];
		runtime!.prepareSession('/work/a', spareServers, 'agent:/work/a');
		expect(runtime!.spareKey).toBe('agent:/work/a');
		const opened: unknown[] = [];
		const a = await session('/work/a', {
			mcpServers: () => [{ type: 'http', name: 'browser', url: 'http://127.0.0.1:1/mcp/a1', headers: [] }],
			spareKey: () => 'agent:/work/a',
			onDidOpenSession: servers => opened.push(servers),
		});
		expect(a.state).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
		expect(opened).toEqual([spareServers]);
		expect(runtime!.spareKey).toBeUndefined();
	});

	it('opens a chat made to open later only when asked', async () => {
		start({});
		await ready(runtime!);
		const client = new AgentClient(runtime!, { cwd: '/work/a', requestPermission: cancelled, openLater: true });
		clients.push(client);
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(client.state.kind).toBe('connecting');
		expect(runtime!.sessionCount).toBe(0);
		const opened = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready');
		client.open();
		expect(await opened).toMatchObject({ sessionId: 'fake-session-1' });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientOptions, AgentClientState, supportedMcpServers, TurnStall, WaitAbortedError } from '../../src/acp/agentClient';
import { AgentRuntime, AgentRuntimeOptions, FileSystemHandlers } from '../../src/acp/agentRuntime';
import { AgentError, classifyTurnError } from '../../src/acp/errors';
import { ClientFileSystem, createFileHandlers } from '../../src/acp/fileAccess';
import { AgentSidecar } from '../../src/acp/sidecar';
import type { ChatEvent } from '../../src/acp/sessionUpdates';
import type { FakeAgentScript } from '../fake-agent/fakeAgent';
import { fakeAgentCommand, waitFor } from '../helpers';

describe('AgentClient', () => {
	let sidecar: AgentSidecar | undefined;
	let runtime: AgentRuntime | undefined;
	let client: AgentClient | undefined;

	afterEach(() => {
		client?.dispose();
		runtime?.dispose();
		sidecar?.dispose();
	});

	function start(script: FakeAgentScript, requestPermission?: (p: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>, fileSystem?: FileSystemHandlers, options: { readonly client?: Partial<AgentClientOptions>; readonly runtime?: AgentRuntimeOptions; readonly restartDelaysMs?: number[] } = {}) {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: options.restartDelaysMs ?? [] });
		runtime = new AgentRuntime(sidecar, { fileSystem, ...options.runtime });
		client = new AgentClient(runtime, {
			cwd: process.cwd(),
			requestPermission: requestPermission ?? (async () => ({ outcome: { outcome: 'cancelled' } })),
			...options.client,
		});
		const settled = waitFor<AgentClientState>(client.onDidChangeState, s => s.kind === 'ready' || s.kind === 'error');
		sidecar.start();
		return { client, settled };
	}

	it('opens a session', async () => {
		const { settled } = start({});
		expect(await settled).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
	});

	it('authenticates once with oauth-personal when the agent asks, then retries', async () => {
		const { settled } = start({ requireAuth: true });
		expect(await settled).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
	});

	it('does not authenticate for a setup error and reports its kind', async () => {
		const { settled } = start({
			newSession: { error: { code: -32000, message: 'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var. See https://geminicli.com/docs/get-started/authentication/#set-gcp' } },
		});
		expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'project-id-required' } });
	});

	it('keeps the slash commands the agent lists', async () => {
		const { client, settled } = start({
			turns: [[{ step: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'Analyze the project' }, { name: '/memory', description: '' }] } }]],
		});
		await settled;
		const changed = waitFor(client.onDidChangeCommands, () => true);
		await client.prompt('hello');
		await changed;
		expect(client.commands).toEqual([
			{ name: 'init', description: 'Analyze the project', source: 'cli' },
			{ name: 'memory', description: '', source: 'cli' },
		]);
	});

	it('streams a turn through the adapter', async () => {
		const { client, settled } = start({
			turns: [[
				{ step: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } },
				{ step: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'in_progress' } },
				{ step: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
				{ step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } },
			]],
		});
		await settled;
		const events: ChatEvent[] = [];
		client.onDidReceiveEvent(e => events.push(e));
		expect(await client.prompt('hello')).toBe('end_turn');
		expect(events.map(e => e.kind === 'text' ? `${e.role}:${e.text}` : e.kind === 'toolCall' ? `tool:${e.call.status}` : e.kind)).toEqual([
			'thought:thinking', 'tool:in_progress', 'tool:completed', 'agent:done',
		]);
	});

	it('reports the tokens gemini-cli counted for a turn', async () => {
		const { client, settled } = start({
			turns: [[], []],
			promptMeta: { quota: { token_count: { input_tokens: 120, output_tokens: 8 }, model_usage: [{ model: 'gemini-3.8-flash', token_count: { input_tokens: 120, output_tokens: 8 } }] } },
		});
		await settled;
		expect(await client.promptTurn('hello')).toEqual({ stopReason: 'end_turn', usage: [{ model: 'gemini-3.8-flash', input: 120, output: 8 }] });
		expect(await client.prompt('again')).toBe('end_turn');
	});

	it('cancels a running turn', async () => {
		const { client, settled } = start({ turns: [[{ step: 'delay', ms: 200 }, { step: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'too late' } } }]] });
		await settled;
		const turn = client.prompt('long task');
		await client.cancel();
		expect(await turn).toBe('cancelled');
	});

	it('routes permission requests to the host', async () => {
		const asked: string[] = [];
		const { client, settled } = start({
			turns: [[{
				step: 'permission',
				request: {
					toolCall: { toolCallId: 't1', title: 'Write file' },
					options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
				},
			}]],
		}, async params => {
			asked.push(params.toolCall.title ?? '');
			return { outcome: { outcome: 'selected', optionId: 'allow' } };
		});
		await settled;
		const texts: string[] = [];
		client.onDidReceiveEvent(e => e.kind === 'text' && texts.push(e.text));
		await client.prompt('edit it');
		expect(asked).toEqual(['Write file']);
		expect(texts).toEqual(['permission:allow']);
	});

	it('reports a fatal agent exit', async () => {
		const { settled } = start({ exitCode: 41 });
		expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'auth-failed' } });
	});

	describe('file access', () => {
		const root = path.resolve(tmpdir());
		const files: Record<string, string> = { [path.join(root, 'a.ts')]: 'line 1\nline 2\nline 3' };
		const fileSystem: ClientFileSystem = {
			async readTextFile(p) { return files[p]; },
			async writeTextFile(p, content) { files[p] = content; },
		};

		function agentText(events: ChatEvent[]): string[] {
			return events.flatMap(e => e.kind === 'text' ? [e.text] : []);
		}

		it('advertises fs capabilities only when it serves them', async () => {
			const turn = [{ step: 'capabilities' as const }];
			const withFs = start({ turns: [turn] }, undefined, createFileHandlers(fileSystem, () => ({ roots: [root] })));
			await withFs.settled;
			const events: ChatEvent[] = [];
			withFs.client.onDidReceiveEvent(e => events.push(e));
			await withFs.client.prompt('caps');
			expect(agentText(events)).toEqual(['fs:true,true']);
			client!.dispose();
			runtime!.dispose();
			sidecar!.dispose();

			const withoutFs = start({ turns: [turn] });
			await withoutFs.settled;
			const more: ChatEvent[] = [];
			withoutFs.client.onDidReceiveEvent(e => more.push(e));
			await withoutFs.client.prompt('caps');
			expect(agentText(more)).toEqual(['fs:false,false']);
		});

		it('serves reads and writes and refuses secrets over the wire', async () => {
			const { client, settled } = start({
				turns: [[
					{ step: 'readFile', path: path.join(root, 'a.ts'), line: 2, limit: 1 },
					{ step: 'writeFile', path: path.join(root, 'b.ts'), content: 'created' },
					{ step: 'readFile', path: path.join(root, '.env') },
					{ step: 'readFile', path: path.join(root, 'missing.ts') },
				]],
			}, undefined, createFileHandlers(fileSystem, () => ({ roots: [root] })));
			await settled;
			const events: ChatEvent[] = [];
			client.onDidReceiveEvent(e => events.push(e));
			expect(await client.prompt('files')).toBe('end_turn');
			const [read, wrote, secret, missing] = agentText(events);
			expect(read).toBe('read:line 2');
			expect(wrote).toBe('wrote');
			expect(files[path.join(root, 'b.ts')]).toBe('created');
			expect(secret).toMatch(/^error:.*denied/);
			expect(missing).toBe('read:');
		});
	});

	describe('opening sessions', () => {
		const offline = { error: { code: -32000, message: 'fetch failed' } };

		it('rejects a new session that failed to open, keeps the old one, and never goes back to it', async () => {
			const { client, settled } = start({
				storedSessions: [],
				initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } },
				newSessionErrors: [null, offline],
				turns: [[{ step: 'closed' }]],
			});
			await settled;
			const failure = await client.newSession().then(() => undefined, (err: unknown) => err);
			expect(failure).toBeInstanceOf(AgentError);
			expect((failure as AgentError).info.kind).toBe('network');
			// The next use opens a new session at once rather than reopening the one left.
			expect(await client.whenReady()).toMatchObject({ kind: 'ready', sessionId: 'fake-session-2' });
			const texts: string[] = [];
			client.onDidReceiveEvent(e => e.kind === 'text' && texts.push(e.text));
			await client.prompt('closed?');
			expect(texts).toEqual(['closed:']);
		});

		it('rejects a saved session that could not be opened when no new one opens either', async () => {
			const { client, settled } = start({ storedSessions: [], newSessionErrors: [null, offline] });
			await settled;
			await expect(client.loadSession('gone')).rejects.toMatchObject({ info: { kind: 'network' } });
		});

		it('opens a session again after it failed while the agent stayed ready, backing off after the first retry', async () => {
			const { client, settled } = start({ newSessionErrors: [offline, offline, null] }, undefined, undefined, { client: { retryDelaysMs: [0, 300] } });
			expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'network' } });
			// One retry per wait: this one fails again at once.
			await expect(client.whenReady()).rejects.toMatchObject({ info: { kind: 'network' } });
			const started = Date.now();
			expect(await client.whenReady()).toMatchObject({ kind: 'ready', sessionId: 'fake-session-1' });
			expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		});

		it('gives up on a session/new that takes too long, with an error saying so', async () => {
			const { settled } = start({ newSessionDelayMs: 3_000 }, undefined, undefined, { runtime: { timeouts: { newSession: 200 } } });
			expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'timeout' } });
		});

		it('gives up on an initialize that takes too long', async () => {
			const { settled } = start({ initializeDelayMs: 5_000 }, undefined, undefined, { runtime: { timeouts: { initialize: 200 } } });
			expect(await settled).toMatchObject({ kind: 'error', error: { kind: 'timeout' } });
		});

		it('stops waiting for the session when told to, and when the client goes', async () => {
			const { client } = start({ initializeDelayMs: 2_000 });
			const abort = new AbortController();
			const waiting = client.whenReady(abort.signal);
			abort.abort();
			await expect(waiting).rejects.toBeInstanceOf(WaitAbortedError);
			const disposedWait = client.whenReady();
			client.dispose();
			await expect(disposedWait).rejects.toBeInstanceOf(AgentError);
		});
	});

	describe('turns', () => {
		const text = (value: string) => ({ step: 'update' as const, update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: value } } });

		it('ends a turn here when the agent does not stop it in time', async () => {
			const { client, settled } = start({ turns: [[{ step: 'delay', ms: 5_000 }, text('too late')]] }, undefined, undefined, { client: { cancelGraceMs: 100 } });
			await settled;
			const started = Date.now();
			const turn = client.prompt('long task');
			await new Promise(resolve => setTimeout(resolve, 50));
			await client.cancel();
			expect(await turn).toBe('cancelled');
			expect(Date.now() - started).toBeLessThan(2_000);
		});

		it('says when a turn has had no update for a while, with the CLI\'s retry, and clears it on the next update', async () => {
			const { client, settled } = start({ turns: [[{ step: 'delay', ms: 400 }, text('answer')]] }, undefined, undefined, { client: { stallAfterMs: 100 } });
			await settled;
			const stalls: (TurnStall | undefined)[] = [];
			client.onDidChangeStall(stall => {
				stalls.push(stall);
				if (stall && !stall.retry) {
					runtime!.noteRetry({ attempt: 2, status: 503 });
				}
			});
			await client.prompt('slow');
			expect(stalls.map(stall => stall && { retry: stall.retry })).toEqual([{ retry: undefined }, { retry: { attempt: 2, status: 503 } }, undefined]);
			expect(client.stall).toBeUndefined();
		});

		it('does not count a running tool or a question for the user as a stall', async () => {
			const { client, settled } = start({
				turns: [[
					{ step: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm test', status: 'in_progress' } },
					{ step: 'delay', ms: 300 },
					{ step: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
					{ step: 'permission', request: { toolCall: { toolCallId: 't2', title: 'Write file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } },
				]],
			}, async () => {
				await new Promise(resolve => setTimeout(resolve, 300));
				return { outcome: { outcome: 'selected', optionId: 'allow' } };
			}, undefined, { client: { stallAfterMs: 100 } });
			await settled;
			const stalls: (TurnStall | undefined)[] = [];
			client.onDidChangeStall(stall => stalls.push(stall));
			await client.prompt('test it');
			expect(stalls).toEqual([]);
		});

		it('passes on the API error a turn failed with, which classifies as a quota error', async () => {
			const { client, settled } = start({ turns: [[{ step: 'fail', error: { code: 429, message: 'You have exhausted your capacity on this model. Your quota will reset after 2h.' } }]] });
			await settled;
			const failure = await client.prompt('hello').then(() => undefined, (err: unknown) => err);
			expect(classifyTurnError(failure, { model: 'gemini-3.8-pro', now: 0 })).toEqual({
				kind: 'quota', message: 'You have exhausted your capacity on this model. Your quota will reset after 2h.', model: 'gemini-3.8-pro', resetsAt: 7_200_000,
			});
		});

		it('says the agent restarted when its process ends under a turn', async () => {
			const { client, settled } = start({ turns: [[{ step: 'delay', ms: 3_000 }]] }, undefined, undefined, { restartDelaysMs: [100] });
			await settled;
			const turn = client.prompt('long task');
			await new Promise(resolve => setTimeout(resolve, 100));
			const state = sidecar!.state;
			if (state.kind === 'running') {
				state.process.kill('SIGKILL');
			}
			await expect(turn).rejects.toMatchObject({ info: { kind: 'agent-restarted' } });
		});
	});

	it('offers only MCP servers over transports the agent advertises', () => {
		const http: acp.McpServer = { type: 'http', name: 'browser', url: 'http://127.0.0.1:1/mcp/a1', headers: [] };
		const stdio: acp.McpServer = { name: 'tool', command: 'tool', args: [], env: [] };
		const agent = (mcpCapabilities?: acp.McpCapabilities): acp.InitializeResponse => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities } });
		expect([
			supportedMcpServers(agent({ http: true }), [http, stdio]),
			supportedMcpServers(agent({ http: false, sse: true }), [http, stdio]),
			supportedMcpServers(agent(), [http, stdio]),
			supportedMcpServers(undefined, [http]),
		]).toEqual([[http, stdio], [stdio], [stdio], []]);
	});
});

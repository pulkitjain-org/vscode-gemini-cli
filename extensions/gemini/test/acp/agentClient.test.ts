/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, AgentClientState, supportedMcpServers } from '../../src/acp/agentClient';
import { AgentRuntime, FileSystemHandlers } from '../../src/acp/agentRuntime';
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

	function start(script: FakeAgentScript, requestPermission?: (p: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>, fileSystem?: FileSystemHandlers) {
		sidecar = new AgentSidecar({ command: () => fakeAgentCommand(script), cwd: undefined, restartDelaysMs: [] });
		runtime = new AgentRuntime(sidecar, { fileSystem });
		client = new AgentClient(runtime, {
			cwd: process.cwd(),
			requestPermission: requestPermission ?? (async () => ({ outcome: { outcome: 'cancelled' } })),
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpServer, LocalMcpServer, type McpHttpConfig } from '../../src/acp/localMcpServer';

const servers: { dispose(): void }[] = [];
afterEach(() => servers.splice(0).forEach(s => s.dispose()));

async function post(config: McpHttpConfig, body: unknown): Promise<{ status: number; body: unknown }> {
	const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: config.headers[0].value }, body: JSON.stringify(body) });
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe('local MCP server', () => {
	it('answers every request, even when a tool or the server itself throws', async () => {
		let failBeforeAnswer = false;
		const server = new LocalMcpServer<string>({
			name: 'test-server',
			version: '1',
			callerOf: route => route,
			instructions: () => '',
			tools: () => [],
			call: async () => {
				throw new Error('The audit log could not be written.');
			},
			onMessages: () => {
				if (failBeforeAnswer) {
					throw new Error('Unexpected.');
				}
			},
		});
		servers.push(server);
		await server.start();
		const config = server.configFor('agent-1')!;
		const toolThrew = await post(config, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jira_comment', arguments: {} } });
		failBeforeAnswer = true;
		const serverThrew = await post(config, { jsonrpc: '2.0', id: 2, method: 'ping' });
		expect({ toolThrew, serverThrew }).toEqual({
			toolThrew: { status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'The audit log could not be written.' }], isError: true } } },
			serverThrew: { status: 500, body: { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Unexpected.' } } },
		});
	});

	it('tells a session\'s open stream when its tools change, and says so in initialize', async () => {
		let tools: string[] = [];
		const server = new LocalMcpServer<string>({ name: 'test-server', version: '1', callerOf: route => route, instructions: () => '', tools: () => tools.map(name => ({ name, description: '', inputSchema: { type: 'object', properties: {} } })), call: async () => ({ content: [] }) });
		servers.push(server);
		await server.start();
		const config = server.configFor('agent-1')!;
		const initialized = await post(config, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
		expect((initialized.body as { result: { capabilities: unknown } }).result.capabilities).toEqual({ tools: { listChanged: true } });
		// No stream yet: nobody to tell, and the next tools/list sees the change anyway.
		tools = ['first'];
		expect(server.notifyToolsChanged('agent-1')).toBe(0);
		const stream = await fetch(config.url, { headers: { Authorization: config.headers[0].value, Accept: 'text/event-stream' } });
		expect(stream.headers.get('content-type')).toBe('text/event-stream');
		const reader = stream.body!.getReader();
		const opened = await reader.read();
		expect(new TextDecoder().decode(opened.value)).toBe(': open\n\n');
		tools = ['first', 'second'];
		expect(server.notifyToolsChanged('agent-1')).toBe(1);
		expect(server.notifyToolsChanged('agent-2')).toBe(0);
		const notice = await reader.read();
		expect(new TextDecoder().decode(notice.value)).toBe('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
		const listed = await post(config, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
		expect((listed.body as { result: { tools: { name: string }[] } }).result.tools.map(tool => tool.name)).toEqual(['first', 'second']);
		await reader.cancel();
	});

	it('refuses requests from a browser page or another host before looking at the token', async () => {
		const server = new LocalMcpServer<string>({ name: 'test-server', version: '1', callerOf: route => route, instructions: () => '', tools: () => [], call: async () => ({ content: [] }) });
		servers.push(server);
		await server.start();
		const config = server.configFor('agent-1')!;
		const headers = { 'Content-Type': 'application/json', Authorization: config.headers[0].value };
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
		const fromPage = await fetch(config.url, { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:3000' }, body });
		// fetch never sends another Host; a raw request does, as a DNS rebinding would.
		const otherHost = await new Promise<number>((resolve, reject) => {
			const request = http.request(config.url, { method: 'POST', headers: { ...headers, Host: 'evil.example:80' } }, response => resolve(response.statusCode ?? 0));
			request.on('error', reject);
			request.end(body);
		});
		const local = await fetch(config.url.replace('127.0.0.1', 'localhost'), { method: 'POST', headers, body });
		expect([fromPage.status, otherHost, local.status]).toEqual([403, 403, 200]);
	});

	it('stops listening when disposed while it starts', async () => {
		const server = new LocalMcpServer<string>({ name: 'test-server', version: '1', callerOf: route => route, instructions: () => '', tools: () => [], call: async () => ({ content: [] }) });
		const starting = server.start();
		server.dispose();
		expect([await starting.then(() => 'started', () => 'stopped'), server.listening]).toEqual(['stopped', false]);
	});

	it('keeps only the newest unused spare-session slots', async () => {
		const server = new AgentMcpServer({ name: 'test-server', version: '1', instructions: '', tools: () => [], call: async () => ({ content: [] }), notReady: 'Not ready.' });
		servers.push(server);
		await server.start();
		const slots = Array.from({ length: 12 }, () => server.configForSlot()!);
		const bound = server.bind(slots[11].url, 'agent-1');
		const oldest = await post(slots[0], { jsonrpc: '2.0', id: 1, method: 'ping' });
		const newest = await post(slots[10], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } });
		expect({ bound, oldest: oldest.status, newest: newest.body }).toEqual({
			bound: true,
			oldest: 404,
			newest: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Not ready.' }], isError: true } },
		});
	});
});

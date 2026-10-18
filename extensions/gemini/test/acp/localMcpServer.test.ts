/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpServer, LocalMcpServer, McpHttpConfig } from '../../src/acp/localMcpServer';

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

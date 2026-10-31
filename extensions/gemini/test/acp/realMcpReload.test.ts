/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether a running chat can be given an MCP server later: `session/load`
// by id with a server the session didn't open with must list that server's
// tools to the model and keep the conversation (FINDINGS.md, sessions; the
// team tools load only when a task needs them, and Debug mode's tools on
// entry, both rest on it). A second check: whether the CLI refreshes a
// server's tools on `notifications/tools/list_changed`, which would avoid
// the reload. Runs against the bundled CLI or GEMINI_CLI_PATH (test/realCli.ts),
// with a fake Gemini API on loopback that records what each request declared.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { contentBlockToText } from '../../src/acp/sessionUpdates';
import { describeRealCli, realCliPath } from '../realCli';

const cliPath = realCliPath;

/** A streamable-HTTP MCP server whose tools can change, with a GET stream for notifications. */
function mcpServer(tools: () => readonly string[]): Promise<{ readonly url: string; readonly notify: (method: string) => number; readonly calls: string[]; close(): void }> {
	const streams = new Set<http.ServerResponse>();
	const calls: string[] = [];
	const server = http.createServer((req, res) => {
		if (req.method === 'GET') {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			res.write(': open\n\n');
			streams.add(res);
			req.on('close', () => streams.delete(res));
			return;
		}
		let body = '';
		req.setEncoding('utf8');
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
			calls.push(message.method);
			if (message.id === undefined) {
				res.writeHead(202).end();
				return;
			}
			const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'spike', version: '1' } }
				: message.method === 'tools/list' ? { tools: tools().map(name => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: {} } })) }
					: message.method === 'tools/call' ? { content: [{ type: 'text', text: `ran ${message.params?.name}` }] }
						: {};
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
		});
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
		notify: method => {
			for (const stream of streams) {
				stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method })}\n\n`);
			}
			return streams.size;
		},
		calls,
		close: () => {
			for (const stream of streams) {
				stream.end();
			}
			server.close();
		},
	})));
}

describeRealCli('gemini --acp given an MCP server after the session opened', () => {
	const children: ChildProcessWithoutNullStreams[] = [];
	const connections: AgentConnection[] = [];
	const closers: (() => void)[] = [];

	afterAll(() => {
		for (const connection of connections) {
			connection.dispose();
		}
		for (const child of children) {
			child.kill();
		}
		for (const close of closers) {
			close();
		}
	});

	it('lists the server\'s tools on session/load and keeps the conversation; tools/list_changed is as the CLI takes it', async () => {
		// The fake model: answers every request with one word, and keeps the tool names each request declared.
		const declared: string[][] = [];
		const api = http.createServer((req, res) => {
			let body = '';
			req.setEncoding('utf8');
			req.on('data', chunk => body += chunk);
			req.on('end', () => {
				const names = [...body.matchAll(/"name":"([^"]+)"/g)].map(match => match[1]);
				declared.push(names);
				const payload = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
				if (req.url?.includes(':streamGenerateContent')) {
					res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
				} else {
					res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
				}
			});
		});
		await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
		closers.push(() => api.close());
		let tools: string[] = ['spike_first'];
		const mcp = await mcpServer(() => tools);
		closers.push(mcp.close);

		const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'gemini-home-')));
		const work = path.join(home, 'work');
		mkdirSync(work);
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
		const env: NodeJS.ProcessEnv = {
			...process.env, HOME: home, USERPROFILE: home, GEMINI_API_KEY: 'fake', GEMINI_CLI_TRUST_WORKSPACE: 'true',
			GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, NO_PROXY: '127.0.0.1',
		};
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		const updates: { readonly sessionId: string; readonly update: acp.SessionUpdate }[] = [];
		const child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		child.stderr.resume();
		children.push(child);
		const connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: params => void updates.push({ sessionId: params.sessionId, update: params.update }),
			requestPermission: async params => ({ outcome: { outcome: 'selected', optionId: params.options[0].optionId } }),
		});
		connections.push(connection);
		await connection.initialize();

		// A session with no servers, and one prompt in it.
		const { sessionId } = await connection.newSession(work, []);
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		await connection.prompt(sessionId, [{ type: 'text', text: 'First question' }]);
		// The model sees an MCP tool as mcp_<server>_<tool>.
		const declares = (tool: string) => declared.at(-1)?.some(name => name.endsWith(tool)) ?? false;
		expect(declares('spike_first')).toBe(false);

		// The same session, loaded with the server: its tools must be declared, and the first prompt replayed.
		updates.length = 0;
		const server: acp.McpServer = { type: 'http', name: 'spike', url: mcp.url, headers: [] };
		await connection.loadSession(sessionId, work, [server]);
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		await new Promise(resolve => setTimeout(resolve, 500));
		const replayed = updates.flatMap(u => u.sessionId === sessionId && u.update.sessionUpdate === 'user_message_chunk' ? [contentBlockToText(u.update.content)] : []);
		expect(replayed).toContain('First question');
		await connection.prompt(sessionId, [{ type: 'text', text: 'Second question' }]);
		expect(mcp.calls).toContain('tools/list');
		expect(declares('spike_first')).toBe(true);

		// A tool added later, announced over the server's stream: whether the next prompt declares it says if the CLI listens.
		tools = ['spike_first', 'spike_second'];
		const listeners = mcp.notify('notifications/tools/list_changed');
		await new Promise(resolve => setTimeout(resolve, 1000));
		await connection.prompt(sessionId, [{ type: 'text', text: 'Third question' }]);
		const refreshed = declares('spike_second');
		// gemini-cli 0.66.0 keeps one notification stream open per HTTP server and lists its tools again on the
		// notice, so a running session gains tools without a reload (FINDINGS.md). A CLI that stops would change this.
		expect({ listeners, refreshed }).toEqual({ listeners: 1, refreshed: true });
	}, 120_000);
});

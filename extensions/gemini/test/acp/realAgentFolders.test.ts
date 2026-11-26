/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a session loads its own folder's context file and MCP servers,
// not those of the folder the process started in: GeminiCode runs every agent
// of a window on one process, started in the window's first folder
// (agentRuntime.ts). The CLI talks to a fake Gemini API on localhost. Runs
// against the bundled CLI or GEMINI_CLI_PATH (test/realCli.ts), with an empty HOME.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentClient } from '../../src/acp/agentClient';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { AgentRuntime } from '../../src/acp/agentRuntime';
import { AgentSidecar } from '../../src/acp/sidecar';
import { describeRealCli, realCliPath } from '../realCli';

const cliPath = realCliPath;

const mcpServer = `
const [name, mark] = process.argv.slice(2);
require('fs').writeFileSync(mark, '');
let buffer = '';
process.stdin.on('data', chunk => {
	buffer += chunk;
	let end;
	while ((end = buffer.indexOf('\\n')) >= 0) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.id === undefined) {
			continue;
		}
		const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } }
			: message.method === 'tools/list' ? { tools: [{ name: name + '_tool', description: 'A tool of the ' + name + ' folder.', inputSchema: { type: 'object', properties: {} } }] }
			: {};
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
	}
});
`;

describeRealCli('sessions in a folder other than the process\'s', () => {
	const children: ChildProcessWithoutNullStreams[] = [];
	const connections: AgentConnection[] = [];
	const disposables: { dispose(): void }[] = [];
	let server: Server | undefined;
	let home: string | undefined;
	/** Every request body the fake API received. */
	let requests: string[] = [];
	const folders = ['shop', 'billing'];

	afterEach(async () => {
		disposables.splice(0).reverse().forEach(each => each.dispose());
		connections.splice(0).forEach(c => c.dispose());
		await Promise.all(children.splice(0).map(child => {
			const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : undefined;
			child.kill();
			return exited;
		}));
		server?.close();
		if (home) {
			rmSync(home, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	async function setUp(): Promise<{ env: NodeJS.ProcessEnv; first: string; second: string }> {
		requests = [];
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk)).on('end', () => {
				requests.push(Buffer.concat(chunks).toString());
				const payload = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
				if (req.url?.includes(':streamGenerateContent')) {
					res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
				} else {
					res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
				}
			});
		});
		await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
		home = realpathSync(mkdtempSync(path.join(tmpdir(), 'gemini-home-')));
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
		// A stdio MCP server with one tool, `<name>_tool`, that leaves a mark when it starts.
		const serverScript = path.join(home, 'server.js');
		writeFileSync(serverScript, mcpServer);
		// Each folder has its own rules and its own server.
		const folder = (name: string) => {
			const dir = path.join(home!, name);
			mkdirSync(path.join(dir, '.gemini'), { recursive: true });
			writeFileSync(path.join(dir, 'GEMINI.md'), `Rules of the ${name} folder.\n`);
			writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify({
				mcpServers: { [name]: { command: process.execPath, args: [serverScript, name, path.join(home!, `${name}-server-started`)] } },
			}));
			return dir;
		};
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: 'fake',
			GEMINI_CLI_TRUST_WORKSPACE: 'true',
			GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			NO_PROXY: '127.0.0.1',
		};
		// Vitest's own variables switch the CLI into its test behaviour.
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		const [first, second] = folders.map(folder);
		return { env, first, second };
	}

	async function startAgent(env: NodeJS.ProcessEnv, cwd: string): Promise<AgentConnection> {
		const child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), cwd);
		child.stderr.resume();
		children.push(child);
		const connection = new AgentConnection(child.stdin, child.stdout, { sessionUpdate: () => { }, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		connections.push(connection);
		await connection.initialize();
		return connection;
	}

	/** Which folders' rules and MCP tools the model call with `prompt` carried. */
	function sent(prompt: string): { rules: string[]; tools: string[] } {
		const body = requests.findLast(each => each.includes(prompt)) ?? '';
		return {
			rules: folders.filter(name => body.includes(`Rules of the ${name} folder.`)),
			tools: folders.filter(name => body.includes(`${name}_tool`)),
		};
	}

	/** Whose MCP servers have started since the last call. */
	function started(): string[] {
		const marks = folders.filter(name => existsSync(path.join(home!, `${name}-server-started`)));
		marks.forEach(name => rmSync(path.join(home!, `${name}-server-started`)));
		return marks;
	}

	it('opens a new session with its own folder\'s rules and servers', async () => {
		const { env, first, second } = await setUp();
		const agent = await startAgent(env, first);
		const { sessionId } = await agent.newSession(second);
		await agent.setModel(sessionId, 'gemini-2.5-flash');
		await agent.prompt(sessionId, [{ type: 'text', text: 'Hello' }]);
		expect(sent('Hello')).toEqual({ rules: ['billing'], tools: ['billing'] });
	}, 90_000);

	it('reopens a session with the servers of the folder the process started in', async () => {
		const { env, first, second } = await setUp();
		const agent = await startAgent(env, second);
		const { sessionId } = await agent.newSession(second);
		await agent.setModel(sessionId, 'gemini-2.5-flash');
		await agent.prompt(sessionId, [{ type: 'text', text: 'Hello' }]);
		const reopened = await startAgent(env, first);
		// The process starts its own folder's servers as it starts, whatever its sessions use.
		await vi.waitFor(() => expect(existsSync(path.join(home!, 'shop-server-started'))).toBe(true), { timeout: 30_000 });
		started();
		await reopened.loadSession(sessionId, second);
		// gemini-cli 0.64 reopens a session with the settings the process read
		// in its own folder (`loadSession` in its ACP agent): the first folder's
		// servers start, not the session's. When this fails, it uses the
		// session's folder, as a new session does.
		expect(started()).toEqual(['shop']);
	}, 90_000);

	it('reopens a session through GeminiCode\'s runtime on a process of its folder\'s own, which starts its folder\'s servers', async () => {
		const { env, first, second } = await setUp();
		const agent = await startAgent(env, second);
		const { sessionId } = await agent.newSession(second);
		await agent.setModel(sessionId, 'gemini-2.5-flash');
		await agent.prompt(sessionId, [{ type: 'text', text: 'Hello' }]);
		const command = () => resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform });
		const shared = new AgentSidecar({ command, cwd: first, restartDelaysMs: [] });
		const runtime = new AgentRuntime(shared, {
			folderProcess: { needed: async cwd => cwd === second, sidecar: cwd => new AgentSidecar({ command, cwd, restartDelaysMs: [] }) },
		});
		const client = new AgentClient(runtime, { cwd: second, resumeSessionId: sessionId, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
		disposables.push(shared, runtime, client);
		shared.start();
		await vi.waitFor(() => expect(existsSync(path.join(home!, 'shop-server-started'))).toBe(true), { timeout: 30_000 });
		started();
		const ready = await client.whenReady();
		expect({ sessionId: ready.sessionId, started: started() }).toEqual({ sessionId, started: ['billing'] });
	}, 90_000);
});

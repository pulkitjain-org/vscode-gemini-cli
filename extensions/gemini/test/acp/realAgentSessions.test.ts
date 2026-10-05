/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that an agent can reopen a session started in the terminal: the
// session GeminiCode lists from the CLI's files is one `session/load` accepts,
// and the CLI replays its messages. The CLI talks to a fake Gemini API on
// localhost. Skipped unless GEMINI_CLI_PATH points at the CLI. Runs with an empty HOME.

import type * as acp from '@agentclientprotocol/sdk';
import { ChildProcessWithoutNullStreams, execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { findCliSession, listCliSessions } from '../../src/acp/cliSessions';
import { contentBlockToText } from '../../src/acp/sessionUpdates';

const cliPath = process.env.GEMINI_CLI_PATH;

async function startFakeGemini(): Promise<Server> {
	const server = createServer((req, res) => {
		req.resume().on('end', () => {
			const payload = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Rounded to the nearest cent.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
			if (req.url?.includes(':streamGenerateContent')) {
				res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
			} else {
				res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

describe.skipIf(!cliPath)('reopening a saved session over ACP', () => {
	const children: ChildProcessWithoutNullStreams[] = [];
	const connections: AgentConnection[] = [];
	let server: Server | undefined;
	let home: string | undefined;

	afterEach(async () => {
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

	async function setUp(): Promise<{ env: NodeJS.ProcessEnv; work: string; geminiHome: string }> {
		server = await startFakeGemini();
		home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const work = path.join(home, 'shop');
		mkdirSync(work);
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
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
		return { env, work, geminiHome: path.join(home, '.gemini') };
	}

	async function startAgent(env: NodeJS.ProcessEnv, work: string, updates: acp.SessionUpdate[] = []): Promise<AgentConnection> {
		const child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		child.stderr.resume();
		children.push(child);
		const connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: params => void updates.push(params.update),
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		connections.push(connection);
		await connection.initialize();
		return connection;
	}

	async function expectReplay(env: NodeJS.ProcessEnv, work: string, geminiHome: string): Promise<void> {
		const [listed] = await listCliSessions(work, { home: geminiHome });
		expect(listed).toMatchObject({ title: 'Fix the rounding in the cart total', messages: 1 });
		const updates: acp.SessionUpdate[] = [];
		const connection = await startAgent(env, work, updates);
		// By its number: by its id, gemini-cli 0.62 resets the session before reading it.
		const session = await findCliSession(work, listed.id, geminiHome);
		await connection.loadSession(String(session!.index), work);
		await new Promise(resolve => setTimeout(resolve, 500));
		const text = (kind: 'user_message_chunk' | 'agent_message_chunk') => updates.flatMap(u => u.sessionUpdate === kind ? [contentBlockToText(u.content)] : []).join('');
		expect(text('user_message_chunk')).toContain('Fix the rounding in the cart total');
		expect(text('agent_message_chunk')).toContain('Rounded to the nearest cent.');
		// Still listed, under the same id, for the next time.
		expect((await listCliSessions(work, { home: geminiHome })).map(s => s.id)).toEqual([listed.id]);
	}

	it('reopens a session started in the terminal', async () => {
		const { env, work, geminiHome } = await setUp();
		const [command, args] = cliPath!.endsWith('.js') ? [process.execPath, [cliPath!]] : [cliPath!, []];
		await promisify(execFile)(command, [...args, '-m', 'gemini-2.5-flash', '-p', 'Fix the rounding in the cart total'], { cwd: work, env, timeout: 60_000 });
		await expectReplay(env, work, geminiHome);
	}, 90_000);

	it('reopens an agent session after the agent restarts', async () => {
		const { env, work, geminiHome } = await setUp();
		const first = await startAgent(env, work);
		const { sessionId } = await first.newSession(work);
		await first.setModel(sessionId, 'gemini-2.5-flash');
		await first.prompt(sessionId, [{ type: 'text', text: 'Fix the rounding in the cart total' }]);
		await expectReplay(env, work, geminiHome);
	}, 90_000);
});

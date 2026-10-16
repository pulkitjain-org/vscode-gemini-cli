/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that Rewind works on the real CLI: the `$rewindTo` record GeminiCode
// appends to the session file makes `session/load` drop the rewound prompts,
// both from the replay and from what the next request sends to Gemini. The
// CLI talks to a fake Gemini API on localhost. Skipped unless GEMINI_CLI_PATH
// points at the CLI. Runs with an empty HOME.

import type * as acp from '@agentclientprotocol/sdk';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { findCliSession, isPrompt, rewindCliSession } from '../../src/acp/cliSessions';
import { contentBlockToText } from '../../src/acp/sessionUpdates';

const cliPath = process.env.GEMINI_CLI_PATH;

describe.skipIf(!cliPath)('rewinding a session on the real CLI', () => {
	const children: ChildProcessWithoutNullStreams[] = [];
	const connections: AgentConnection[] = [];
	let server: Server | undefined;
	let home: string | undefined;
	/** The text of every request the fake API received. */
	const requests: string[] = [];

	afterEach(async () => {
		connections.splice(0).forEach(c => c.dispose());
		await Promise.all(children.splice(0).map(child => {
			const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : undefined;
			child.kill();
			return exited;
		}));
		server?.close();
		requests.length = 0;
		if (home) {
			rmSync(home, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('drops the rewound prompts from the replay and from the next request', async () => {
		server = createServer((req, res) => {
			let body = '';
			req.on('data', chunk => body += chunk).on('end', () => {
				requests.push(body);
				const payload = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
				if (req.url?.includes(':streamGenerateContent')) {
					res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
				} else {
					res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
				}
			});
		});
		await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
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
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		const updates: acp.SessionUpdate[] = [];
		const child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		child.stderr.resume();
		children.push(child);
		const connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: params => void updates.push(params.update),
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		connections.push(connection);
		await connection.initialize();
		const { sessionId } = await connection.newSession(work);
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		for (const text of ['Fix the rounding in the cart total', 'Add the tax line', 'Show the shipping cost']) {
			await connection.prompt(sessionId, [{ type: 'text', text }]);
		}
		const geminiHome = path.join(home, '.gemini');

		// Back to before "Add the tax line", in the same CLI process, as GeminiCode does.
		expect(await rewindCliSession(work, sessionId, 'Add the tax line', 0, geminiHome)).toBe(true);
		updates.length = 0;
		await connection.loadSession(sessionId, work);
		await new Promise(resolve => setTimeout(resolve, 500));
		const replayed = updates.flatMap(u => u.sessionUpdate === 'user_message_chunk' ? [contentBlockToText(u.content)] : []).filter(isPrompt);
		expect(replayed).toEqual(['Fix the rounding in the cart total']);

		requests.length = 0;
		await connection.prompt(sessionId, [{ type: 'text', text: 'Round down instead' }]);
		const sent = requests.find(body => body.includes('Round down instead'));
		expect(sent).toBeDefined();
		expect(sent).toContain('Fix the rounding in the cart total');
		expect(sent).not.toContain('Add the tax line');
		expect(sent).not.toContain('Show the shipping cost');
		expect(await findCliSession(work, sessionId, geminiHome)).toMatchObject({ messages: 2 });
	}, 120_000);
});

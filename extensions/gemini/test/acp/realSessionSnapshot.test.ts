/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that Fork and Compact work on the real CLI: a copy of a session's
// file, written under a new id where the CLI keeps another folder's sessions,
// opens there with `session/load`, tool calls and all, and the next request
// carries its history; a compacted copy carries the summary and the kept
// prompts instead of the older ones. The CLI talks to a fake Gemini API on
// localhost. Runs against the bundled CLI or GEMINI_CLI_PATH (test/realCli.ts). Runs with an
// empty HOME.

import type * as acp from '@agentclientprotocol/sdk';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';
import { isPrompt, readSessionMessages, registeredChatsFolder, rewindCliSession } from '../../src/acp/cliSessions';
import { compactedMessages, compactSplit, messagesBefore, summaryMarker, summaryPrompt, writeSessionCopy } from '../../src/acp/sessionSnapshot';
import { contentBlockToText } from '../../src/acp/sessionUpdates';
import { describeRealCli, realCliPath } from '../realCli';

const cliPath = realCliPath;

describeRealCli('session snapshots on the real CLI', () => {
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

	it('opens a copy in another folder, a compacted copy and a copy cut at a prompt', async () => {
		server = createServer((req, res) => {
			let body = '';
			req.on('data', chunk => body += chunk).on('end', () => {
				requests.push(body);
				// "Read the cart" makes the model read cart.txt, so the session has a tool call and its result.
				const contents = (JSON.parse(body) as { contents?: { parts?: { text?: string; functionResponse?: unknown }[] }[] }).contents ?? [];
				const last = contents[contents.length - 1]?.parts ?? [];
				const readCart = last.some(part => part.text?.includes('Read the cart')) && !last.some(part => part.functionResponse);
				// 'Write over the parent cart' makes it try to write outside its folder, into the parent's.
				const writeParent = last.some(part => part.text?.includes('Write over the parent cart')) && !last.some(part => part.functionResponse);
				const parts = readCart ? [{ functionCall: { name: 'read_file', args: { file_path: 'cart.txt' } } }]
					: writeParent ? [{ functionCall: { name: 'write_file', args: { file_path: path.join(work, 'cart.txt'), content: 'CHANGED\n' } } }]
						: [{ text: 'Done.' }];
				const payload = JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
				if (req.url?.includes(':streamGenerateContent')) {
					res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
				} else {
					res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
				}
			});
		});
		await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
		// The real path: GeminiCode opens sessions on it, and the CLI keys them by the path it is given.
		home = realpathSync(mkdtempSync(path.join(tmpdir(), 'gemini-home-')));
		const work = path.join(home, 'shop');
		const fork = path.join(home, 'shop-fork');
		for (const folder of [work, fork]) {
			mkdirSync(folder);
			writeFileSync(path.join(folder, 'cart.txt'), 'CART-TOTAL-42\n');
		}
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
		const updates: { readonly sessionId: string; readonly update: acp.SessionUpdate }[] = [];
		const child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform }), work);
		child.stderr.resume();
		children.push(child);
		const connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: params => void updates.push({ sessionId: params.sessionId, update: params.update }),
			requestPermission: async params => ({ outcome: { outcome: 'selected', optionId: params.options.find(o => o.kind === 'allow_once')?.optionId ?? params.options[0].optionId } }),
		});
		connections.push(connection);
		await connection.initialize();
		const { sessionId } = await connection.newSession(work);
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		for (const text of ['Read the cart', 'Add the tax line', 'Show the shipping cost']) {
			await connection.prompt(sessionId, [{ type: 'text', text }]);
		}
		const geminiHome = path.join(home, '.gemini');
		const parent = await readSessionMessages(work, sessionId, geminiHome);
		expect(parent?.messages.some(m => Array.isArray(m.toolCalls) && m.toolCalls.length > 0)).toBe(true);
		const parentFile = JSON.stringify(parent);

		// The CLI registers a folder when it first opens a session there.
		expect(await registeredChatsFolder(fork, geminiHome)).toBeUndefined();
		await connection.newSession(fork);
		expect(await registeredChatsFolder(fork, geminiHome)).toBeDefined();

		/** Opens `id` in the fork's folder, sends a prompt, and says what was replayed and what the request carried. */
		const open = async (id: string, text: string) => {
			updates.length = 0;
			await connection.loadSession(id, fork);
			// As GeminiCode does for every reopened session; Auto would make the CLI ask the fake API to route.
			await connection.setModel(id, 'gemini-2.5-flash');
			await new Promise(resolve => setTimeout(resolve, 500));
			const mine = updates.filter(u => u.sessionId === id).map(u => u.update);
			const replayed = mine.flatMap(u => u.sessionUpdate === 'user_message_chunk' ? [contentBlockToText(u.content)] : []).filter(text => isPrompt(text) && !text.startsWith('[Function Response'));
			const toolCalls = mine.filter(u => u.sessionUpdate === 'tool_call').length;
			requests.length = 0;
			await connection.prompt(id, [{ type: 'text', text }]);
			return { replayed, toolCalls, sent: requests.find(body => body.includes(text)) ?? '' };
		};

		// A whole copy: the same history, the tool result included.
		const whole = await open(await writeSessionCopy(fork, parent!.messages, { home: geminiHome }), 'Next step');
		expect(whole.replayed).toEqual(['Read the cart', 'Add the tax line', 'Show the shipping cost']);
		expect(whole.toolCalls).toBe(1);
		expect(whole.sent).toContain('CART-TOTAL-42');
		expect(whole.sent).toContain('Show the shipping cost');
		// The CLI's session context is made again for the folder the copy opened in.
		expect(whole.sent).toContain(`${fork}/`);
		expect(whole.sent).not.toContain(`${work}/`);

		// Compacted: the summary and the latest prompt, without the older ones.
		const split = compactSplit(parent!.messages, 1, 1);
		const compacted = await open(await writeSessionCopy(fork, compactedMessages(parent!.messages, 'SUMMARY-OF-CART-WORK', split), { home: geminiHome }), 'Carry on');
		expect(compacted.replayed.at(-1)).toBe('Show the shipping cost');
		expect(compacted.sent).toContain('SUMMARY-OF-CART-WORK');
		expect(compacted.sent).toContain('Show the shipping cost');
		expect(compacted.sent).not.toContain('Add the tax line');

		// Cut before a prompt, for Fork from Here.
		const cut = await open(await writeSessionCopy(fork, messagesBefore(parent!.messages, 'Add the tax line', 0)!, { home: geminiHome }), 'Instead, show a discount');
		expect(cut.replayed).toEqual(['Read the cart']);
		expect(cut.sent).not.toContain('Add the tax line');

		// The copy can't write to the parent's folder, even with every permission allowed.
		await open(await writeSessionCopy(fork, parent!.messages, { home: geminiHome }), 'Write over the parent cart');
		expect(requests.some(body => body.includes('Path not in workspace'))).toBe(true);

		// The forks left the parent's session and files untouched.
		expect(JSON.stringify(await readSessionMessages(work, sessionId, geminiHome))).toBe(parentFile);
		expect(readFileSync(path.join(work, 'cart.txt'), 'utf8')).toBe('CART-TOTAL-42\n');
		// Compact in place: the summary's turn goes again from the session it compacts, which then reads as before.
		await connection.loadSession(sessionId, work);
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		const ids = (await readSessionMessages(work, sessionId, geminiHome))!.messages.map(m => m.id);
		await connection.prompt(sessionId, [{ type: 'text', text: summaryPrompt }]);
		expect((await readSessionMessages(work, sessionId, geminiHome))!.messages.length).toBeGreaterThan(ids.length);
		expect(await rewindCliSession(work, sessionId, summaryMarker, 0, geminiHome)).toBe(true);
		expect((await readSessionMessages(work, sessionId, geminiHome))!.messages.map(m => m.id)).toEqual(ids);
		const inPlace = await writeSessionCopy(work, compactedMessages(parent!.messages, 'SUMMARY-IN-PLACE', split), { home: geminiHome });
		await connection.loadSession(inPlace, work);
		await connection.setModel(inPlace, 'gemini-2.5-flash');
		requests.length = 0;
		await connection.prompt(inPlace, [{ type: 'text', text: 'After compacting' }]);
		expect(requests.find(body => body.includes('After compacting'))).toContain('SUMMARY-IN-PLACE');

	}, 120_000);
});

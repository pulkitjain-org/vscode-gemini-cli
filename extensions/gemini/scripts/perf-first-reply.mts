/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Times what the first reply of a chat waits for: the agent starting
// (`initialize`), its session opening (`session/new`), and the prompt until
// the first text arrives, with the model on Auto and with one picked. It runs
// the real Gemini CLI against a local stand-in for the Gemini API, so it needs
// no account and no network, and each model call takes --latency ms.
//
//   node --experimental-transform-types --no-warnings extensions/gemini/scripts/perf-first-reply.mts --cli <gemini.js> [--runs 3] [--latency 300]
//
// Starting early and the spare session take the first two off the first
// prompt; picking a model takes off Auto's routing call (one more --latency).

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';

const { values: args } = parseArgs({
	options: {
		cli: { type: 'string' },
		runs: { type: 'string', default: '3' },
		latency: { type: 'string', default: '300' },
	},
});
if (!args.cli) {
	console.log('Pass --cli with the Gemini CLI to run, such as node_modules/@google/gemini-cli/bundle/gemini.js.');
	process.exit(1);
}
const cli = path.resolve(args.cli);
const latencyMs = Number(args.latency);

const server = createServer((req, res) => {
	req.resume().on('end', () => setTimeout(() => {
		const payload = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
		if (req.url?.includes(':streamGenerateContent')) {
			res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
		} else {
			// Auto's routing call asks for JSON naming the model.
			const routed = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ reasoning: 'simple', model_choice: 'flash' }) }] }, finishReason: 'STOP' }] });
			res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('lite') ? routed : payload);
		}
	}, latencyMs));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

interface Run { readonly initialize: number; readonly sessionNew: number; readonly autoReply: number; readonly pickedReply: number }

async function run(): Promise<Run> {
	const home = mkdtempSync(path.join(tmpdir(), 'perf-home-'));
	const work = path.join(home, 'work');
	mkdirSync(work);
	mkdirSync(path.join(home, '.gemini'));
	writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, privacy: { usageStatisticsEnabled: false } }));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GEMINI_API_KEY: 'placeholder',
		GEMINI_CLI_NO_RELAUNCH: 'true',
		GEMINI_CLI_TRUST_WORKSPACE: 'true',
		GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		NO_PROXY: '127.0.0.1',
	};
	for (const key of Object.keys(env).filter(k => /^https?_proxy$/i.test(k))) {
		delete env[key];
	}
	const started = performance.now();
	const child = spawn(process.execPath, [cli, '--acp'], { cwd: work, env, stdio: 'pipe' });
	child.stderr.resume();
	const firstText = new Map<string, () => void>();
	const connection = acp.client({ name: 'perf' })
		.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' as const } }))
		.onNotification('session/update', ctx => {
			if (ctx.params.update.sessionUpdate === 'agent_message_chunk') {
				firstText.get(ctx.params.sessionId)?.();
				firstText.delete(ctx.params.sessionId);
			}
		})
		.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	try {
		await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
		const initialize = performance.now() - started;

		const opening = performance.now();
		const auto = await connection.agent.request('session/new', { cwd: work, mcpServers: [] });
		const sessionNew = performance.now() - opening;
		const picked = await connection.agent.request('session/new', { cwd: work, mcpServers: [] });
		const models = (picked as { models?: { availableModels?: { modelId: string }[] } }).models?.availableModels?.map(m => m.modelId) ?? [];
		const flash = models.find(id => /flash/i.test(id) && !/lite/i.test(id));
		if (flash) {
			await (connection.agent.request as (method: string, params: unknown) => Promise<unknown>)('session/set_model', { sessionId: picked.sessionId, modelId: flash });
		}

		const firstReply = async (sessionId: string): Promise<number> => {
			const asked = performance.now();
			const text = new Promise<number>(resolve => firstText.set(sessionId, () => resolve(performance.now() - asked)));
			await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Say done.' }] });
			return text;
		};
		return { initialize, sessionNew, autoReply: await firstReply(auto.sessionId), pickedReply: await firstReply(picked.sessionId) };
	} finally {
		child.kill();
		rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	}
}

const runs: Run[] = [];
for (let i = 0; i < Number(args.runs); i++) {
	runs.push(await run());
}
server.close();

const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const row = (name: string, key: keyof Run) => console.log(`${name.padEnd(36)} ${median(runs.map(r => r[key])).toFixed(0).padStart(6)} ms`);
console.log(`Median of ${runs.length} runs, each model call ${latencyMs} ms:`);
row('Agent start (initialize)', 'initialize');
row('Session open (session/new)', 'sessionNew');
row('First text, model on Auto', 'autoReply');
row('First text, Flash picked', 'pickedReply');

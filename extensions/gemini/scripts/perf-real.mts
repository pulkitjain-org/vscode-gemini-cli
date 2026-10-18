/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Measures a chat's first reply on a real account: the agent starting, a
// session opening, and one short prompt with the model on Auto and one with
// Flash picked, with the sign-in the Gemini CLI saved (read by the CLI, never
// by this script). It starts the CLI as GeminiCode does (GEMINI_CLI_NO_RELAUNCH)
// and changes none of its files: the folder's trust is what the user set.
//
//   node --experimental-transform-types --no-warnings extensions/gemini/scripts/perf-real.mts --cli <gemini.js> --folder <folder> [--project <id>] [--runs 3]
//
// --project is passed as GOOGLE_CLOUD_PROJECT, as GeminiCode passes gemini.projectId.
//
// Each run makes about five model calls (Auto adds a routing call). It also
// times `initialize` with the CLI's own relaunch left on, which makes none.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';

const { values: args } = parseArgs({ options: { cli: { type: 'string' }, folder: { type: 'string' }, project: { type: 'string' }, runs: { type: 'string', default: '3' } } });
if (!args.cli || !args.folder) {
	console.log('Pass --cli (bundle/gemini.js) and --folder (where the agent works).');
	process.exit(1);
}
const cli = path.resolve(args.cli);
const folder = path.resolve(args.folder);
const prompt = 'Reply with the single word: ok. Use no tools.';

function killTree(child: ChildProcessWithoutNullStreams): void {
	try {
		execFileSync('pkill', ['-P', String(child.pid)]);
	} catch {
		// No children.
	}
	child.kill();
}

function rssMb(child: ChildProcessWithoutNullStreams): number {
	return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)]).toString().trim()) / 1024);
}

function start(relaunch: boolean) {
	const env: NodeJS.ProcessEnv = { ...process.env, ...args.project ? { GOOGLE_CLOUD_PROJECT: args.project } : {}, ...relaunch ? {} : { GEMINI_CLI_NO_RELAUNCH: 'true' } };
	const child = spawn(process.execPath, [cli, '--acp'], { cwd: folder, env, stdio: 'pipe' });
	child.stderr.resume();
	const listeners = new Map<string, (update: acp.SessionUpdate) => void>();
	const connection = acp.client({ name: 'perf-real' })
		.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' as const } }))
		.onNotification('session/update', ctx => listeners.get(ctx.params.sessionId)?.(ctx.params.update))
		.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	const request = connection.agent.request as (method: string, params: unknown) => Promise<unknown>;
	return { child, listeners, request: (method: string, params: unknown) => request.call(connection.agent, method, params) };
}

interface Turn { readonly firstTextMs: number | null; readonly turnMs: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly modelCalls: number; readonly model: string }

async function turn(agent: ReturnType<typeof start>, sessionId: string, model: string): Promise<Turn> {
	let firstText: number | null = null;
	let calls = 0;
	const asked = performance.now();
	agent.listeners.set(sessionId, update => {
		if (update.sessionUpdate === 'agent_message_chunk' && firstText === null) {
			firstText = performance.now() - asked;
		}
		if (update.sessionUpdate === 'usage_update') {
			calls++;
		}
	});
	const answer = await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }) as { _meta?: { quota?: { token_count?: { input_tokens?: number; output_tokens?: number }; model_usage?: unknown[] } }; usage?: { inputTokens?: number; outputTokens?: number } };
	const turnMs = performance.now() - asked;
	const quota = answer._meta?.quota;
	return {
		firstTextMs: firstText, turnMs,
		inputTokens: answer.usage?.inputTokens ?? quota?.token_count?.input_tokens ?? null,
		outputTokens: answer.usage?.outputTokens ?? quota?.token_count?.output_tokens ?? null,
		modelCalls: Math.max(calls, quota?.model_usage?.length ?? 0),
		model,
	};
}

interface Run {
	readonly initialize: number; readonly initializeRelaunch: number | null; readonly sessionNew: number; readonly secondSessionNew: number;
	readonly rssAfterInit: number; readonly rssAfterSessions: number; readonly auto: Turn; readonly flash: Turn; readonly cliVersion: string;
}

async function run(): Promise<Run> {
	// The relaunch costs only start-up; time it without any session. It may not answer at all (null).
	const relaunched = start(true);
	const relaunchStart = performance.now();
	const answered = await Promise.race([
		relaunched.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }).then(() => true, () => false),
		new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30_000)),
	]);
	const initializeRelaunch = answered ? performance.now() - relaunchStart : null;
	// The wrapper's own child would outlive a plain kill of the wrapper.
	killTree(relaunched.child);

	const agent = start(false);
	try {
		const started = performance.now();
		const info = await agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }) as { agentInfo?: { version?: string } };
		const initialize = performance.now() - started;
		const rssAfterInit = rssMb(agent.child);
		const opening = performance.now();
		const first = await agent.request('session/new', { cwd: folder, mcpServers: [] }) as { sessionId: string; models?: { availableModels?: { modelId: string }[]; currentModelId?: string } };
		const sessionNew = performance.now() - opening;
		const reopening = performance.now();
		const second = await agent.request('session/new', { cwd: folder, mcpServers: [] }) as { sessionId: string };
		const secondSessionNew = performance.now() - reopening;
		const rssAfterSessions = rssMb(agent.child);
		const models = first.models?.availableModels?.map(m => m.modelId) ?? [];
		const flash = models.find(id => /flash/i.test(id) && !/lite/i.test(id) && !/auto/i.test(id)) ?? '';
		// Auto, picked explicitly: the account's settings may name a model of their own.
		const autoId = models.find(id => /^auto/i.test(id));
		if (autoId) {
			await agent.request('session/set_model', { sessionId: first.sessionId, modelId: autoId });
		}
		const auto = await turn(agent, first.sessionId, autoId ?? first.models?.currentModelId ?? '?');
		if (flash) {
			await agent.request('session/set_model', { sessionId: second.sessionId, modelId: flash });
		}
		const picked = await turn(agent, second.sessionId, flash);
		return { initialize, initializeRelaunch, sessionNew, secondSessionNew, rssAfterInit, rssAfterSessions, auto, flash: picked, cliVersion: info.agentInfo?.version ?? '?' };
	} finally {
		agent.child.kill();
	}
}

const runs: Run[] = [];
for (let i = 0; i < Number(args.runs); i++) {
	const result = await run();
	runs.push(result);
	console.error(`run ${i + 1}: ${JSON.stringify(result)}`);
}
const median = (values: (number | null)[]) => {
	const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
	return known.length ? known[Math.floor(known.length / 2)] : null;
};
const show = (name: string, values: (number | null)[], unit = 'ms') => console.log(`${name.padEnd(44)} ${String(median(values)?.toFixed(0) ?? '-').padStart(7)} ${unit}  (${values.map(v => v === null ? '-' : v.toFixed(0)).join(', ')})`);
console.log(`gemini-cli ${runs[0].cliVersion}, ${folder}, median of ${runs.length} runs:`);
show('initialize, the CLI relaunching itself', runs.map(r => r.initializeRelaunch));
show('initialize, GEMINI_CLI_NO_RELAUNCH', runs.map(r => r.initialize));
show('session/new, first', runs.map(r => r.sessionNew));
show('session/new, second in the process', runs.map(r => r.secondSessionNew));
show('memory after initialize', runs.map(r => r.rssAfterInit), 'MB');
show('memory after two sessions', runs.map(r => r.rssAfterSessions), 'MB');
show(`first text, ${runs[0].auto.model}`, runs.map(r => r.auto.firstTextMs));
show(`whole turn, ${runs[0].auto.model}`, runs.map(r => r.auto.turnMs));
show(`model calls, ${runs[0].auto.model}`, runs.map(r => r.auto.modelCalls), '');
show(`input tokens, ${runs[0].auto.model}`, runs.map(r => r.auto.inputTokens), '');
show(`first text, ${runs[0].flash.model}`, runs.map(r => r.flash.firstTextMs));
show(`whole turn, ${runs[0].flash.model}`, runs.map(r => r.flash.turnMs));
show(`model calls, ${runs[0].flash.model}`, runs.map(r => r.flash.modelCalls), '');
show(`input tokens, ${runs[0].flash.model}`, runs.map(r => r.flash.inputTokens), '');
show(`output tokens, ${runs[0].flash.model}`, runs.map(r => r.flash.outputTokens), '');
process.exit(0);

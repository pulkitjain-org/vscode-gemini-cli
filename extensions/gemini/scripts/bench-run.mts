/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the benchmark tasks in gemini/bench/tasks against a Gemini CLI, the way
// GeminiCode's agent runs it: `gemini --acp` with the user's saved sign-in,
// one session per task in a fresh worktree at the task's base commit. See
// README.md for the task files and the result columns.
//
//   node --experimental-transform-types extensions/gemini/scripts/bench-run.mts --cli <gemini.js or gemini> --model <id>
//     [--tasks gemini/bench/tasks] [--out gemini/bench/results/<version>.json] [--only ACME-412,ACME-413]
//     [--timeout 1200000] [--project <google cloud project id>]
//
// The CLI is started with GEMINI_CLI_NO_RELAUNCH, as the app starts it. Tool
// calls are allowed (the session runs in Auto Edit, and shell commands are
// answered with the allow-once option), so run this only on tasks you chose.

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';

const run = promisify(execFile);
const { values: args } = parseArgs({
	options: {
		cli: { type: 'string' }, model: { type: 'string' },
		tasks: { type: 'string', default: path.resolve(import.meta.dirname, '..', '..', '..', 'gemini', 'bench', 'tasks') },
		out: { type: 'string' }, only: { type: 'string' }, timeout: { type: 'string', default: '1200000' }, project: { type: 'string' },
	},
});
if (!args.cli || !args.model) {
	console.error('Pass --cli (the gemini executable or bundle/gemini.js) and --model.');
	process.exit(2);
}
const cli = path.resolve(args.cli);
const turnTimeoutMs = Number(args.timeout);
const only = new Set((args.only ?? '').split(',').map(s => s.trim()).filter(Boolean));

interface Task {
	readonly key: string;
	readonly repo: string;
	readonly baseSha: string;
	readonly prompt: string;
	readonly grader: { readonly command: string; readonly timeoutMs?: number };
	readonly touchedFiles?: readonly string[];
}

interface Result {
	readonly key: string;
	readonly model: string;
	readonly completed: boolean;
	readonly requests: number;
	readonly tokensIn: number;
	readonly tokensOut: number;
	readonly firstTextMs: number | null;
	readonly wallMs: number;
	readonly graderMs: number;
	readonly graderExit: number | null;
	readonly changedFiles: readonly string[];
	readonly touchedByAuthorAlso: readonly string[];
	readonly stopReason: string;
	readonly error?: string;
}

const tasks: Task[] = readdirSync(args.tasks!).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(args.tasks!, f), 'utf8')) as Task).filter(t => !only.size || only.has(t.key));
if (!tasks.length) {
	console.error(`No tasks in ${args.tasks}.`);
	process.exit(2);
}

/** The agent process: one per task, so a task starts cold, as a developer's first prompt of the day does. */
function startAgent(cwd: string) {
	const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true', ...args.project ? { GOOGLE_CLOUD_PROJECT: args.project } : {} };
	const isScript = /\.(c|m)?js$/.test(cli);
	const child = spawn(isScript ? process.execPath : cli, isScript ? [cli, '--acp'] : ['--acp'], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
	let firstText: number | null = null;
	let requests = 0;
	let promptStart = 0;
	const connection = acp.client({ name: 'geminicode-bench' })
		// Allow once, as a person who trusts the task would; never "always".
		.onRequest('session/request_permission', async ctx => {
			const once = ctx.params.options.find(o => o.kind === 'allow_once') ?? ctx.params.options[0];
			return { outcome: { outcome: 'selected' as const, optionId: once.optionId } };
		})
		.onNotification('session/update', ctx => {
			const update = ctx.params.update as { sessionUpdate?: string; content?: { type?: string } };
			if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && firstText === null && promptStart) {
				firstText = Date.now() - promptStart;
			}
			if (update.sessionUpdate === 'usage_update') {
				requests++;
			}
		})
		.connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
	return {
		child, connection,
		firstText: () => firstText,
		requests: () => requests,
		setPromptStart: (t: number) => { promptStart = t; },
	};
}

async function runTask(task: Task, work: string): Promise<Result> {
	const started = Date.now();
	const repo = path.join(work, task.key);
	await run('git', ['clone', '--quiet', '--no-checkout', task.repo, repo]);
	await run('git', ['-C', repo, 'checkout', '--quiet', task.baseSha]);
	const agent = startAgent(repo);
	let stopReason = 'not started';
	let requests = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let error: string | undefined;
	let promptMs = 0;
	try {
		const request = agent.connection.agent.request as (method: string, params: unknown) => Promise<unknown>;
		await request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
		const session = await request('session/new', { cwd: repo, mcpServers: [] }) as { sessionId: string; modes?: { availableModes?: { id: string }[] } };
		const autoEdit = session.modes?.availableModes?.find(m => /auto/i.test(m.id))?.id;
		if (autoEdit) {
			await request('session/set_mode', { sessionId: session.sessionId, modeId: autoEdit });
		}
		await request('session/set_model', { sessionId: session.sessionId, modelId: args.model! });
		const promptStart = Date.now();
		agent.setPromptStart(promptStart);
		const response = await Promise.race([
			request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: task.prompt }] }) as Promise<{ stopReason: string; _meta?: unknown }>,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no end of turn after ${turnTimeoutMs} ms`)), turnTimeoutMs)),
		]);
		promptMs = Date.now() - promptStart;
		stopReason = response.stopReason;
		const quota = (response._meta as { quota?: { token_count?: { input_tokens?: number; output_tokens?: number }; model_usage?: unknown[] } } | undefined)?.quota;
		tokensIn = quota?.token_count?.input_tokens ?? 0;
		tokensOut = quota?.token_count?.output_tokens ?? 0;
		requests = Math.max(agent.requests(), quota?.model_usage?.length ?? 0);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		promptMs = Date.now() - started;
	} finally {
		agent.child.kill();
	}
	const changed = (await run('git', ['-C', repo, 'status', '--porcelain']).then(r => r.stdout, () => '')).split('\n').filter(Boolean).map(l => l.slice(3).trim());
	const graderStart = Date.now();
	let graderExit: number | null = null;
	if (!error) {
		graderExit = await new Promise<number | null>(resolve => {
			const child = spawn(task.grader.command, { cwd: repo, shell: true, stdio: 'inherit' });
			const timer = setTimeout(() => child.kill('SIGKILL'), task.grader.timeoutMs ?? 600_000);
			child.on('close', code => { clearTimeout(timer); resolve(code); });
			child.on('error', () => { clearTimeout(timer); resolve(null); });
		});
	}
	return {
		key: task.key, model: args.model!, completed: graderExit === 0, requests, tokensIn, tokensOut,
		firstTextMs: agent.firstText(), wallMs: promptMs, graderMs: Date.now() - graderStart, graderExit,
		changedFiles: changed, touchedByAuthorAlso: changed.filter(f => task.touchedFiles?.includes(f)), stopReason, ...error ? { error } : {},
	};
}

const work = mkdtempSync(path.join(tmpdir(), 'geminicode-bench-'));
const results: Result[] = [];
for (const task of tasks) {
	console.log(`\n== ${task.key}`);
	const result = await runTask(task, work);
	results.push(result);
	console.log(`${task.key}: ${result.completed ? 'completed' : 'not completed'}, ${result.requests} requests, ${result.tokensIn} in / ${result.tokensOut} out, first text ${result.firstTextMs ?? '-'} ms, ${Math.round(result.wallMs / 1000)} s${result.error ? `, error: ${result.error}` : ''}`);
	rmSync(path.join(work, task.key), { recursive: true, force: true });
}
rmSync(work, { recursive: true, force: true });
const summary = {
	ranAt: new Date().toISOString(),
	cli: cli,
	model: args.model,
	tasks: results.length,
	completed: results.filter(r => r.completed).length,
	completionRate: results.length ? Math.round(results.filter(r => r.completed).length / results.length * 100) / 100 : 0,
	requestsPerCompletedTask: results.filter(r => r.completed).length ? Math.round(results.filter(r => r.completed).reduce((n, r) => n + r.requests, 0) / results.filter(r => r.completed).length * 10) / 10 : null,
	medianFirstTextMs: median(results.map(r => r.firstTextMs).filter((v): v is number => v !== null)),
	medianWallMs: median(results.map(r => r.wallMs)),
	results,
};
const out = args.out ?? path.join(path.resolve(import.meta.dirname, '..', '..', '..', 'gemini', 'bench', 'results'), `${new Date().toISOString().slice(0, 10)}-${args.model}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(summary, null, '\t')}\n`);
console.log(`\n${summary.completed} of ${summary.tasks} completed; ${summary.requestsPerCompletedTask ?? '-'} requests per completed task; median first text ${summary.medianFirstTextMs ?? '-'} ms. Written to ${out}.`);

function median(values: readonly number[]): number | null {
	if (!values.length) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

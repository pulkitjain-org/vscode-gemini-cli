/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The benchmark (gemini/bench/README.md): each task's
// repository is cloned at its base commit, the CLI gets the ticket as its prompt in one session,
// and the task's own test command grades the result. Gemini: Run Benchmark and
// scripts/bench-run.mts both run it through here.
//
// This module imports nothing relative, so the script can load it with Node's type stripping, and
// it is loaded only when a benchmark starts, so the ACP SDK it needs stays out of activation.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';

const run = promisify(execFile);

/** One task file in gemini/bench/tasks. */
export interface BenchTask {
	readonly key: string;
	readonly repo: string;
	readonly baseSha: string;
	readonly prompt: string;
	readonly grader: { readonly command: string; readonly timeoutMs?: number };
	readonly touchedFiles?: readonly string[];
}

/** How one task went. */
export interface BenchResult {
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

/** A results file: one model on one release, as gemini/bench/results holds them. */
export interface BenchSummary {
	readonly ranAt: string;
	readonly geminiCodeVersion?: string;
	readonly cliVersion?: string;
	readonly model: string;
	readonly tasks: number;
	readonly completed: number;
	readonly completionRate: number;
	readonly requestsPerCompletedTask: number | null;
	readonly medianFirstTextMs: number | null;
	readonly medianWallMs: number | null;
	readonly results: readonly BenchResult[];
}

/** How to start the CLI: the same shape as the app's agent command. */
export interface BenchAgentCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly shell?: boolean;
}

export interface BenchOptions {
	readonly tasks: readonly BenchTask[];
	readonly agent: BenchAgentCommand;
	readonly model: string;
	readonly geminiCodeVersion?: string;
	readonly cliVersion?: string;
	/** The longest one turn may take; 20 minutes by default. */
	readonly turnTimeoutMs?: number;
	/** Each line of progress, for a log or the console. */
	readonly log?: (line: string) => void;
	/** Called as each task starts, with its place in the run. */
	readonly onTask?: (task: BenchTask, index: number) => void;
	/** Stops the run: the task in flight is ended and no further task starts. */
	readonly signal?: AbortSignal;
	/** Where the clones go; a fresh temporary folder by default. */
	readonly workDir?: string;
}

/** Reads every task file in `dir`, or only the keys in `only` when it names any. */
export async function readBenchTasks(dir: string, only: readonly string[] = []): Promise<BenchTask[]> {
	const wanted = new Set(only);
	const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
	const tasks = await Promise.all(files.map(async f => JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as BenchTask));
	return tasks.filter(t => !wanted.size || wanted.has(t.key));
}

/** The results file's name: `<GeminiCode version>-<CLI version>-<model>.json`, with `dev` for a build that has no version. */
export function benchResultsFileName(summary: Pick<BenchSummary, 'geminiCodeVersion' | 'cliVersion' | 'model'>): string {
	const part = (value: string | undefined) => (value ?? 'dev').replace(/[^\w.-]+/g, '-');
	return `${part(summary.geminiCodeVersion)}-${part(summary.cliVersion)}-${part(summary.model)}.json`;
}

/** Runs every task in turn and sums them up. A cancelled run returns the tasks finished so far. */
export async function runBenchmark(options: BenchOptions): Promise<BenchSummary> {
	const log = options.log ?? (() => { });
	const work = options.workDir ?? await fs.mkdtemp(path.join(tmpdir(), 'geminicode-bench-'));
	const results: BenchResult[] = [];
	try {
		for (const [index, task] of options.tasks.entries()) {
			if (options.signal?.aborted) {
				break;
			}
			options.onTask?.(task, index);
			log(`== ${task.key}`);
			const result = await runTask(task, path.join(work, task.key), options);
			results.push(result);
			log(`${task.key}: ${result.completed ? 'completed' : 'not completed'}, ${result.requests} requests, ${result.tokensIn} in / ${result.tokensOut} out, first text ${result.firstTextMs ?? '-'} ms, ${Math.round(result.wallMs / 1000)} s${result.error ? `, error: ${result.error}` : ''}`);
			await fs.rm(path.join(work, task.key), { recursive: true, force: true });
		}
	} finally {
		if (!options.workDir) {
			await fs.rm(work, { recursive: true, force: true });
		}
	}
	return summarize(results, options);
}

function summarize(results: readonly BenchResult[], options: BenchOptions): BenchSummary {
	const completed = results.filter(r => r.completed);
	return {
		ranAt: new Date().toISOString(),
		...options.geminiCodeVersion ? { geminiCodeVersion: options.geminiCodeVersion } : {},
		...options.cliVersion ? { cliVersion: options.cliVersion } : {},
		model: options.model,
		tasks: results.length,
		completed: completed.length,
		completionRate: results.length ? Math.round(completed.length / results.length * 100) / 100 : 0,
		requestsPerCompletedTask: completed.length ? Math.round(completed.reduce((n, r) => n + r.requests, 0) / completed.length * 10) / 10 : null,
		medianFirstTextMs: median(results.map(r => r.firstTextMs).filter((v): v is number => v !== null)),
		medianWallMs: median(results.map(r => r.wallMs)),
		results,
	};
}

/** The agent process: one per task, so a task starts cold, as a developer's first prompt of the day does. */
function startAgent(command: BenchAgentCommand, cwd: string) {
	const child = spawn(command.command, [...command.args], { cwd, env: command.env, shell: command.shell, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
		.connect(acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	// Typed by method name in the SDK; the benchmark sends a handful of plain requests.
	const agentSide = connection.agent as unknown as { request(method: string, params: unknown): Promise<unknown> };
	return {
		child,
		request: (method: string, params: unknown) => agentSide.request(method, params),
		firstText: () => firstText,
		requests: () => requests,
		setPromptStart: (t: number) => { promptStart = t; },
	};
}

async function runTask(task: BenchTask, repo: string, options: BenchOptions): Promise<BenchResult> {
	const started = Date.now();
	const turnTimeoutMs = options.turnTimeoutMs ?? 1_200_000;
	let stopReason = 'not started';
	let requests = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let error: string | undefined;
	let promptMs = 0;
	let agent: ReturnType<typeof startAgent> | undefined;
	const stop = () => agent?.child.kill();
	options.signal?.addEventListener('abort', stop);
	try {
		await run('git', ['clone', '--quiet', '--no-checkout', task.repo, repo]);
		await run('git', ['-C', repo, 'checkout', '--quiet', task.baseSha]);
		if (options.signal?.aborted) {
			throw new Error('cancelled');
		}
		agent = startAgent(options.agent, repo);
		const exited = new Promise<never>((_, reject) => agent!.child.once('exit', code => reject(new Error(options.signal?.aborted ? 'cancelled' : `the CLI exited with code ${code}`))));
		// The process is killed once the task ends, which rejects this after every race is over.
		exited.catch(() => { });
		const ask = <T>(method: string, params: unknown) => Promise.race([agent!.request(method, params) as Promise<T>, exited]);
		await ask('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
		const session = await ask<{ sessionId: string; modes?: { availableModes?: { id: string }[] } }>('session/new', { cwd: repo, mcpServers: [] });
		const autoEdit = session.modes?.availableModes?.find(m => /auto/i.test(m.id))?.id;
		if (autoEdit) {
			await ask('session/set_mode', { sessionId: session.sessionId, modeId: autoEdit });
		}
		await ask('session/set_model', { sessionId: session.sessionId, modelId: options.model });
		const promptStart = Date.now();
		agent.setPromptStart(promptStart);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const response = await Promise.race([
			ask<{ stopReason: string; _meta?: unknown }>('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: task.prompt }] }),
			new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error(`no end of turn after ${turnTimeoutMs} ms`)), turnTimeoutMs)),
		]).finally(() => clearTimeout(timer));
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
		options.signal?.removeEventListener('abort', stop);
		agent?.child.kill();
	}
	const changed = (await run('git', ['-C', repo, 'status', '--porcelain']).then(r => r.stdout, () => '')).split('\n').filter(Boolean).map(l => l.slice(3).trim());
	const graderStart = Date.now();
	const graderExit = error ? null : await grade(task, repo, options.signal);
	return {
		key: task.key, model: options.model, completed: graderExit === 0, requests, tokensIn, tokensOut,
		firstTextMs: agent?.firstText() ?? null, wallMs: promptMs, graderMs: Date.now() - graderStart, graderExit,
		changedFiles: changed, touchedByAuthorAlso: changed.filter(f => task.touchedFiles?.includes(f)), stopReason, ...error ? { error } : {},
	};
}

/** Runs the task's own test command in the agent's working tree; its exit code, or null if it could not run or was stopped. */
function grade(task: BenchTask, repo: string, signal: AbortSignal | undefined): Promise<number | null> {
	return new Promise(resolve => {
		const child: ChildProcess = spawn(task.grader.command, { cwd: repo, shell: true, stdio: 'ignore' });
		const kill = () => child.kill('SIGKILL');
		const timer = setTimeout(kill, task.grader.timeoutMs ?? 600_000);
		signal?.addEventListener('abort', kill);
		const done = (code: number | null) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', kill);
			resolve(code);
		};
		child.on('close', done);
		child.on('error', () => done(null));
	});
}

function median(values: readonly number[]): number | null {
	if (!values.length) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

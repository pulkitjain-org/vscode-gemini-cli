/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The benchmark (gemini/bench/README.md): each task's
// repository is cloned at its base commit, the CLI gets the ticket as its prompt in one session,
// and the task's own test command grades the result. Gemini: Run Benchmark and
// scripts/bench-run.mts both run it through here.
//
// A run measures one variant: the CLI settings it forces, and how many times a task's own check
// (not its grader) may send its failures back, as Verify's "Keep going until checks pass" does.
// The same tasks run under each variant say what a change is worth: pass rate, turns, time and
// the CLI's own token counts.
//
// It is loaded only when a benchmark starts, so the ACP SDK it needs stays out of activation. The
// script loads it through scripts/sourceImports.mts, as its relative imports have no extension.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { promptVersions, type PromptVersions } from './promptVersions';
import { OutputTail } from './runCommands';
import { failurePrompt, type CheckRun } from './verify';

const run = promisify(execFile);

/** One task file in gemini/bench/tasks. */
export interface BenchTask {
	readonly key: string;
	readonly repo: string;
	readonly baseSha: string;
	readonly prompt: string;
	readonly grader: { readonly command: string; readonly timeoutMs?: number };
	/**
	 * The repository's own check (its existing tests, its type check), which a variant with
	 * `checkRounds` runs after each turn and sends the failures of. Never the grader: that is the
	 * answer, and an agent shown it is no longer being measured.
	 */
	readonly check?: { readonly command: string; readonly timeoutMs?: number };
	readonly touchedFiles?: readonly string[];
}

/** What a run changes, to compare with a run of the same tasks without it. */
export interface BenchVariant {
	/** In the results file's name and the comparison: letters, digits, `.`, `-` and `_`. */
	readonly name: string;
	/** CLI settings the run forces, as a system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH), which overrides the user's. */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** Environment variables for the CLI. */
	readonly env?: Readonly<Record<string, string>>;
	/** How many times a task's `check` may send its failures back to the agent; 0 or unset is one turn. */
	readonly checkRounds?: number;
}

/** How one task went. */
export interface BenchResult {
	readonly key: string;
	readonly model: string;
	readonly completed: boolean;
	/** The prompts the agent got: the task, then one for each time its check failed. */
	readonly turns: number;
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
	/** The wording of GeminiCode's prompts the run measured (promptVersions.ts). */
	readonly promptVersions?: PromptVersions;
	readonly model: string;
	/** The variant the run measured, when it had one. */
	readonly variant?: BenchVariant;
	readonly tasks: number;
	readonly completed: number;
	readonly completionRate: number;
	readonly requestsPerCompletedTask: number | null;
	readonly medianTurns: number | null;
	/** Input and output tokens per task, as the CLI reported them; null when it reported none. */
	readonly tokensInPerTask: number | null;
	readonly tokensOutPerTask: number | null;
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
	readonly variant?: BenchVariant;
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

/** The results file's name: `<GeminiCode version>-<CLI version>-<model>[-<variant>].json`, with `dev` for a build that has no version. */
export function benchResultsFileName(summary: Pick<BenchSummary, 'geminiCodeVersion' | 'cliVersion' | 'model' | 'variant'>): string {
	const part = (value: string | undefined) => (value ?? 'dev').replace(/[^\w.-]+/g, '-');
	return `${part(summary.geminiCodeVersion)}-${part(summary.cliVersion)}-${part(summary.model)}${summary.variant ? `-${part(summary.variant.name)}` : ''}.json`;
}

/** The variants in a file: a JSON array, each with a name; anything else in it is an error to say, not to skip. */
export function readBenchVariants(text: string): BenchVariant[] {
	const raw: unknown = JSON.parse(text);
	if (!Array.isArray(raw) || !raw.length) {
		throw new Error('The variants file must hold a JSON array of variants.');
	}
	const names = new Set<string>();
	return raw.map((each: unknown, i) => {
		const o = (each && typeof each === 'object' ? each : {}) as Record<string, unknown>;
		if (typeof o.name !== 'string' || !/^[\w.-]+$/.test(o.name) || names.has(o.name)) {
			throw new Error(`Variant ${i + 1} needs a name of its own, of letters, digits, ".", "-" and "_".`);
		}
		names.add(o.name);
		const rounds = o.checkRounds;
		if (rounds !== undefined && (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 0 || rounds > 10)) {
			throw new Error(`Variant "${o.name}": checkRounds is a whole number from 0 to 10.`);
		}
		for (const key of ['settings', 'env'] as const) {
			if (o[key] !== undefined && (!o[key] || typeof o[key] !== 'object' || Array.isArray(o[key]))) {
				throw new Error(`Variant "${o.name}": ${key} is an object.`);
			}
		}
		return {
			name: o.name,
			...o.settings ? { settings: o.settings as Record<string, unknown> } : {},
			...o.env ? { env: Object.fromEntries(Object.entries(o.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) } : {},
			...rounds ? { checkRounds: rounds } : {},
		};
	});
}

/** Several runs of the same tasks side by side, one line each: what a variant is worth. */
export function benchComparison(summaries: readonly BenchSummary[]): string[] {
	const rows = [
		['variant', 'completed', 'rate', 'median turns', 'median s', 'tokens in / task', 'tokens out / task', 'requests / completed'],
		...summaries.map(s => [
			s.variant?.name ?? '(none)', `${s.completed}/${s.tasks}`, `${Math.round(s.completionRate * 100)}%`, String(s.medianTurns ?? '-'),
			s.medianWallMs === null ? '-' : String(Math.round(s.medianWallMs / 1000)), String(s.tokensInPerTask ?? '-'), String(s.tokensOutPerTask ?? '-'), String(s.requestsPerCompletedTask ?? '-'),
		]),
	];
	const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
	return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
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
			const result = await runTask(task, path.join(work, task.key), options, await variantEnv(options.variant, work));
			results.push(result);
			log(`${task.key}: ${result.completed ? 'completed' : 'not completed'}, ${result.turns} turn${result.turns === 1 ? '' : 's'}, ${result.requests} requests, ${result.tokensIn} in / ${result.tokensOut} out, first text ${result.firstTextMs ?? '-'} ms, ${Math.round(result.wallMs / 1000)} s${result.error ? `, error: ${result.error}` : ''}`);
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
		promptVersions,
		...options.geminiCodeVersion ? { geminiCodeVersion: options.geminiCodeVersion } : {},
		...options.cliVersion ? { cliVersion: options.cliVersion } : {},
		model: options.model,
		...options.variant ? { variant: options.variant } : {},
		tasks: results.length,
		completed: completed.length,
		completionRate: results.length ? Math.round(completed.length / results.length * 100) / 100 : 0,
		requestsPerCompletedTask: completed.length ? Math.round(completed.reduce((n, r) => n + r.requests, 0) / completed.length * 10) / 10 : null,
		medianTurns: median(results.map(r => r.turns).filter(turns => turns > 0)),
		tokensInPerTask: perTask(results.map(r => r.tokensIn)),
		tokensOutPerTask: perTask(results.map(r => r.tokensOut)),
		medianFirstTextMs: median(results.map(r => r.firstTextMs).filter((v): v is number => v !== null)),
		medianWallMs: median(results.map(r => r.wallMs)),
		results,
	};
}

/** The mean of what the CLI reported, or null when it reported nothing for any task. */
function perTask(values: readonly number[]): number | null {
	const total = values.reduce((sum, value) => sum + value, 0);
	return total ? Math.round(total / values.length) : null;
}

/** What a variant adds to the CLI's environment: its own variables, and its settings as the system settings file. */
async function variantEnv(variant: BenchVariant | undefined, work: string): Promise<NodeJS.ProcessEnv> {
	if (!variant?.settings) {
		return { ...variant?.env };
	}
	const file = path.join(work, 'variant-settings.json');
	await fs.writeFile(file, JSON.stringify(variant.settings));
	return { ...variant.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: file };
}

/** Runs a task's check through the shell in the clone, keeping the end of what it prints. Never rejects. */
function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<CheckRun> {
	return new Promise(resolve => {
		const started = Date.now();
		const tail = new OutputTail();
		const child: ChildProcess = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const kill = () => child.kill('SIGKILL');
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener('abort', kill);
		const done = (code: number | null) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', kill);
			resolve({ command, exitCode: code ?? -1, ms: Date.now() - started, ...tail.finish() });
		};
		child.stdout?.on('data', data => tail.push(String(data)));
		child.stderr?.on('data', data => tail.push(String(data)));
		child.on('close', done);
		child.on('error', () => done(null));
	});
}

/** The agent process: one per task, so a task starts cold, as a developer's first prompt of the day does. */
function startAgent(command: BenchAgentCommand, cwd: string, env: NodeJS.ProcessEnv) {
	const child = spawn(command.command, [...command.args], { cwd, env: { ...command.env, ...env }, shell: command.shell, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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

async function runTask(task: BenchTask, repo: string, options: BenchOptions, env: NodeJS.ProcessEnv): Promise<BenchResult> {
	const started = Date.now();
	const turnTimeoutMs = options.turnTimeoutMs ?? 1_200_000;
	let stopReason = 'not started';
	let requests = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let error: string | undefined;
	let promptMs = 0;
	let turns = 0;
	let agent: ReturnType<typeof startAgent> | undefined;
	const stop = () => agent?.child.kill();
	options.signal?.addEventListener('abort', stop);
	try {
		await run('git', ['clone', '--quiet', '--no-checkout', task.repo, repo]);
		await run('git', ['-C', repo, 'checkout', '--quiet', task.baseSha]);
		if (options.signal?.aborted) {
			throw new Error('cancelled');
		}
		agent = startAgent(options.agent, repo, env);
		const exited = new Promise<never>((_, reject) => {
			agent!.child.once('exit', code => reject(new Error(options.signal?.aborted ? 'cancelled' : `the CLI exited with code ${code}`)));
			// A CLI that is not there to start: the task fails with why, where an `error` nobody listens for would end the process.
			agent!.child.once('error', err => reject(new Error(`the CLI could not start: ${err.message}`)));
		});
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
		let reported = 0;
		// One turn: the tokens the CLI reports for it add to the task's.
		const prompt = async (text: string) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const response = await Promise.race([
				ask<{ stopReason: string; _meta?: unknown }>('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }),
				new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error(`no end of turn after ${turnTimeoutMs} ms`)), turnTimeoutMs)),
			]).finally(() => clearTimeout(timer));
			turns++;
			promptMs = Date.now() - promptStart;
			stopReason = response.stopReason;
			const quota = (response._meta as { quota?: { token_count?: { input_tokens?: number; output_tokens?: number }; model_usage?: unknown[] } } | undefined)?.quota;
			tokensIn += quota?.token_count?.input_tokens ?? 0;
			tokensOut += quota?.token_count?.output_tokens ?? 0;
			reported += quota?.model_usage?.length ?? 0;
			requests = Math.max(agent!.requests(), reported);
		};
		await prompt(task.prompt);
		// Verify's loop: while the repository's own check fails, its failure goes back to the agent, a bounded number of times.
		for (let round = 0; task.check && round < (options.variant?.checkRounds ?? 0) && !options.signal?.aborted; round++) {
			const check = await runShell(task.check.command, repo, task.check.timeoutMs ?? 600_000, options.signal);
			promptMs = Date.now() - promptStart;
			const failure = check.exitCode === 0 ? undefined : failurePrompt({ status: 'failed', tree: '', at: 0, runs: [check], protectedChanged: [] }, repo);
			if (!failure) {
				break;
			}
			options.log?.(`${task.key}: the check failed (exit code ${check.exitCode}); round ${round + 1}`);
			await prompt(failure);
		}
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
		key: task.key, model: options.model, completed: graderExit === 0, turns, requests, tokensIn, tokensOut,
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

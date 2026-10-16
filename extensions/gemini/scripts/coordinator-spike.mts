/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The go/no-go spike for a project's coordinator, with no UI. It runs the
// ProjectHub and the `geminicode-project` MCP server as the extension will,
// over one shared `gemini --acp` process.
//
//   npm run spike-coordinator -- [--cli <gemini.js>]            (from extensions/gemini)
//   npm run spike-coordinator -- --real [--cli <gemini.js>] [--model <id>]
//
// Without --real it measures concurrency, with no account and no network: the
// real CLI streams from a local stand-in for the Gemini API, and each chunk
// carries the time it was sent. It compares one session streaming alone with
// a coordinator and five threads streaming at once. Budget: under 50 ms extra
// per chunk, else threads are spread over more than one CLI process.
//
// With --real it uses the CLI's saved sign-in and a named Flash model. It
// makes a small git repo in a temp folder, sends the coordinator five
// scripted asks, and lets the threads it starts work in their own worktrees
// (they may edit and run commands there, nowhere else). It measures whether
// the coordinator keeps to its role (threads do the work, it never edits or
// runs commands), how many coordinator turns a task takes before a thread
// starts, how long that is, and the tokens per turn, and prints a go/no-go.
// The temp folder is deleted at the end unless --keep is given.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';

// `src/acp` imports without extensions, as the extension's bundler allows.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (err) {
		if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
			return next(specifier + '.ts', context);
		}
		throw err;
	}
}`)}`);
const { ProjectHub, threadPrompt } = await import('../src/acp/projectHub.ts');
const { ProjectMcpServer, coordinatorTools: projectTools } = await import('../src/acp/projectMcp.ts');
const { readTurnUsage } = await import('../src/acp/turnUsage.ts');
type ProjectCaller = import('../src/acp/projectMcp.ts').ProjectCaller;
type ThreadDriver = import('../src/acp/projectHub.ts').ThreadDriver;

const { values: args } = parseArgs({
	options: {
		cli: { type: 'string' },
		real: { type: 'boolean', default: false },
		model: { type: 'string' },
		threads: { type: 'string', default: '5' },
		rounds: { type: 'string', default: '3' },
		chunks: { type: 'string', default: '40' },
		gap: { type: 'string', default: '25' },
		'thread-timeout': { type: 'string', default: '600' },
		keep: { type: 'boolean', default: false },
	},
});

const extensionDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundledVersion = (JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8')) as { bundledCli: { version: string } }).bundledCli.version;
const bundled = path.join(extensionDir, 'cli', bundledVersion, 'bundle', 'gemini.js');
const cli = args.cli ? path.resolve(args.cli) : existsSync(bundled) ? bundled : undefined;
if (!cli) {
	console.log('No Gemini CLI found. Run `npm run bundle-cli` first, or pass --cli <path to gemini.js>.');
	process.exit(1);
}
const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// The agent process

interface Agent {
	readonly child: ChildProcess;
	readonly connection: ReturnType<ReturnType<typeof acp.client>['connect']>;
	newSession(cwd: string, mcpServers: unknown[], modelPattern?: RegExp | string): Promise<{ sessionId: string; model: string | undefined }>;
	prompt(sessionId: string, text: string): Promise<{ stopReason: string; meta: unknown }>;
}

type UpdateListener = (sessionId: string, update: acp.SessionNotification['update']) => void;
type PermissionAnswer = (sessionId: string, request: acp.RequestPermissionRequest) => string | undefined;

async function startAgent(env: NodeJS.ProcessEnv, cwd: string, onUpdate: UpdateListener, answer: PermissionAnswer): Promise<Agent> {
	const child = spawn(process.execPath, [cli!, '--acp'], { cwd, env, stdio: 'pipe' });
	let stderr = '';
	child.stderr!.on('data', (chunk: Buffer) => stderr = (stderr + chunk.toString()).slice(-4000));
	child.once('exit', code => {
		if (code && !stopping) {
			console.error(`The Gemini CLI exited with ${code}:\n${stderr}`);
		}
	});
	const connection = acp.client({ name: 'coordinator-spike' })
		.onRequest('session/request_permission', async ctx => {
			const optionId = answer(ctx.params.sessionId, ctx.params);
			return optionId ? { outcome: { outcome: 'selected' as const, optionId } } : { outcome: { outcome: 'cancelled' as const } };
		})
		.onNotification('session/update', ctx => onUpdate(ctx.params.sessionId, ctx.params.update))
		.connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
	await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
	const request = (connection.agent.request as (method: string, params: unknown) => Promise<unknown>).bind(connection.agent);
	return {
		child,
		connection,
		async newSession(sessionCwd, mcpServers, modelPattern) {
			const session = await request('session/new', { cwd: sessionCwd, mcpServers }) as { sessionId: string; models?: { availableModels?: { modelId: string }[]; currentModelId?: string } };
			const ids = session.models?.availableModels?.map(m => m.modelId) ?? [];
			const model = typeof modelPattern === 'string' ? modelPattern : modelPattern ? ids.find(id => modelPattern.test(id)) : undefined;
			if (model) {
				await request('session/set_model', { sessionId: session.sessionId, modelId: model });
			}
			return { sessionId: session.sessionId, model: model ?? session.models?.currentModelId };
		},
		async prompt(sessionId, text) {
			const response = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }) as { stopReason: string; _meta?: unknown };
			return { stopReason: response.stopReason, meta: response._meta };
		},
	};
}

let stopping = false;

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'true', ...extra };
	if (extra.GOOGLE_GEMINI_BASE_URL) {
		for (const key of Object.keys(env).filter(k => /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		env.NO_PROXY = '127.0.0.1';
	}
	return env;
}

const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : NaN;
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : NaN;
const ms = (value: number) => Number.isFinite(value) ? `${value.toFixed(0)} ms` : 'n/a';

// ---------------------------------------------------------------------------
// Concurrency, against a local stand-in for the Gemini API

async function concurrency(): Promise<void> {
	const chunks = Number(args.chunks);
	const gapMs = Number(args.gap);
	const threadCount = Number(args.threads);
	const rounds = Number(args.rounds);
	const server = createServer((req, res) => {
		req.resume().on('end', async () => {
			if (req.url?.includes(':countTokens')) {
				return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ totalTokens: 10 }));
			}
			if (!req.url?.includes(':streamGenerateContent')) {
				const payload = { candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }] };
				return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			for (let i = 0; i < chunks; i++) {
				const last = i === chunks - 1;
				const payload = {
					candidates: [{ content: { role: 'model', parts: [{ text: `[t=${performance.now().toFixed(2)}] ` }] }, ...(last ? { finishReason: 'STOP' } : {}) }],
					...(last ? { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: chunks, totalTokenCount: chunks + 1 } } : {}),
				};
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
				if (!last) {
					await new Promise(resolve => setTimeout(resolve, gapMs));
				}
			}
			res.end();
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

	const home = mkdtempSync(path.join(tmpdir(), 'spike-home-'));
	const work = path.join(home, 'work');
	mkdirSync(work);
	mkdirSync(path.join(home, '.gemini'));
	writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, privacy: { usageStatisticsEnabled: false } }));
	const env = cleanEnv({ HOME: home, USERPROFILE: home, GEMINI_API_KEY: 'placeholder', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });

	let lags: number[] = [];
	const agent = await startAgent(env, work, (_sessionId, update) => {
		if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
			const now = performance.now();
			for (const match of update.content.text.matchAll(/\[t=([\d.]+)\]/g)) {
				lags.push(now - Number(match[1]));
			}
		}
	}, () => undefined);
	try {
		const sessions: string[] = [];
		for (let i = 0; i <= threadCount; i++) {
			sessions.push((await agent.newSession(work, [], /flash/i)).sessionId);
		}
		const measure = async (count: number) => {
			lags = [];
			for (let round = 0; round < rounds; round++) {
				await Promise.all(sessions.slice(0, count).map(s => agent.prompt(s, 'Count.')));
			}
			return lags;
		};
		await measure(1); // Warm up the process and the connection.
		const alone = await measure(1);
		const together = await measure(threadCount + 1);
		const extraMedian = median(together) - median(alone);
		const extraP95 = percentile(together, 0.95) - percentile(alone, 0.95);
		console.log('=== coordinator spike: concurrency ===');
		console.log(`One gemini --acp process, ${chunks} chunks ${gapMs} ms apart per turn, ${rounds} rounds.`);
		console.log(`${'Delay from send to arrival'.padEnd(40)} median    p95    chunks`);
		console.log(`${'1 session alone'.padEnd(40)} ${ms(median(alone)).padStart(7)} ${ms(percentile(alone, 0.95)).padStart(7)} ${String(alone.length).padStart(6)}`);
		console.log(`${`1 coordinator + ${threadCount} threads at once`.padEnd(40)} ${ms(median(together)).padStart(7)} ${ms(percentile(together, 0.95)).padStart(7)} ${String(together.length).padStart(6)}`);
		console.log(`Extra per chunk: ${ms(extraMedian)} median, ${ms(extraP95)} at p95 (budget 50 ms).`);
		console.log(extraP95 < 50 ? 'Within budget: one CLI process can hold a project.' : 'Over budget: spread threads over more than one CLI process.');
	} finally {
		stopping = true;
		agent.child.kill();
		server.close();
		rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	}
}

// ---------------------------------------------------------------------------
// The real coordinator, on the user's account

interface Ask {
	readonly name: string;
	readonly text: string;
	/** What a coordinator holding its role does with it. */
	readonly expect: 'threads' | 'message' | 'post' | 'any';
	readonly threads?: number;
}

const asks: readonly Ask[] = [
	{ name: 'feature', text: 'Add a --verbose flag to cli.js that prints each step it takes.', expect: 'threads', threads: 1 },
	{ name: 'status', text: 'What is running right now?', expect: 'post' },
	{ name: 'two pieces', text: 'Two things. range() in util.js leaves out its last number, please fix that. Separately, add a Usage section to README.md.', expect: 'threads', threads: 2 },
	{ name: 'follow-up', text: 'For the verbose flag work: also print how long each step took.', expect: 'message' },
	{ name: 'code question', text: 'Which function in util.js would be slowest on a big input, and why?', expect: 'any' },
];

const repoFiles: Record<string, string> = {
	'package.json': JSON.stringify({ name: 'spike-demo', version: '1.0.0', type: 'module', bin: { demo: 'cli.js' } }, undefined, '\t') + '\n',
	'README.md': '# spike-demo\n\nA tiny command line tool that sums ranges of numbers.\n',
	'util.js': [
		'// Numbers from start up to and including end.',
		'export function range(start, end) {',
		'\tconst out = [];',
		'\tfor (let i = start; i < end; i++) {',
		'\t\tout.push(i);',
		'\t}',
		'\treturn out;',
		'}',
		'',
		'export function sum(values) {',
		'\treturn values.reduce((a, b) => a + b, 0);',
		'}',
		'',
		'export function unique(values) {',
		'\treturn values.filter((v, i) => values.indexOf(v) === i);',
		'}',
		'',
	].join('\n'),
	'cli.js': [
		'#!/usr/bin/env node',
		'import { range, sum, unique } from \'./util.js\';',
		'',
		'const [start, end] = process.argv.slice(2).map(Number);',
		'const values = unique(range(start, end));',
		'console.log(sum(values));',
		'',
	].join('\n'),
};

interface CoordinatorTurn {
	readonly ms: number;
	readonly input: number;
	readonly output: number;
	readonly events: string;
}

async function real(): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), 'coordinator-spike-'));
	const repo = path.join(root, 'repo');
	mkdirSync(repo);
	for (const [name, text] of Object.entries(repoFiles)) {
		writeFileSync(path.join(repo, name), text);
	}
	const git = (...gitArgs: string[]) => exec('git', gitArgs, { cwd: repo });
	await git('init', '-q', '-b', 'main');
	await git('add', '.');
	await git('-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', 'commit', '-q', '-m', 'Start');

	const modelPattern = args.model ?? /^(?!.*(lite|image|live|tts)).*flash/i;
	const coordinatorTools: { title: string; kind: string }[] = [];
	const refused: string[] = [];
	let coordinatorText = '';
	let coordinatorSession = '';
	const threadSessions = new Map<string, SpikeThread>();

	const agent = await startAgent(cleanEnv({}), repo, (sessionId, update) => {
		if (sessionId === coordinatorSession) {
			if (update.sessionUpdate === 'tool_call') {
				coordinatorTools.push({ title: update.title ?? '', kind: update.kind ?? 'other' });
			} else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
				coordinatorText += update.content.text;
			}
			return;
		}
		const thread = [...threadSessions.values()].find(t => t.sessionId === sessionId);
		if (thread && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
			thread.text += update.content.text;
		}
	}, (sessionId, request) => {
		const allow = request.options.find(o => o.kind === 'allow_once') ?? request.options.find(o => o.kind.startsWith('allow'));
		const reject = request.options.find(o => o.kind.startsWith('reject'));
		if (sessionId === coordinatorSession) {
			// The coordinator may only use the project's tools.
			// The CLI titles an MCP call by its tool and arguments, without the server, and only MCP calls offer "all server tools".
			const title = request.toolCall.title ?? '';
			const mcpCall = request.options.some(o => /server/i.test(o.optionId));
			if (mcpCall && projectTools.some(tool => title === tool.name || title.startsWith(`${tool.name}(`))) {
				return allow?.optionId;
			}
			refused.push(request.toolCall.title ?? '(untitled)');
			return reject?.optionId;
		}
		// Threads work freely, in their own worktree inside the temp folder.
		return allow?.optionId;
	});

	const reportedThisTurn = new Set<string>();
	const mcp = new ProjectMcpServer({
		call: (caller: ProjectCaller, name, toolArgs) => {
			if (caller.role === 'thread' && name === 'report') {
				reportedThisTurn.add(caller.thread);
			}
			return hub.call(caller, name, toolArgs);
		},
	}, 'spike');
	await mcp.start();
	const project = 'spike';

	let threadStarts: number[] = [];
	const threadTimeoutMs = Number(args['thread-timeout']) * 1000;

	class SpikeThread {
		sessionId: string | undefined;
		text = '';
		turns = 0;
		reports = 0;
		silentEnds = 0;
		private readonly queue: string[] = [];
		private chain: Promise<void>;
		private running = false;

		constructor(readonly id: string, readonly title: string, brief: string, planFirst: boolean) {
			const dir = path.join(root, 'worktrees', id);
			const ready = (async () => {
				await git('worktree', 'add', '-q', '-b', `thread/${id}`, dir);
				const session = await agent.newSession(dir, [mcp.configFor({ role: 'thread', project, thread: id })], modelPattern);
				this.sessionId = session.sessionId;
			})();
			this.chain = ready.then(() => this.turn(threadPrompt(brief, planFirst)), err => {
				hub.notify({ kind: 'failed', thread: id, text: `Could not start: ${err instanceof Error ? err.message : String(err)}` });
			});
		}

		get done(): Promise<void> {
			return this.chain;
		}

		message(text: string): void {
			this.queue.push(text);
			if (!this.running) {
				this.chain = this.chain.then(() => this.next());
			}
		}

		private async next(): Promise<void> {
			if (this.queue.length && this.turns < 3 && this.sessionId) {
				await this.turn(this.queue.splice(0).join('\n\n'));
			}
		}

		private async turn(text: string): Promise<void> {
			this.running = true;
			this.turns++;
			this.text = '';
			reportedThisTurn.delete(this.id);
			hub.updateThread(this.id, { state: 'working' });
			try {
				await Promise.race([
					agent.prompt(this.sessionId!, text),
					new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), threadTimeoutMs)),
				]);
				if (reportedThisTurn.has(this.id)) {
					this.reports++;
				} else {
					// Ending a turn without a report still tells the coordinator, as the extension will.
					this.silentEnds++;
					hub.notify({ kind: 'report', thread: this.id, report: 'result', text: `Ended its turn without a report. It last said: ${this.text.trim().slice(-300) || '(nothing)'}` });
				}
				hub.updateThread(this.id, { state: 'done' });
			} catch (err) {
				hub.notify({ kind: 'failed', thread: this.id, text: err instanceof Error ? err.message : String(err) });
			} finally {
				this.running = false;
			}
			await this.next();
		}
	}

	let counter = 0;
	let askStarted = 0;
	const driver: ThreadDriver = {
		async start({ title, brief, planFirst }) {
			threadStarts.push(performance.now() - askStarted);
			const id = `t${++counter}`;
			threadSessions.set(id, new SpikeThread(id, title, brief, planFirst));
			return id;
		},
		message: (thread, text) => threadSessions.get(thread)?.message(text),
		read: (thread, last) => threadSessions.get(thread)?.text.split('\n').slice(-last).join('\n'),
	};

	const turns: CoordinatorTurn[] = [];
	const hub = new ProjectHub(project, {
		async prompt(text) {
			const started = performance.now();
			const { meta } = await agent.prompt(coordinatorSession, text);
			const usage = readTurnUsage(meta) ?? [];
			turns.push({
				ms: performance.now() - started,
				input: usage.reduce((n, u) => n + u.input, 0),
				output: usage.reduce((n, u) => n + u.output, 0),
				events: [...text.matchAll(/<event kind="([\w-]+)"/g)].map(m => m[1]).join(','),
			});
		},
	}, driver);
	const posts: string[] = [];
	hub.onDidPost(entry => {
		if (entry.kind === 'coordinator') {
			posts.push(entry.text);
		}
	});

	const opened = await agent.newSession(repo, [mcp.configFor({ role: 'coordinator', project })], modelPattern);
	coordinatorSession = opened.sessionId;
	const model = opened.model;
	console.log(`Coordinator model: ${model ?? 'the CLI default'}. Repo: ${repo}`);

	interface AskResult {
		readonly name: string;
		readonly expect: string;
		readonly met: boolean;
		readonly turns: number;
		readonly turnsBeforeThread: number | undefined;
		readonly msToThread: number | undefined;
		readonly threadsStarted: number;
		readonly tools: readonly string[];
		readonly offRole: readonly string[];
	}
	const results: AskResult[] = [];
	try {
		for (const ask of asks) {
			console.log(`> ${ask.text}`);
			const turnsBefore = turns.length;
			const toolsBefore = coordinatorTools.length;
			const refusedBefore = refused.length;
			const postsBefore = posts.length;
			const messagesBefore = hub.stats.tools.message_thread ?? 0;
			const threadsBefore = counter;
			threadStarts = [];
			let turnsBeforeThread: number | undefined;
			const listener = hub.onDidChangeThread(thread => {
				if (turnsBeforeThread === undefined && thread.byCoordinator && Number(thread.id.slice(1)) > threadsBefore) {
					turnsBeforeThread = turns.length - turnsBefore + 1;
				}
			});
			askStarted = performance.now();
			hub.post(ask.text);
			await hub.idle();
			listener.dispose();
			const tools = coordinatorTools.slice(toolsBefore).map(t => t.title);
			const offRole = [
				...coordinatorTools.slice(toolsBefore).filter(t => ['edit', 'delete', 'move', 'execute'].includes(t.kind)).map(t => `${t.kind}: ${t.title}`),
				...refused.slice(refusedBefore).map(title => `refused: ${title}`),
			];
			const started = counter - threadsBefore;
			const messaged = (hub.stats.tools.message_thread ?? 0) > messagesBefore;
			const met = offRole.length === 0 && (
				ask.expect === 'threads' ? started >= (ask.threads ?? 1) :
					ask.expect === 'message' ? messaged && started === 0 :
						ask.expect === 'post' ? started === 0 && posts.length > postsBefore :
							true);
			results.push({ name: ask.name, expect: ask.expect, met, turns: turns.length - turnsBefore, turnsBeforeThread, msToThread: threadStarts[0], threadsStarted: started, tools, offRole });
			console.log(`  ${met ? 'as expected' : 'NOT as expected'}: ${started} thread(s), ${tools.length} tool call(s)${offRole.length ? `, off role: ${offRole.join('; ')}` : ''}`);
		}
		console.log('Waiting for the threads to finish...');
		// A report can lead the coordinator to start or message threads, so wait until nothing moves.
		for (let seen = ''; seen !== `${threadSessions.size}/${hub.stats.wakes}`;) {
			seen = `${threadSessions.size}/${hub.stats.wakes}`;
			await Promise.all([...threadSessions.values()].map(t => t.done));
			await hub.idle();
		}
	} finally {
		stopping = true;
		agent.child.kill();
		mcp.dispose();
		hub.dispose();
		if (!args.keep) {
			rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		}
	}

	const threads = [...threadSessions.values()];
	const reportTurns = turns.filter(t => !t.events.split(',').includes('user'));
	const threadAsks = results.filter(r => r.expect === 'threads');
	const summary = {
		model,
		asksAsExpected: `${results.filter(r => r.met).length}/${results.length}`,
		offRoleCalls: results.flatMap(r => r.offRole),
		turnsBeforeThread: threadAsks.map(r => r.turnsBeforeThread ?? null),
		msToFirstThread: threadAsks.map(r => r.msToThread === undefined ? null : Math.round(r.msToThread)),
		coordinatorTurns: turns.length,
		turnsOnReports: reportTurns.length,
		medianTurnMs: Math.round(median(turns.map(t => t.ms))),
		medianTokensPerTurn: { input: median(turns.map(t => t.input)), output: median(turns.map(t => t.output)) },
		totalCoordinatorTokens: turns.reduce((n, t) => n + t.input + t.output, 0),
		threads: threads.length,
		threadsThatReported: threads.filter(t => t.reports > 0).length,
		threadsEndedSilently: threads.filter(t => t.silentEnds > 0).length,
		coordinatorPlainTextChars: coordinatorText.length,
		posts: posts.length,
		perAsk: results.map(r => ({ name: r.name, met: r.met, turns: r.turns, threads: r.threadsStarted, tools: r.tools })),
	};
	const roleHeld = summary.offRoleCalls.length === 0;
	const enoughAsks = results.filter(r => r.met).length >= results.length - 1;
	const oneTurn = threadAsks.every(r => r.turnsBeforeThread === 1);
	console.log('\n=== coordinator spike: result (paste from here down) ===');
	console.log(`Model ${model ?? 'default'}`);
	console.log(`Holds its role (no edits or commands of its own): ${roleHeld ? 'yes' : `no: ${summary.offRoleCalls.join('; ')}`}`);
	console.log(`Asks handled as expected: ${summary.asksAsExpected}`);
	console.log(`Threads started within the first coordinator turn: ${oneTurn ? 'yes' : 'no'} (${summary.turnsBeforeThread.join(', ')})`);
	console.log(`Time from ask to thread start: ${summary.msToFirstThread.map(v => v === null ? 'none' : `${v} ms`).join(', ')}`);
	console.log(`Coordinator turns: ${summary.coordinatorTurns} (${summary.turnsOnReports} on thread reports), median ${summary.medianTurnMs} ms, median ${summary.medianTokensPerTurn.input} in / ${summary.medianTokensPerTurn.output} out tokens`);
	console.log(`Threads: ${summary.threads}, ${summary.threadsThatReported} reported, ${summary.threadsEndedSilently} ended without a report`);
	console.log(`Verdict: ${roleHeld && enoughAsks && oneTurn ? 'GO' : 'NO-GO'}`);
	console.log(JSON.stringify(summary));
}

await (args.real ? real() : concurrency());
process.exit(0);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that prompt enhancement can work on this account before the feature
// is built: whether the fast model answers (or is refused or rate-limited),
// how fast, and how good the rewrites are. It sends direct requests with the
// sign-in the Gemini CLI saved, read only.
//
//   node --experimental-transform-types --no-warnings extensions/gemini/scripts/probe-enhance.mts [--cli <gemini>]
//
// Requests are spaced like clicks (--gap seconds apart) and a refused one is
// retried the way the Gemini CLI retries: after the delay the server names,
// or 1 s then 3 s when it is out of capacity. It takes about three minutes
// and writes every answer to a JSON file.
//
// With --via acp the rewrites go through the Gemini CLI itself instead: one
// `gemini --acp` process, a new Plan-mode session per rewrite, as GeminiCode's
// agents do. The CLI then makes the model call, with its own retries. Each
// session is saved by the CLI like any other chat.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { cliEnvProject, detectAuth, DirectClient, DirectRequestError, readCliBundle, type CliBundleInfo, type ModelQuota } from '../src/acp/directRequest.ts';
import { buildAgentEnv } from '../src/acp/env.ts';
import { cleanEnhancedPrompt, enhancePromptPrompt, quickEditModels, type EnhancePromptInput } from '../src/acp/quickPrompts.ts';

const { values: args } = parseArgs({
	options: {
		cli: { type: 'string' },
		project: { type: 'string' },
		models: { type: 'string' },
		via: { type: 'string', default: 'direct' },
		'empty-cwd': { type: 'boolean' },
		gap: { type: 'string', default: '10' },
		'max-wait': { type: 'string', default: '10' },
		out: { type: 'string', default: 'enhance-probe.json' },
		help: { type: 'boolean', short: 'h' },
	},
});

if (args.help) {
	console.log([
		'Checks prompt enhancement against the fast Gemini model with the Gemini CLI\'s saved sign-in.',
		'',
		'Options:',
		'  --cli <path>        The gemini executable or bundle/gemini.js (default: gemini on PATH)',
		'  --project <id>      Google Cloud project (default: GOOGLE_CLOUD_PROJECT, then the CLI\'s .env)',
		'  --models <a,b>      Models to try, in order, instead of the Flash chain (for example gemini-3.1-flash-lite)',
		'  --via <direct|acp>  Send direct requests (default), or go through the Gemini CLI over ACP',
		'  --empty-cwd         With --via acp, open the sessions in an empty folder, so the CLI adds no folder context',
		'  --gap <seconds>     Time between requests, like clicks (default: 10)',
		'  --max-wait <secs>   Longest retry delay worth waiting for before trying the next model (default: 10)',
		'  --out <file>        Where to write the full results (default: enhance-probe.json)',
	].join('\n'));
	process.exit(0);
}

const gapMs = Number(args.gap) * 1000;
const maxWaitMs = Number(args['max-wait']) * 1000;
const requestTimeoutMs = 30_000;
/** The CLI waits out rate limits itself, so a rewrite through it may take longer. */
const acpTimeoutMs = 120_000;
const viaAcp = args.via === 'acp';
/** Tries per model, as the CLI retries a model that is out of capacity. */
const triesPerModel = 3;

const samples: (EnhancePromptInput & { readonly name: string })[] = [
	{ name: 'one-liner', draft: 'fix the login bug when email is empty' },
	{ name: 'vague', draft: 'make it faster', activeFile: 'src/search/index.ts (typescript)' },
	{ name: 'question', draft: 'why does the build take so long' },
	{ name: 'multi-part', draft: 'add a dark mode toggle to settings, save it in local storage, and make sure the charts also switch colours. dont break the print view' },
	{ name: 'mention', draft: 'refactor @src/auth.ts so the token refresh is in its own function and add tests' },
	{ name: 'command', draft: '/review the changes to the payment flow, mostly worried about rounding' },
	{ name: 'attachment', draft: 'this throws sometimes, fix it', attachments: ['parser.ts:40-80'], activeFile: 'src/parser.ts (typescript)' },
	{
		name: 'follow-up', draft: 'now do the same for signup', history: [
			{ role: 'user', text: 'Add server-side validation to the login form: email format and a password of at least 12 characters.' },
			{ role: 'agent', text: 'I added validation in `src/routes/login.ts` using zod, with error messages returned as 400 responses, and tests in `test/login.test.ts`.' },
		],
	},
	{ name: 'plan mode', draft: 'migrate the db layer from knex to drizzle', mode: 'Plan' },
	{ name: 'code', draft: 'this should return [] not null when nothing matches:\n```ts\nfunction find(q) { return items.length ? items.filter(i => i.name === q) : null; }\n```' },
	// allow-any-unicode-next-line
	{ name: 'non-English', draft: 'agrega paginación a la lista de usuarios, 20 por página' },
	{ name: 'long ramble', draft: 'In the agent chat input box. can we add a way for the user to enhance the prompt. User could write the need in plan english and then enhance the prompt to proper format. something that is precise and more accurate.\n\nWe can think of the UI later, but first think from capability and possibility of implementation' },
];

interface Attempt {
	readonly model: string;
	readonly ok: boolean;
	readonly ms: number;
	readonly status?: number;
	readonly reason?: string;
	readonly retryDelayMs?: number;
	readonly quotaId?: string;
	readonly error?: string;
	/** How long the probe waited after this attempt before the next. */
	waitedMs?: number;
}

interface Outcome {
	readonly ok: boolean;
	/** From the first request to the answer, waits included. */
	readonly ms: number;
	readonly waitedMs: number;
	readonly model?: string;
	readonly attempts: readonly Attempt[];
	readonly reply?: string;
	readonly cleaned?: string;
	/** Through the CLI: tools the agent tried to use, and when its reply began. */
	readonly toolCalls?: number;
	readonly firstChunkMs?: number;
}

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), node: process.version, gapMs, maxWaitMs };

const auth = await detectAuth();
results.auth = auth.kind === 'unsupported' ? `unsupported (${auth.reason})` : auth.kind;
console.log(`Sign-in: ${results.auth}`);
if (auth.kind === 'unsupported') {
	console.log('Direct requests cannot use this sign-in, so prompt enhancement would not work with it.');
	await writeResults();
	process.exit(1);
}

const entry = args.cli ?? await findOnPath('gemini');
const bundle: CliBundleInfo = entry ? await readCliBundle(entry).catch(err => {
	console.log(`Could not read the CLI bundle at ${entry}: ${err instanceof Error ? err.message : err}`);
	return {};
}) : {};
results.cli = entry;
results.flash = { latest: bundle.latestFlash, base: bundle.baseFlash, codeAssist: bundle.codeAssistFlash };
console.log(`CLI: ${entry ?? 'not found (pass --cli)'}; Flash models: latest ${bundle.latestFlash ?? '?'}, base ${bundle.baseFlash ?? '?'}, Code Assist ${bundle.codeAssistFlash ?? '?'}`);
if (auth.kind === 'google' && !bundle.oauthClient) {
	console.log('No OAuth client found in the CLI bundle: an expired sign-in cannot be refreshed. Send the agent a message first if requests fail with "expired".');
}

results.cliVersion = bundle.version;
const client = new DirectClient({
	// Sent as GeminiCode sends it: with the CLI's User-Agent, which lifts Code Assist's one-a-minute limit on direct requests.
	cliVersion: async () => bundle.version,
	projectId: async () => args.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? await cliEnvProject(process.cwd()),
	oauthClient: async () => bundle.oauthClient,
});
const chain = args.models ? args.models.split(',').map(m => m.trim()).filter(Boolean) : quickEditModels({
	setting: 'latestFlash',
	chatModel: undefined,
	cliFlash: { latest: bundle.latestFlash, base: bundle.baseFlash, codeAssist: bundle.codeAssistFlash },
	codeAssist: auth.kind === 'google',
	latestRefused: false,
});
results.chain = chain;
console.log(`Model chain: ${chain.join(' → ')}`);

results.via = viaAcp ? 'acp' : 'direct';
results.quotaBefore = await showQuota('Quota before');
// The CLI needs the project GeminiCode would give it (gemini.projectId); it finds one in its own .env file by itself.
const acpProject = args.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID;
if (viaAcp && !acpProject && !await cliEnvProject(process.cwd())) {
	console.log('\nThe Gemini CLI needs a Google Cloud project. Pass the one GeminiCode uses (gemini.projectId, set with "Gemini: Set Google Cloud Project ID") with --project <id>.');
	await writeResults();
	process.exit(1);
}
const sessionCwd = viaAcp && args['empty-cwd'] ? await fs.mkdtemp(path.join(os.tmpdir(), 'enhance-probe-')) : process.cwd();
results.sessionCwd = sessionCwd;
const agent = viaAcp ? await startAgent() : undefined;
const sendOne = agent ? agent.send : send;

// 1. Each model once, no retries, so a refusal and its reason are seen even when a retry would hide it.
if (!agent) {
	console.log('\nModel check (one request each, no retries)');
}
const modelCheck: Attempt[] = [];
for (const model of agent ? [] : chain) {
	const attempt = await call(model, samples[0]);
	modelCheck.push(attempt.attempt);
	console.log(`  ${model}: ${describe(attempt.attempt)}`);
	await sleep(gapMs);
}
results.modelCheck = modelCheck;
if (modelCheck.length && modelCheck.every(a => !a.ok && a.status === undefined && /sign|expired/i.test(a.error ?? ''))) {
	console.log('\nEvery model failed on sign-in, which is not what this checks. Sign in with the CLI (or send the agent a message to refresh the sign-in), then run this again.');
	await writeResults();
	process.exit(1);
}

// 2. The samples, spaced like clicks, retried the way the CLI retries.
console.log(`\nSamples (one every ${gapMs / 1000} s)`);
const sampleResults = [];
for (const sample of samples) {
	const started = Date.now();
	const outcome = await sendOne(sample);
	const checks = outcome.reply === undefined ? undefined : checksFor(sample, outcome.reply, outcome.cleaned!);
	sampleResults.push({ name: sample.name, draft: sample.draft, ...outcome, checks });
	const failed = checks ? Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) : [];
	const refusals = outcome.attempts.filter(a => !a.ok).map(a => `${a.model} ${a.status ?? ''} ${a.reason ?? (a.status ? '' : a.error ?? '')}`.trim());
	console.log(`  ${sample.name.padEnd(12)} ${outcome.ok ? `${outcome.ms} ms via ${outcome.model}` : `FAILED after ${outcome.ms} ms`}${outcome.waitedMs ? `, ${outcome.waitedMs} ms of it waiting` : ''}${outcome.firstChunkMs !== undefined ? `, reply began at ${outcome.firstChunkMs} ms` : ''}${outcome.toolCalls ? `, ${outcome.toolCalls} tool calls` : ''}${refusals.length ? `  refused: ${refusals.join('; ')}` : ''}${failed.length ? `  checks failed: ${failed.join(', ')}` : ''}`);
	const setupError = outcome.attempts.map(a => a.error ?? '').find(e => /GOOGLE_CLOUD_PROJECT|project id|Authentication required|sign in|untrusted|trusted folder/i.test(e));
	if (agent && setupError) {
		console.log(`\nThe Gemini CLI could not start a session, so the other samples would fail the same way. Fix this and run again:\n  ${setupError}`);
		agent.dispose();
		await writeResults();
		process.exit(1);
	}
	await sleep(Math.max(0, gapMs - (Date.now() - started)));
}
results.samples = sampleResults;

// 3. Five at once, far more than anyone clicks; shown for information, not part of the verdict.
console.log('\nBurst (5 at once, for information)');
const burst = await Promise.all(samples.slice(0, 5).map(sample => sendOne(sample)));
results.burst = burst.map(b => ({ ok: b.ok, ms: b.ms, waitedMs: b.waitedMs, model: b.model, attempts: b.attempts }));
console.log(`  ${burst.filter(b => b.ok).length}/5 answered; slowest ${Math.max(...burst.map(b => b.ms))} ms`);

agent?.dispose();
results.quotaAfter = await showQuota('\nQuota after');

// Summary and verdict, on the spaced samples.
const answered = sampleResults.filter(s => s.ok).map(s => s.ms).sort((a, b) => a - b);
const firstTry = sampleResults.filter(s => s.ok && s.attempts.length === 1).length;
const allAttempts = [...modelCheck, ...sampleResults.flatMap(s => s.attempts), ...burst.flatMap(b => b.attempts)];
const refusals: Record<string, Record<string, number>> = {};
for (const a of allAttempts.filter(a => !a.ok)) {
	const byReason = refusals[a.model] ??= {};
	const key = `${a.status ?? 'error'} ${a.reason ?? ''}`.trim();
	byReason[key] = (byReason[key] ?? 0) + 1;
}
const unrecovered = sampleResults.filter(s => !s.ok).length;
const checksFailed = sampleResults.filter(s => s.checks && Object.values(s.checks).some(ok => !ok)).map(s => s.name);
const p50 = percentile(answered, 0.5);
const p95 = percentile(answered, 0.95);
const verdict = {
	noUnrecoveredRefusals: unrecovered === 0,
	p50Within2500ms: p50 !== undefined && p50 <= 2500,
	p95Within5000ms: p95 !== undefined && p95 <= 5000,
	automaticChecksPass: checksFailed.length === 0,
};
results.summary = { p50, p95, firstTry, refusals, unrecovered, checksFailed, verdict };

console.log('\nSummary (spaced samples)');
console.log(`  Answered: ${answered.length}/${sampleResults.length}, ${firstTry} on the first try`);
console.log(`  Latency including waits: p50 ${p50 ?? '-'} ms, p95 ${p95 ?? '-'} ms`);
console.log(`  Refusals by model and reason (all runs): ${Object.keys(refusals).length ? JSON.stringify(refusals) : 'none'}`);
console.log(`  Samples failing an automatic check: ${checksFailed.length ? checksFailed.join(', ') : 'none'}`);
for (const [name, ok] of Object.entries(verdict)) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log('\nAlso read the rewrites in the results file: are they better prompts than the drafts?');
await writeResults();

async function call(model: string, sample: EnhancePromptInput): Promise<{ attempt: Attempt; reply?: string }> {
	const { system, prompt } = enhancePromptPrompt(sample);
	const started = Date.now();
	try {
		const reply = await client.generate({ model, system, prompt, temperature: 0.3, signal: AbortSignal.timeout(requestTimeoutMs) });
		return { attempt: { model, ok: true, ms: Date.now() - started }, reply };
	} catch (err) {
		const failure = err instanceof DirectRequestError ? { status: err.status, ...err.details } : {};
		return { attempt: { model, ok: false, ms: Date.now() - started, ...failure, error: err instanceof Error ? err.message : String(err) } };
	}
}

/**
 * One enhancement as the feature would send it. A model that is busy or
 * rate-limited (429, 503) is tried again after the delay the server names,
 * else 1 s then 3 s, as the CLI does; a delay longer than --max-wait, or a
 * model the account can't use (400, 403, 404), moves on to the next model.
 * Nothing is remembered between enhancements.
 */
async function send(sample: EnhancePromptInput): Promise<Outcome> {
	const started = Date.now();
	const attempts: Attempt[] = [];
	let waitedMs = 0;
	for (const model of chain) {
		for (let tryIndex = 0; tryIndex < triesPerModel; tryIndex++) {
			const { attempt, reply } = await call(model, sample);
			attempts.push(attempt);
			if (reply !== undefined) {
				return { ok: true, ms: Date.now() - started, waitedMs, model, attempts, reply, cleaned: cleanEnhancedPrompt(reply, sample.draft) };
			}
			if (attempt.status !== 429 && attempt.status !== 503) {
				if (attempt.status === 400 || attempt.status === 403 || attempt.status === 404) {
					break;
				}
				return { ok: false, ms: Date.now() - started, waitedMs, attempts };
			}
			const wait = attempt.retryDelayMs ?? (tryIndex === 0 ? 1000 : 3000);
			if (wait > maxWaitMs || tryIndex === triesPerModel - 1) {
				break;
			}
			attempt.waitedMs = wait;
			waitedMs += wait;
			await sleep(wait);
		}
	}
	return { ok: false, ms: Date.now() - started, waitedMs, attempts };
}

/**
 * Starts `gemini --acp` once and returns a sender that rewrites each sample
 * in a new Plan-mode session, as GeminiCode's agents would. Permission
 * requests are refused, so nothing is changed.
 */
async function startAgent(): Promise<{ send(sample: EnhancePromptInput): Promise<Outcome>; dispose(): void }> {
	const command = entry ?? 'gemini';
	const script = /\.[cm]?js$/.test(command);
	const child = spawn(script ? process.execPath : command, [...script ? [command] : [], '--acp'], {
		cwd: process.cwd(),
		env: { ...buildAgentEnv(process.env, acpProject), GEMINI_CLI_NO_RELAUNCH: 'true' },
		stdio: 'pipe',
	});
	let stderr = '';
	child.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-2000));
	const replies = new Map<string, { text: string; toolCalls: number; firstChunkAt?: number }>();
	const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
	const connection = acp.client({ name: 'geminicode' })
		.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' as const } }))
		.onNotification('session/update', ctx => {
			const reply = replies.get(ctx.params.sessionId);
			const update = ctx.params.update;
			if (!reply) {
				return;
			}
			if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
				reply.firstChunkAt ??= Date.now();
				reply.text += update.content.text;
			} else if (update.sessionUpdate === 'tool_call') {
				reply.toolCalls++;
			}
		})
		.connect(stream);
	const startedAt = Date.now();
	try {
		await connection.agent.request('initialize', {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: 'geminicode', title: 'GeminiCode', version: '0.1.0' },
		});
	} catch (err) {
		console.log(`The Gemini CLI did not start over ACP: ${errorText(err)}\n${stderr}`);
		process.exit(1);
	}
	console.log(`\nGemini CLI started over ACP in ${Date.now() - startedAt} ms`);

	// The first session shows which modes and models the CLI offers.
	let model: string | undefined;
	let chosen = false;
	const send = async (sample: EnhancePromptInput): Promise<Outcome> => {
		const started = Date.now();
		let sessionId: string | undefined;
		try {
			const session = await connection.agent.request('session/new', { cwd: sessionCwd, mcpServers: [] });
			sessionId = session.sessionId;
			const models = ((session as { models?: { availableModels?: { modelId: string }[]; currentModelId?: string } }).models);
			const available = models?.availableModels?.map(m => m.modelId) ?? [];
			if (!chosen) {
				chosen = true;
				model = chain.find(m => available.includes(m)) ?? (args.models ? chain[0] : undefined);
				results.acp = { modes: session.modes?.availableModes.map(m => m.id), models: available, currentModel: models?.currentModelId, chosenModel: model };
				console.log(`Modes: ${session.modes?.availableModes.map(m => m.id).join(', ') ?? 'none'}`);
				console.log(`Models: ${available.join(', ') || 'none listed'}; using ${model ?? `the session's own (${models?.currentModelId ?? '?'})`}`);
			}
			if (session.modes?.availableModes.some(m => m.id === 'plan')) {
				await connection.agent.request('session/set_mode', { sessionId, modeId: 'plan' });
			}
			if (model && model !== models?.currentModelId) {
				// gemini-cli's unstable session/set_model, as AgentConnection.setModel sends it.
				await (connection.agent.request as (method: string, params: unknown) => Promise<unknown>)('session/set_model', { sessionId, modelId: model });
			}
			const { system, prompt } = enhancePromptPrompt(sample);
			const text = `${system}\n\n${prompt}`;
			const reply = { text: '', toolCalls: 0, firstChunkAt: undefined as number | undefined };
			replies.set(sessionId, reply);
			const requestStarted = Date.now();
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error(`no answer in ${acpTimeoutMs / 1000} s`)), acpTimeoutMs));
			try {
				await Promise.race([connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }), timeout]);
			} catch (err) {
				void connection.agent.notify('session/cancel', { sessionId }).catch(() => undefined);
				throw err;
			} finally {
				clearTimeout(timer);
			}
			const ms = Date.now() - started;
			const label = model ?? models?.currentModelId ?? 'session default';
			const attempt: Attempt = { model: label, ok: !!reply.text.trim(), ms: Date.now() - requestStarted, ...(reply.text.trim() ? {} : { error: 'empty reply' }) };
			return reply.text.trim()
				? { ok: true, ms, waitedMs: 0, model: label, attempts: [attempt], reply: reply.text, cleaned: cleanEnhancedPrompt(reply.text, sample.draft), toolCalls: reply.toolCalls, firstChunkMs: reply.firstChunkAt && reply.firstChunkAt - started }
				: { ok: false, ms, waitedMs: 0, attempts: [attempt], toolCalls: reply.toolCalls };
		} catch (err) {
			const ms = Date.now() - started;
			return { ok: false, ms, waitedMs: 0, attempts: [{ model: model ?? 'session default', ok: false, ms, error: errorText(err) }], toolCalls: sessionId ? replies.get(sessionId)?.toolCalls : undefined };
		} finally {
			if (sessionId) {
				replies.delete(sessionId);
			}
		}
	};
	return { send, dispose: () => child.kill() };
}

/** A JSON-RPC error's message and the CLI's details, or any other error's message. */
function errorText(err: unknown): string {
	const { message, data } = (err ?? {}) as { message?: string; data?: { details?: string } };
	return [message ?? String(err), data?.details].filter(Boolean).join(': ').slice(0, 300);
}

/** Automatic checks on one rewrite; reading the rewrites is still needed. */
function checksFor(sample: EnhancePromptInput, reply: string, cleaned: string) {
	const mentions = [...sample.draft.matchAll(/(?:^|\s)(@[^\s@]+)/g)].map(m => m[1]);
	const command = /^\s*(\/[\w:.-]+)/.exec(sample.draft)?.[1];
	const raw = reply.trim();
	return {
		answered: raw.length > 0,
		mentionsKeptByModel: mentions.every(m => raw.includes(m)),
		commandFirstByModel: !command || raw.startsWith(command),
		noInventedCommand: !!command || !/^\/[\w:.-]+\s/.test(raw),
		noPreamble: !/^(?:\*\*)?(?:here(?:'s| is)|sure|okay|certainly|enhanced prompt|improved prompt)\b/i.test(raw),
		noWrappingFence: !/^(`{3,}|~{3,})[^\n]*\n[\s\S]*\1$/.test(raw),
		// The model doing the task rather than rewriting it usually shows as code or a first-person reply.
		rewroteNotAnswered: !/^(?:i(?:'ll| will| would)|to (?:fix|do) this|the (?:bug|issue|problem) is)\b/i.test(raw)
			&& (sample.draft.includes('```') || !raw.includes('```')),
		changed: cleaned.trim() !== sample.draft.trim(),
	};
}

/** Prints today's use of the models in the chain; Code Assist only. */
async function showQuota(title: string): Promise<readonly ModelQuota[] | string | undefined> {
	const quota = await client.quota().catch((err: unknown) => err instanceof Error ? err.message : String(err));
	if (quota === undefined) {
		return undefined;
	}
	if (typeof quota === 'string') {
		console.log(`${title}: could not read (${quota})`);
		return quota;
	}
	const shown = quota.filter(q => chain.includes(q.model) || /flash/.test(q.model));
	console.log(`${title}: ${shown.length ? shown.map(q => `${q.model} ${Math.round(q.used * 100)}% used`).join(', ') : 'no Flash models listed'}`);
	return quota;
}

function describe(attempt: Attempt): string {
	if (attempt.ok) {
		return `answered in ${attempt.ms} ms`;
	}
	const facts = [attempt.status, attempt.reason, attempt.quotaId, attempt.retryDelayMs !== undefined ? `retry in ${attempt.retryDelayMs} ms` : undefined].filter(Boolean).join(', ');
	return `refused after ${attempt.ms} ms${facts ? ` (${facts})` : ''}: ${attempt.error}`;
}

function percentile(sorted: number[], p: number): number | undefined {
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : undefined;
}

async function findOnPath(name: string): Promise<string | undefined> {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(dir, name);
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Not here.
		}
	}
	return undefined;
}

async function writeResults(): Promise<void> {
	await fs.writeFile(args.out!, JSON.stringify(results, null, '\t') + '\n');
	console.log(`Full results: ${path.resolve(args.out!)}`);
}

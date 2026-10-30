/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Research (/research): a broad question about the repository, split into
// parts that read-only workers answer at the same time, then merged into one
// report with file:line evidence. A planner (one quick request) splits the
// question from the index's outline of the folder. Each worker is a session of
// its own in Plan mode, with the index tools, whose permission requests are all
// refused, so nothing can change. One verifier rereads the most serious
// findings. Workers read a few files at a time and report in a fixed shape, as
// the merge request review does, so no context fills up.

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentRuntime } from './agentRuntime';
import { readSessionSettings, type SessionSelector } from './sessionSettings';

/** One part of the question, for one worker. */
export interface ResearchSlice {
	readonly title: string;
	readonly focus: string;
	/** Where to look, in .gitignore syntax; empty means anywhere. */
	readonly paths: readonly string[];
}

export interface ResearchFinding {
	readonly claim: string;
	readonly file?: string;
	readonly line?: number;
	readonly quote?: string;
	readonly severity: 'high' | 'medium' | 'low' | 'info';
	/** Set by the verifier for a serious finding it reread. */
	readonly verified?: 'confirmed' | 'refuted' | 'unsure';
}

export interface WorkerResult {
	readonly slice: ResearchSlice;
	readonly summary: string;
	readonly findings: readonly ResearchFinding[];
	/** The worker failed or was stopped, with why. */
	readonly failed?: string;
}

/** How the run stands, for the chat's card. */
export interface ResearchProgress {
	readonly state: 'planning' | 'reading' | 'verifying' | 'merging' | 'done' | 'stopped' | 'failed';
	readonly slices: readonly { readonly title: string; readonly state: 'queued' | 'reading' | 'done' | 'failed'; readonly files: number; readonly findings: number }[];
}

export const maxSlices = 8;
export const defaultConcurrency = 4;
/** The most serious findings the verifier rereads. */
const maxVerified = 6;
const maxQuestion = 2_000;
const maxOutline = 6_000;

/** The JSON value in a model's reply: in a ```json block when there is one, else the first array or object. */
function jsonIn(text: string): unknown {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
	const blocks = [...text.matchAll(fenced)].map(match => match[1]);
	for (const candidate of [...blocks.reverse(), text.slice(Math.min(...['[', '{'].map(c => text.indexOf(c)).filter(i => i >= 0), text.length))]) {
		try {
			return JSON.parse(candidate.trim());
		} catch {
			// Not this one.
		}
	}
	return undefined;
}

const str = (value: unknown, max = 500) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

export const plannerSystem = [
	'You split a question about a code repository into independent parts, so several read-only researchers can answer it at the same time, each reading one part of the code.',
	`Answer with only a JSON array of at most ${maxSlices} parts, each {"title": short name, "focus": what to find there, "paths": [.gitignore patterns of where to look]}.`,
	'Split by area of the code (folders, layers, services) so the parts don\'t overlap, using the outline. A small or narrow question is one part. Never more parts than the code has areas worth reading.',
].join('\n');

export function plannerPrompt(question: string, outline: string | undefined, slices: number): string {
	return [
		outline ? `<outline>\n${outline.slice(0, maxOutline)}\n</outline>` : 'No outline of the repository is available.',
		'',
		`At most ${slices} parts.`,
		`Question: ${question.slice(0, maxQuestion)}`,
	].join('\n');
}

/** The parts the planner gave, at most `limit`; the whole question as one part when its answer can't be read. */
export function parseSlices(text: string, question: string, limit = maxSlices): ResearchSlice[] {
	const value = jsonIn(text);
	const list = Array.isArray(value) ? value : [];
	const slices = list.flatMap(item => {
		const o = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		const title = str(o.title, 80);
		const paths = Array.isArray(o.paths) ? o.paths.flatMap(p => str(p, 200) ? [str(p, 200)!] : []).slice(0, 10) : [];
		return title ? [{ title, focus: str(o.focus) ?? question, paths }] : [];
	}).slice(0, Math.max(1, limit));
	return slices.length ? slices : [{ title: 'Whole repository', focus: question, paths: [] }];
}

export function workerPrompt(question: string, slice: ResearchSlice, others: number): string {
	return [
		`You are one of ${others + 1} read-only researchers answering a question about this repository; each covers one part, so stay in yours.`,
		`Question: ${question.slice(0, maxQuestion)}`,
		`Your part: ${slice.title}. ${slice.focus}`,
		slice.paths.length ? `Look in: ${slice.paths.join(', ')}` : 'Look anywhere in the repository.',
		'',
		'- Find code with the index tools first (code_search, find_symbol, related_files, repo_map), then read only the lines they point to, a few files at a time.',
		'- You can\'t change anything: don\'t edit files, and run no command that writes. Never print a whole diff or log in one command.',
		'- Report only what the code shows, each finding with the file and line it is on and the line itself as the quote.',
		'',
		'End your reply with one JSON block:',
		'```json',
		'{"summary": "two or three sentences on your part", "findings": [{"claim": "what is true", "file": "src/a.ts", "line": 12, "quote": "the line", "severity": "high"}]}',
		'```',
		'severity is high (a bug, a security or data problem), medium, low or info (a fact the answer needs). "findings": [] when your part has nothing.',
	].join('\n');
}

/** A worker's summary and findings from its reply. */
export function parseWorkerReply(text: string, slice: ResearchSlice): WorkerResult {
	const value = jsonIn(text);
	const o = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const severities = new Set(['high', 'medium', 'low', 'info']);
	const findings = (Array.isArray(o.findings) ? o.findings : []).flatMap(item => {
		const f = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		const claim = str(f.claim, 600);
		if (!claim) {
			return [];
		}
		const line = typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? f.line : undefined;
		const severity = typeof f.severity === 'string' && severities.has(f.severity) ? f.severity as ResearchFinding['severity'] : 'info';
		return [{ claim, ...str(f.file, 300) ? { file: str(f.file, 300) } : {}, ...line ? { line } : {}, ...str(f.quote, 300) ? { quote: str(f.quote, 300) } : {}, severity }];
	});
	// A reply with no JSON still says something: its text stands as the summary.
	return { slice, summary: str(o.summary, 1_500) ?? text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 1_500), findings };
}

export function verifierPrompt(question: string, findings: readonly ResearchFinding[]): string {
	return [
		`Researchers answering "${question.slice(0, 300)}" reported these findings. Check each against the code: read the file at the line, and a little around it.`,
		...findings.map((f, i) => `${i + 1}. ${f.claim}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`),
		'',
		'You can\'t change anything. End your reply with one JSON block: [{"index": 1, "verdict": "confirmed" | "refuted" | "unsure"}], one entry per finding.',
	].join('\n');
}

/** The findings with the verifier's verdicts. */
export function applyVerdicts(findings: readonly ResearchFinding[], text: string): ResearchFinding[] {
	const value = jsonIn(text);
	const verdicts = new Map<number, ResearchFinding['verified']>();
	for (const item of Array.isArray(value) ? value : []) {
		const o = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		if (typeof o.index === 'number' && (o.verdict === 'confirmed' || o.verdict === 'refuted' || o.verdict === 'unsure')) {
			verdicts.set(o.index, o.verdict);
		}
	}
	return findings.map((f, i) => verdicts.has(i + 1) ? { ...f, verified: verdicts.get(i + 1) } : f);
}

/** The findings worth a second look: the high ones, then medium, at most a few. */
export function toVerify(results: readonly WorkerResult[]): ResearchFinding[] {
	const all = results.flatMap(r => r.findings).filter(f => f.file && (f.severity === 'high' || f.severity === 'medium'));
	return [...all.filter(f => f.severity === 'high'), ...all.filter(f => f.severity === 'medium')].slice(0, maxVerified);
}

export const mergeSystem = [
	'You write the answer to a question about a code repository from what several read-only researchers found, each in one part of the code.',
	'Lead with the answer in one or two sentences. Then the findings that matter, most serious first, each on one line with its place as `path:line`; mark those a verifier confirmed with "(verified)" and leave out those it refuted. Then, briefly, any part a researcher could not finish.',
	'Merge findings that are the same thing. Add nothing the researchers did not find. Markdown, no preamble.',
].join('\n');

export function mergePrompt(question: string, results: readonly WorkerResult[], verified: readonly ResearchFinding[]): string {
	const verdict = (f: ResearchFinding) => verified.find(v => v.claim === f.claim && v.file === f.file && v.line === f.line)?.verified;
	return [
		`Question: ${question.slice(0, maxQuestion)}`,
		'',
		...results.flatMap(r => [
			`<part title="${r.slice.title.replace(/"/g, '\'')}"${r.failed ? ` failed="${r.failed.replace(/"/g, '\'').slice(0, 200)}"` : ''}>`,
			r.summary,
			...r.findings.map(f => `- [${f.severity}${verdict(f) ? `, ${verdict(f)}` : ''}] ${f.claim}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}${f.quote ? ` — ${f.quote}` : ''}`),
			'</part>',
		]),
	].join('\n');
}

/** A report written without the model, when the merge fails: each part's summary and findings as they came. */
export function plainReport(results: readonly WorkerResult[], verified: readonly ResearchFinding[]): string {
	const refuted = (f: ResearchFinding) => verified.some(v => v.claim === f.claim && v.file === f.file && v.verified === 'refuted');
	return results.map(r => [
		`**${r.slice.title}**${r.failed ? ` (not finished: ${r.failed})` : ''}`,
		r.summary,
		...r.findings.filter(f => !refuted(f)).map(f => `- ${f.claim}${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}`),
	].filter(Boolean).join('\n')).join('\n\n');
}

/** A worker's model: Flash, which reads and reports well and fast, else whatever the session has. */
export function workerModel(model: SessionSelector | undefined): string | undefined {
	const ids = model?.available.map(choice => choice.id) ?? [];
	return ids.find(id => /flash/i.test(id) && !/lite/i.test(id)) ?? ids.find(id => /flash/i.test(id));
}

export interface ResearchRunOptions {
	readonly runtime: AgentRuntime;
	/** The folder researched: workers' sessions run there. */
	readonly cwd: string;
	/** The MCP servers a worker gets (the index's, for `cwd`), and their release when it is done. */
	mcpServers(worker: string): acp.McpServer[];
	release(worker: string): void;
	/** One quick request, for the plan and the merge (the side questions' route). */
	ask(system: string, prompt: string, signal: AbortSignal): Promise<string>;
	readonly outline?: string;
	readonly concurrency?: number;
	/** How long one worker may take. */
	readonly workerTimeoutMs?: number;
	onProgress(progress: ResearchProgress): void;
}

/** One research run; `stop` ends every worker and merges what is done. */
export class ResearchRun {

	private readonly stopper = new AbortController();
	private slices: { title: string; state: 'queued' | 'reading' | 'done' | 'failed'; files: number; findings: number }[] = [];
	private state: ResearchProgress['state'] = 'planning';
	private nextWorker = 0;

	constructor(private readonly question: string, private readonly options: ResearchRunOptions) { }

	stop(): void {
		this.stopper.abort();
	}

	get stopped(): boolean {
		return this.stopper.signal.aborted;
	}

	/** Plans, reads, verifies and merges; resolves with the report in Markdown. */
	async run(): Promise<string> {
		const concurrency = Math.min(maxSlices, Math.max(1, this.options.concurrency ?? defaultConcurrency));
		this.progress('planning');
		const planned = await this.options.ask(plannerSystem, plannerPrompt(this.question, this.options.outline, maxSlices), this.stopper.signal).catch(() => '');
		const slices = parseSlices(planned, this.question);
		this.slices = slices.map(slice => ({ title: slice.title, state: 'queued', files: 0, findings: 0 }));
		this.progress('reading');
		const results: WorkerResult[] = new Array(slices.length);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(concurrency, slices.length) }, async () => {
			while (next < slices.length) {
				const index = next++;
				results[index] = await this.work(index, slices[index], slices.length - 1);
			}
		}));
		const finished = results.filter(result => !result.failed || result.findings.length);
		let verified: ResearchFinding[] = [];
		const check = this.stopped ? [] : toVerify(results);
		if (check.length) {
			this.progress('verifying');
			const reply = await this.session(`verify`, verifierPrompt(this.question, check), () => undefined).catch(() => undefined);
			verified = reply ? applyVerdicts(check, reply) : [];
		}
		this.progress('merging');
		const merged = finished.length
			? await this.options.ask(mergeSystem, mergePrompt(this.question, results, verified), new AbortController().signal).catch(() => plainReport(results, verified))
			: '';
		this.progress(this.stopped ? 'stopped' : finished.length ? 'done' : 'failed');
		return merged.trim() || plainReport(results, verified);
	}

	private async work(index: number, slice: ResearchSlice, others: number): Promise<WorkerResult> {
		if (this.stopped) {
			this.slices[index].state = 'failed';
			return { slice, summary: '', findings: [], failed: 'stopped' };
		}
		this.slices[index].state = 'reading';
		this.progress('reading');
		try {
			const reply = await this.session(`worker-${index}`, workerPrompt(this.question, slice, others), files => {
				this.slices[index].files = files;
				this.progress('reading');
			});
			const result = parseWorkerReply(reply, slice);
			this.slices[index] = { ...this.slices[index], state: 'done', findings: result.findings.length };
			this.progress('reading');
			return result;
		} catch (err) {
			this.slices[index].state = 'failed';
			this.progress('reading');
			return { slice, summary: '', findings: [], failed: this.stopped ? 'stopped' : err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * One read-only session's reply: Plan mode on a Flash model, the index
	 * tools, every permission request refused; cancelled on stop or timeout.
	 */
	private async session(name: string, prompt: string, onFiles: (files: number) => void): Promise<string> {
		const worker = `research-${Date.now().toString(36)}-${this.nextWorker++}-${name}`;
		const { runtime, cwd } = this.options;
		const { connection, agent, session } = await runtime.newSession(cwd, this.options.mcpServers(worker));
		let text = '';
		const read = new Set<string>();
		const registration = runtime.register(session.sessionId, {
			sessionUpdate: (update: acp.SessionUpdate) => {
				if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
					text += update.content.text;
				} else if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.locations?.length) {
					for (const location of update.locations) {
						read.add(location.path);
					}
					onFiles(read.size);
				}
			},
			// Read-only: nothing that asks is allowed, whatever the mode lets through.
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		const cancel = () => void connection.cancel(session.sessionId).catch(() => undefined);
		const timer = setTimeout(cancel, this.options.workerTimeoutMs ?? 6 * 60_000);
		this.stopper.signal.addEventListener('abort', cancel);
		try {
			const settings = readSessionSettings(session);
			const model = workerModel(settings.model);
			await Promise.all([
				settings.mode && settings.mode.currentId !== 'plan' && settings.mode.available.some(choice => choice.id === 'plan') ? connection.setMode(session.sessionId, 'plan') : undefined,
				model && model !== settings.model?.currentId ? connection.setModel(session.sessionId, model) : undefined,
			]);
			const response = await connection.prompt(session.sessionId, [{ type: 'text', text: prompt }]);
			if (response.stopReason === 'cancelled' && !text.trim()) {
				throw new Error(this.stopped ? 'stopped' : 'took too long');
			}
			return text;
		} finally {
			clearTimeout(timer);
			this.stopper.signal.removeEventListener('abort', cancel);
			registration.dispose();
			if (agent.agentCapabilities?.sessionCapabilities?.close) {
				void connection.close(session.sessionId).catch(() => undefined);
			}
			this.options.release(worker);
		}
	}

	private progress(state: ResearchProgress['state']): void {
		this.state = state;
		this.options.onProgress({ state: this.state, slices: this.slices.map(slice => ({ ...slice })) });
	}
}

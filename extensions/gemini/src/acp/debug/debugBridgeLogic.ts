/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every decision of the debugger bridge (DEBUG_MODE.md, The debugger bridge),
// with the VS Code calls passed in, so a scripted adapter (test/fake-dap)
// covers it: which Debug Adapter Protocol messages the tracker looks at and
// how cheaply it skips the rest, joining output pieces into lines, the
// capped tail of plain output, a stop at one of the agent's points (a
// snapshot, then continue, or a hold of at most 30 seconds), the resolved
// copy of a launch configuration, attach by a loopback port, and a point's
// breakpoint fields. src/host/debug/debugBridge.ts makes the calls.

import { isRecord } from '../fsUtil';
import { environmentGuard, joinCondition, languageOf } from './expressions';
import { logpointMessage, markerPrefix, type Point } from './points';

/** One request to a debug session (`DebugSession.customRequest`). */
export type DapRequest = (command: string, args?: Record<string, unknown>) => PromiseLike<unknown>;

export const bridgeLimits = {
	/** Plain output kept per debug session, for exceptions and context. */
	tailBytes: 256 * 1024,
	/** A line still arriving in pieces is cut here. */
	lineInProgress: 16 * 1024,
	/** A held stop continues by itself after this. */
	holdMs: 30_000,
	/** A breakpoint hit more often than this in a run only counts. */
	snapshotsPerRun: 50,
} as const;

export const snapshotLimits = {
	frames: 3,
	entries: 30,
	depth: 2,
	children: 20,
	valueChars: 200,
	requestMs: 1500,
	totalMs: 3000,
} as const;

/** The marker a launched or attached session carries, so the tracker knows it and its children. */
export const sessionMarker = '__geminiDebug';

/** The environment variable a launched program gets, so the agent's points act only there. */
export const guardVariable = 'GEMINI_DEBUG';

/** Plain output of one debug session, capped by size; the oldest goes first. */
export class OutputTail {

	private readonly chunks: string[] = [];
	private size = 0;

	constructor(private readonly cap: number = bridgeLimits.tailBytes) { }

	append(text: string): void {
		if (!text) {
			return;
		}
		const piece = text.length > this.cap ? text.slice(text.length - this.cap) : text;
		this.chunks.push(piece);
		this.size += piece.length;
		while (this.size > this.cap && this.chunks.length) {
			const first = this.chunks[0];
			const over = this.size - this.cap;
			if (first.length <= over) {
				this.chunks.shift();
				this.size -= first.length;
			} else {
				this.chunks[0] = first.slice(over);
				this.size -= over;
			}
		}
	}

	get length(): number {
		return this.size;
	}

	/** The last `chars` characters, or all of it. */
	text(chars?: number): string {
		const all = this.chunks.join('');
		return chars !== undefined && all.length > chars ? all.slice(all.length - chars) : all;
	}
}

/**
 * Output arrives in pieces, per category; a marker line can be split across
 * two. Pieces are joined into lines per category, with a cap on a line in
 * progress, and only complete lines are handed on.
 */
export class OutputLines {

	private readonly partial = new Map<string, string>();

	/** The complete lines `text` finishes, in order. */
	push(category: string, text: string): string[] {
		const before = this.partial.get(category);
		const joined = before ? before + text : text;
		const parts = joined.split('\n');
		let rest = parts.pop() ?? '';
		if (rest.length > bridgeLimits.lineInProgress) {
			rest = rest.slice(0, bridgeLimits.lineInProgress);
		}
		if (rest) {
			this.partial.set(category, rest);
		} else if (before !== undefined) {
			this.partial.delete(category);
		}
		return parts.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
	}

	/** Whatever was still in progress, as when the session ends. */
	flush(): string[] {
		const rest = [...this.partial.values()];
		this.partial.clear();
		return rest;
	}

	/** Whether a category has a line in progress. */
	pending(category: string): boolean {
		return this.partial.has(category);
	}
}

export interface TrackerSink {
	/** A complete output line with `@@gc:` in it, for the points to route. */
	marked(line: string, category: string): void;
	/** A `stopped` event. */
	stopped(stop: StoppedEvent): void;
	/** The program exited with `exitCode`. */
	exited(exitCode: number | undefined): void;
	/** The debug session ended (the adapter's `terminated`). */
	terminated(): void;
}

export interface StoppedEvent {
	readonly reason: string;
	readonly threadId?: number;
	readonly hitBreakpointIds: readonly number[];
	readonly description?: string;
	readonly text?: string;
}

/**
 * What the tracker does with each message of one tracked debug session:
 * almost nothing. A message that is not an event is skipped by its first
 * property read; plain output goes to the capped tail without parsing; only
 * a line with `@@gc:` is handed on.
 */
export class SessionTracker {

	readonly tail = new OutputTail();
	private readonly lines = new OutputLines();
	private ended = false;

	constructor(private readonly sink: TrackerSink) { }

	onMessage(message: unknown): void {
		if ((message as { readonly type?: unknown } | undefined)?.type !== 'event') {
			return;
		}
		const { event, body } = message as { readonly event?: unknown; readonly body?: unknown };
		switch (event) {
			case 'output':
				this.output(body);
				return;
			case 'stopped':
				this.stopped(body);
				return;
			case 'exited':
				this.sink.exited(isRecord(body) && typeof body.exitCode === 'number' ? body.exitCode : undefined);
				return;
			case 'terminated':
				this.end();
				return;
		}
	}

	/** The session ended without `terminated`, such as when the adapter crashed. */
	end(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		for (const line of this.lines.flush()) {
			if (line.includes(markerPrefix)) {
				this.sink.marked(line, 'console');
			}
		}
		this.sink.terminated();
	}

	private output(body: unknown): void {
		if (!isRecord(body) || typeof body.output !== 'string') {
			return;
		}
		const category = typeof body.category === 'string' ? body.category : 'console';
		if (category === 'telemetry') {
			return;
		}
		const text = body.output;
		// The common case: a whole line or more of plain output, with nothing in progress.
		if (!text.includes(markerPrefix) && text.endsWith('\n') && !this.lines.pending(category)) {
			this.tail.append(text);
			return;
		}
		for (const line of this.lines.push(category, text)) {
			if (line.includes(markerPrefix)) {
				this.sink.marked(line, category);
			} else {
				this.tail.append(`${line}\n`);
			}
		}
	}

	private stopped(body: unknown): void {
		if (!isRecord(body)) {
			return;
		}
		const ids = Array.isArray(body.hitBreakpointIds) ? body.hitBreakpointIds.filter((id): id is number => typeof id === 'number') : [];
		this.sink.stopped({
			reason: typeof body.reason === 'string' ? body.reason : '',
			...typeof body.threadId === 'number' ? { threadId: body.threadId } : {},
			hitBreakpointIds: ids,
			...typeof body.description === 'string' ? { description: body.description } : {},
			...typeof body.text === 'string' ? { text: body.text } : {},
		});
	}
}

/** `promise`, or `undefined` once `ms` pass; a slow or missing answer never holds the program. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, timers: Timers = defaultTimers): Promise<T | undefined> {
	return new Promise<T | undefined>(resolve => {
		const timer = timers.set(() => resolve(undefined), ms);
		Promise.resolve(promise).then(value => {
			timers.clear(timer);
			resolve(value);
		}, () => {
			timers.clear(timer);
			resolve(undefined);
		});
	});
}

export interface Timers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimers: Timers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SnapshotFrame {
	readonly name: string;
	readonly file?: string;
	readonly line?: number;
}

export interface SnapshotVariable {
	readonly name: string;
	readonly value: string;
	readonly children?: readonly SnapshotVariable[];
}

export interface Snapshot {
	readonly frames: readonly SnapshotFrame[];
	readonly variables: readonly SnapshotVariable[];
	/** Something was left out: a timeout, or a cap. */
	readonly partial: boolean;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * A snapshot of the stopped thread: the top frames, the top frame's locals
 * two levels down, each request with its own timeout and the whole under
 * one deadline. Nothing here continues the thread.
 */
export async function takeSnapshot(request: DapRequest, threadId: number, now: () => number = Date.now, timers: Timers = defaultTimers): Promise<Snapshot> {
	const limits = snapshotLimits;
	const deadline = now() + limits.totalMs;
	let partial = false;
	const ask = async (command: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
		const left = deadline - now();
		if (left <= 0) {
			partial = true;
			return undefined;
		}
		const answer = await withTimeout(request(command, args), Math.min(limits.requestMs, left), timers);
		if (!isRecord(answer)) {
			partial = true;
			return undefined;
		}
		return answer;
	};
	const trace = await ask('stackTrace', { threadId, startFrame: 0, levels: limits.frames });
	const rawFrames = Array.isArray(trace?.stackFrames) ? trace.stackFrames.filter(isRecord).slice(0, limits.frames) : [];
	const frames: SnapshotFrame[] = rawFrames.map(frame => ({
		name: typeof frame.name === 'string' ? clip(frame.name, limits.valueChars) : '?',
		...isRecord(frame.source) && typeof frame.source.path === 'string' ? { file: frame.source.path } : isRecord(frame.source) && typeof frame.source.name === 'string' ? { file: frame.source.name } : {},
		...typeof frame.line === 'number' ? { line: frame.line } : {},
	}));
	const top = rawFrames[0];
	if (!top || typeof top.id !== 'number') {
		return { frames, variables: [], partial: true };
	}
	const scopes = await ask('scopes', { frameId: top.id });
	const scopeList = Array.isArray(scopes?.scopes) ? scopes.scopes.filter(isRecord) : [];
	const locals = scopeList.find(scope => scope.presentationHint === 'locals') ?? scopeList.find(scope => typeof scope.name === 'string' && /local/i.test(scope.name)) ?? scopeList.find(scope => scope.expensive !== true);
	const reference = typeof locals?.variablesReference === 'number' ? locals.variablesReference : 0;
	let budget = limits.entries;
	const read = async (ref: number, depth: number, max: number): Promise<SnapshotVariable[]> => {
		if (!ref || budget <= 0) {
			return [];
		}
		const answer = await ask('variables', { variablesReference: ref, count: max });
		const list = Array.isArray(answer?.variables) ? answer.variables.filter(isRecord) : [];
		if (list.length > max) {
			partial = true;
		}
		const out: SnapshotVariable[] = [];
		for (const variable of list.slice(0, max)) {
			if (budget <= 0) {
				partial = true;
				break;
			}
			budget--;
			const name = typeof variable.name === 'string' ? clip(variable.name, limits.valueChars) : '?';
			const value = typeof variable.value === 'string' ? clip(variable.value, limits.valueChars) : '';
			const childRef = typeof variable.variablesReference === 'number' ? variable.variablesReference : 0;
			const children = depth < limits.depth && childRef ? await read(childRef, depth + 1, limits.children) : undefined;
			out.push({ name, value, ...children?.length ? { children } : {} });
		}
		return out;
	};
	const variables = await read(reference, 1, limits.entries);
	return { frames, variables, partial };
}

/** A snapshot as one evidence event's text. */
export function formatSnapshot(snapshot: Snapshot): string {
	const lines = snapshot.frames.map((frame, i) => `#${i} ${frame.name}${frame.file ? ` (${frame.file.replace(/\\/g, '/').split('/').pop()}${frame.line ? `:${frame.line}` : ''})` : ''}`);
	const walk = (list: readonly SnapshotVariable[], indent: string) => {
		for (const variable of list) {
			lines.push(`${indent}${variable.name} = ${variable.value}`);
			if (variable.children) {
				walk(variable.children, `${indent}  `);
			}
		}
	};
	walk(snapshot.variables, '  ');
	if (snapshot.partial) {
		lines.push('  (partial: a request timed out or a cap was reached)');
	}
	return lines.join('\n');
}

/**
 * Stops the agent holds, each continued by itself after `holdMs` (or at the
 * turn's end, or Clean up, whichever is first), so a program never stays
 * paused because a model stopped answering.
 */
export class Holds {

	private readonly held = new Map<string, { readonly resume: () => void; readonly timer: unknown; readonly threadId: number; readonly point: string }>();

	constructor(private readonly timers: Timers = defaultTimers, private readonly holdMs: number = bridgeLimits.holdMs) { }

	hold(id: string, point: string, threadId: number, resume: () => void): void {
		this.release(id);
		const timer = this.timers.set(() => this.release(id), this.holdMs);
		this.held.set(id, { resume, timer, threadId, point });
	}

	get(id: string): { readonly threadId: number; readonly point: string } | undefined {
		return this.held.get(id);
	}

	/** Continues the stop; false when it was not held. */
	release(id: string): boolean {
		const entry = this.held.get(id);
		if (!entry) {
			return false;
		}
		this.held.delete(id);
		this.timers.clear(entry.timer);
		entry.resume();
		return true;
	}

	releaseAll(): number {
		const ids = [...this.held.keys()];
		ids.forEach(id => this.release(id));
		return ids.length;
	}

	get size(): number {
		return this.held.size;
	}

	get ids(): readonly string[] {
		return [...this.held.keys()];
	}
}

export type StopOutcome =
	/** At none of the agent's points: the user's stop; nothing is continued. */
	| { readonly kind: 'user' }
	| { readonly kind: 'snapshot'; readonly point: string; readonly text: string }
	| { readonly kind: 'held'; readonly point: string; readonly stop: string; readonly text: string }
	/** Over the snapshot cap: counted and continued. */
	| { readonly kind: 'counted'; readonly point: string };

export interface StopContext {
	/** The agent's active breakpoint point a DAP breakpoint id belongs to. */
	pointFor(dapId: number): PromiseLike<Point | undefined>;
	readonly request: DapRequest;
	/** Snapshots of `point` taken in this run so far. */
	snapshots(point: string): number;
	/** A new id for a held stop. */
	stopId(): string;
	readonly holds: Holds;
	readonly now?: () => number;
	readonly timers?: Timers;
}

/** The point a stop is at, if it is one of the agent's breakpoints. */
async function pointOfStop(stop: StoppedEvent, context: StopContext): Promise<Point | undefined> {
	if (stop.reason !== 'breakpoint' && stop.reason !== 'function breakpoint' && stop.reason !== 'data breakpoint') {
		// Some adapters report a hit breakpoint with another reason but with its ids.
		if (!stop.hitBreakpointIds.length) {
			return undefined;
		}
	}
	for (const id of stop.hitBreakpointIds) {
		const point = await context.pointFor(id);
		if (point && point.kind === 'breakpoint' && point.status === 'active') {
			return point;
		}
	}
	return undefined;
}

/** A stop at one of the agent's points: snapshot and continue, or hold; the user's stops are left alone. */
export async function handleStop(stop: StoppedEvent, context: StopContext): Promise<StopOutcome> {
	const point = await pointOfStop(stop, context);
	if (!point || stop.threadId === undefined) {
		return { kind: 'user' };
	}
	const threadId = stop.threadId;
	const resume = () => void Promise.resolve(context.request('continue', { threadId })).then(undefined, () => undefined);
	if (context.snapshots(point.id) >= bridgeLimits.snapshotsPerRun) {
		resume();
		return { kind: 'counted', point: point.id };
	}
	const snapshot = await takeSnapshot(context.request, threadId, context.now, context.timers);
	const text = formatSnapshot(snapshot);
	if (point.hold) {
		const id = context.stopId();
		context.holds.hold(id, point.id, threadId, resume);
		return { kind: 'held', point: point.id, stop: id, text };
	}
	resume();
	return { kind: 'snapshot', point: point.id, text };
}

/** What a held stop's `debug_inspect` evaluates: `hover` for plain paths, `repl` for an approved expression. */
export async function evaluateAt(request: DapRequest, threadId: number, frame: number, expressions: readonly string[], approved: ReadonlySet<string>, timers: Timers = defaultTimers): Promise<string> {
	const trace = await withTimeout(request('stackTrace', { threadId, startFrame: frame, levels: 1 }), snapshotLimits.requestMs, timers);
	const top = isRecord(trace) && Array.isArray(trace.stackFrames) ? trace.stackFrames.find(isRecord) : undefined;
	if (!top || typeof top.id !== 'number') {
		return 'The stop has no such frame.';
	}
	const lines: string[] = [];
	for (const expression of expressions) {
		const answer = await withTimeout(request('evaluate', { expression, frameId: top.id, context: approved.has(expression) ? 'repl' : 'hover' }), snapshotLimits.requestMs, timers);
		lines.push(`${expression} = ${isRecord(answer) && typeof answer.result === 'string' ? clip(answer.result, 500) : '(no answer)'}`);
	}
	return lines.join('\n');
}

/** The fields of a point's `SourceBreakpoint`: the logpoint's message, and the condition with the environment guard when `guarded`. */
export function breakpointSpec(point: Point, nonce: string, guarded: boolean): { readonly condition?: string; readonly hitCondition?: string; readonly logMessage?: string } {
	const language = languageOf(point.file);
	const guard = guarded && language ? environmentGuard(language, nonce) : undefined;
	if (point.kind === 'logpoint') {
		return { ...guard ? { condition: guard } : {}, logMessage: logpointMessage(nonce, point.id, point.expressions ?? []) };
	}
	const condition = language ? joinCondition(language, guard, point.condition) : point.condition;
	return { ...condition ? { condition } : {}, ...point.hitCount ? { hitCondition: String(point.hitCount) } : {} };
}

export interface LaunchCard {
	readonly name: string;
	readonly type: string;
	readonly request: string;
	readonly program?: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly preLaunchTask?: string;
	readonly postDebugTask?: string;
	/** Only the names: values never reach the model or the card. */
	readonly envNames: readonly string[];
}

export type ResolvedLaunch = { readonly ok: true; readonly config: Record<string, unknown>; readonly card: LaunchCard } | { readonly ok: false; readonly error: string };

const allowedVariables = /^\$\{(workspaceFolder|workspaceRoot|workspaceFolderBasename|pathSeparator|\/|userHome|env:[A-Za-z_][\w]*)\}$/;

function basename(folder: string): string {
	return folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
}

/** `value` with the folder's variables filled in; the first variable that depends on the editor or runs a command, when there is one. */
function substitute(value: unknown, folder: string, refused: string[]): unknown {
	if (typeof value === 'string') {
		return value.replace(/\$\{[^}]*\}/g, variable => {
			if (!allowedVariables.test(variable)) {
				refused.push(variable);
				return variable;
			}
			switch (variable) {
				case '${workspaceFolder}':
				case '${workspaceRoot}':
					return folder;
				case '${workspaceFolderBasename}':
					return basename(folder);
				default:
					// ${env:...}, ${userHome}, ${pathSeparator}: VS Code fills them in; none depends on the editor.
					return variable;
			}
		});
	}
	if (Array.isArray(value)) {
		return value.map(item => substitute(item, folder, refused));
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, folder, refused)]));
	}
	return value;
}

/**
 * GeminiCode's copy of a launch configuration, never the user's object: the
 * folder's variables filled in for the agent's folder (a worktree is not a
 * workspace folder), variables that depend on the editor or run commands
 * refused, `serverReadyAction` removed, the session marker and the
 * environment guard added, and what the card shows.
 */
export function resolveLaunchConfig(config: unknown, folder: string, nonce: string): ResolvedLaunch {
	if (!isRecord(config)) {
		return { ok: false, error: 'The configuration is not an object.' };
	}
	if (Array.isArray(config.configurations)) {
		return { ok: false, error: 'Compound configurations are not supported yet: launch the parts one at a time.' };
	}
	if (typeof config.type !== 'string' || !config.type) {
		return { ok: false, error: 'The configuration has no type (such as node or debugpy).' };
	}
	const refused: string[] = [];
	const copy = substitute(config, folder, refused) as Record<string, unknown>;
	if (refused.length) {
		return { ok: false, error: `The configuration uses ${[...new Set(refused)].join(', ')}, which depends on the editor or runs a command; Debug mode fills in only the folder's variables and \${env:...}.` };
	}
	delete copy.serverReadyAction;
	const env = isRecord(copy.env) ? copy.env : {};
	copy.env = { ...env, [guardVariable]: nonce };
	copy[sessionMarker] = nonce;
	if (copy.type === 'debugpy' || copy.type === 'python') {
		copy.subProcess = true;
	}
	const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
	const program = typeof copy.program === 'string' ? copy.program : typeof copy.module === 'string' ? `-m ${copy.module}` : typeof copy.runtimeExecutable === 'string' ? copy.runtimeExecutable : undefined;
	const card: LaunchCard = {
		name: typeof copy.name === 'string' ? copy.name : copy.type as string,
		type: copy.type as string,
		request: typeof copy.request === 'string' ? copy.request : 'launch',
		...program ? { program } : {},
		args: [...strings(copy.runtimeArgs), ...strings(copy.args)],
		...typeof copy.cwd === 'string' ? { cwd: copy.cwd } : {},
		...typeof copy.preLaunchTask === 'string' ? { preLaunchTask: copy.preLaunchTask } : {},
		...typeof copy.postDebugTask === 'string' ? { postDebugTask: copy.postDebugTask } : {},
		envNames: Object.keys(env).sort(),
	};
	return { ok: true, config: copy, card };
}

export interface SmallLaunch {
	readonly type?: string;
	readonly program?: string;
	readonly module?: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

/** Whether `relative`, joined to `folder`, stays inside it. */
function inside(relative: string): boolean {
	return !/^(?:[\\/]|[A-Za-z]:)/.test(relative) && !relative.split(/[\\/]/).includes('..');
}

/** The small configuration the agent proposes when there is no launch.json entry: Node or Python. */
export function smallConfig(launch: SmallLaunch, folder: string, join: (folder: string, relative: string) => string): { readonly ok: true; readonly config: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
	const target = launch.program ?? launch.module;
	if (!target) {
		return { ok: false, error: 'A small configuration needs a program or a module.' };
	}
	if (launch.program && !inside(launch.program)) {
		return { ok: false, error: 'The program must be inside the agent\'s folder, as a relative path.' };
	}
	if (launch.cwd && !inside(launch.cwd)) {
		return { ok: false, error: 'The working folder must be inside the agent\'s folder, as a relative path.' };
	}
	const python = launch.type === 'debugpy' || launch.type === 'python' || !!launch.module || /\.pyw?$/i.test(launch.program ?? '');
	const type = launch.type ?? (python ? 'debugpy' : 'node');
	if (type !== 'node' && type !== 'pwa-node' && type !== 'debugpy' && type !== 'python') {
		return { ok: false, error: `A small configuration is for node or debugpy; for ${type}, add a launch configuration and name it.` };
	}
	const cwd = launch.cwd ? join(folder, launch.cwd) : folder;
	const config: Record<string, unknown> = {
		type: python ? 'debugpy' : 'node',
		request: 'launch',
		name: 'Gemini debug',
		...launch.program ? { program: join(folder, launch.program) } : { module: launch.module },
		args: [...launch.args],
		cwd,
		console: 'internalConsole',
		...python ? { justMyCode: true } : { skipFiles: ['<node_internals>/**'] },
	};
	return { ok: true, config };
}

/** Whether the program reloads its own code, so a marked line needs no restart. */
export function reloadsItself(config: Record<string, unknown>): boolean {
	const text = [config.program, config.runtimeExecutable, config.module, ...Array.isArray(config.runtimeArgs) ? config.runtimeArgs : [], ...Array.isArray(config.args) ? config.args : []].filter(item => typeof item === 'string').join(' ');
	return /\bnodemon\b|--watch\b|\bvite\b|\bnext\s+dev\b|--reload\b|\btsx\s+watch\b/.test(text);
}

export function isLoopback(host: string): boolean {
	return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]';
}

/** The attach configuration for a port on this machine or a process id; debugpy's port, 5678, attaches with debugpy. */
export function attachConfig(args: { readonly port?: number; readonly processId?: number; readonly type?: string }, nonce: string): Record<string, unknown> {
	const type = args.type ?? (args.port === 5678 ? 'debugpy' : 'node');
	const base = { name: 'Gemini attach', request: 'attach', [sessionMarker]: nonce };
	if (type === 'debugpy' || type === 'python') {
		return args.port !== undefined
			? { ...base, type: 'debugpy', connect: { host: '127.0.0.1', port: args.port }, justMyCode: true }
			: { ...base, type: 'debugpy', processId: args.processId };
	}
	return args.port !== undefined
		? { ...base, type: 'node', address: '127.0.0.1', port: args.port, skipFiles: ['<node_internals>/**'] }
		: { ...base, type: 'node', processId: String(args.processId) };
}

/** A debug session as the tracker factory sees it. */
export interface SessionLike {
	readonly configuration: Readonly<Record<string, unknown>>;
	readonly parentSession?: SessionLike;
}

/** The nonce of the Debug mode a session belongs to: its own marker, or its parent chain's; undefined for the user's sessions. */
export function trackedNonce(session: SessionLike | undefined): string | undefined {
	for (let current = session, depth = 0; current && depth < 16; current = current.parentSession, depth++) {
		const marker = current.configuration[sessionMarker];
		if (typeof marker === 'string') {
			return marker;
		}
	}
	return undefined;
}

/** launch.json's text as JSON: its comments and trailing commas taken out, strings left as they are; undefined when it is not JSON then. */
export function parseJsonc(text: string): unknown {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			const end = /"(?:[^"\\]|\\.)*"/y;
			end.lastIndex = i;
			const match = end.exec(text);
			const literal = match ? match[0] : text.slice(i);
			out += literal;
			i += literal.length - 1;
		} else if (char === '/' && text[i + 1] === '/') {
			const newline = text.indexOf('\n', i);
			i = newline < 0 ? text.length : newline - 1;
		} else if (char === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			i = close < 0 ? text.length : close + 1;
		} else {
			out += char;
		}
	}
	try {
		return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
	} catch {
		return undefined;
	}
}

export interface ConfigEntry {
	readonly folder: string;
	readonly config: unknown;
}

/** What `debug_configs` answers: each configuration's name, type, request and program (never env values), the compounds by their parts, running sessions and listening debug ports. */
export function describeConfigs(entries: readonly ConfigEntry[], compounds: readonly { readonly name: string; readonly parts: readonly string[] }[], sessions: readonly string[], ports: readonly number[]): string {
	const lines: string[] = [];
	if (!entries.length) {
		lines.push('No launch configurations (no launch.json entries). Propose a small one with debug_launch: type node or debugpy, program or module, args, cwd. Debug mode never writes launch.json.');
	} else {
		lines.push('Launch configurations:');
		for (const entry of entries) {
			const config = isRecord(entry.config) ? entry.config : {};
			const name = typeof config.name === 'string' ? config.name : '(unnamed)';
			const what = typeof config.program === 'string' ? config.program : typeof config.module === 'string' ? `-m ${config.module}` : typeof config.runtimeExecutable === 'string' ? config.runtimeExecutable : '';
			const env = isRecord(config.env) ? Object.keys(config.env) : [];
			lines.push(`- ${name}: ${String(config.type ?? '?')} ${String(config.request ?? 'launch')}${what ? ` ${what}` : ''}${typeof config.preLaunchTask === 'string' ? `, before: ${config.preLaunchTask}` : ''}${env.length ? `, env: ${env.join(', ')} (values not shown)` : ''} (${entry.folder})`);
		}
	}
	for (const compound of compounds) {
		lines.push(`- ${compound.name}: compound of ${compound.parts.join(', ')} (not supported yet: launch the parts one at a time)`);
	}
	lines.push(sessions.length ? `Debug sessions running: ${sessions.join(', ')}.` : 'No debug sessions running.');
	lines.push(ports.length ? `Debug ports listening on 127.0.0.1: ${ports.join(', ')} (debug_attach with the port).` : 'No common debug port (9229, 9230, 5678) is listening on 127.0.0.1.');
	return lines.join('\n');
}

/** The launch card as the model reads it after a launch. */
export function describeLaunch(card: LaunchCard): string {
	return [
		`${card.name} (${card.type} ${card.request})`,
		card.program ? `program ${card.program}${card.args.length ? ` ${card.args.join(' ')}` : ''}` : '',
		card.cwd ? `in ${card.cwd}` : '',
		card.preLaunchTask ? `before start: ${card.preLaunchTask}` : '',
		card.envNames.length ? `environment: ${card.envNames.join(', ')}` : '',
	].filter(Boolean).join('; ');
}

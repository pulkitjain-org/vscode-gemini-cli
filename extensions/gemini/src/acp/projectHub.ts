/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project's hub: the coordinator's wake loop and its tools. The extension
// plays the platform's part. Events (the user posts, a thread reports, a
// thread fails) become short wake prompts for the coordinator session, which
// answers with tool calls: start or steer a thread, or post in the project
// chat. Speed rules (gemini/docs/ARCHITECTURE.md, Projects):
// - Starting work never waits for the coordinator: a thread the user starts
//   begins at once and the coordinator is told afterwards.
// - One model turn per wake: each wake already carries the thread list, the
//   project memory and Conductor's open tracks, so nothing needs fetching.
// - A wake goes out the moment the coordinator is idle; events are batched
//   only while it is mid-turn, never on a timer.
// - Changes the user already sees (a thread working, waiting or done) don't
//   wake it; only reports, failures and the user's own posts do.

import { conductorSummary, type ConductorContext } from './conductor';
import { Emitter } from './events';
import type { McpToolResult } from './browserMcp';
import type { ProjectCaller, ProjectToolHost } from './projectMcp';

export type ThreadState = 'starting' | 'working' | 'waiting' | 'planned' | 'done' | 'error';

export interface ThreadInfo {
	readonly id: string;
	readonly title: string;
	readonly state: ThreadState;
	/** What it is doing or last said, one line. */
	readonly detail?: string;
	readonly branch?: string;
	/** Started by the coordinator rather than the user. */
	readonly byCoordinator: boolean;
}

export interface ThreadRequest {
	readonly title: string;
	readonly brief: string;
	readonly planFirst: boolean;
	readonly byCoordinator: boolean;
	/** The Conductor track the brief came from. */
	readonly track?: string;
	/** The branch the user named in the New thread dialog. */
	readonly branch?: string;
	/** The model the user picked in the New thread dialog. */
	readonly model?: string;
}

/** Makes and drives threads: agents in the extension, or plain sessions in the spike. */
export interface ThreadDriver {
	/**
	 * Creates a thread and queues `brief` as its first prompt. Resolves with
	 * its id as soon as it exists, without waiting for its first reply.
	 */
	start(request: ThreadRequest): Promise<string>;
	/** Adds `text` to the thread's next turn. */
	message(thread: string, text: string): void;
	/** The thread's latest messages as text, newest last. */
	read(thread: string, last: number): string | undefined;
}

/** The coordinator's agent session. */
export interface CoordinatorSession {
	/** Sends a prompt; resolves when the turn ends. */
	prompt(text: string): Promise<void>;
}

export type ProjectEvent =
	| { readonly kind: 'user'; readonly text: string }
	/** A thread's report; context only, like the rest below. */
	| { readonly kind: 'report'; readonly thread: string; readonly report: 'result' | 'blocker' | 'question'; readonly text: string }
	| { readonly kind: 'failed'; readonly thread: string; readonly text: string }
	/** A thread the user started themselves; context for the next wake, which it doesn't cause. */
	| { readonly kind: 'started'; readonly thread: string }
	/** The user wrote in a thread; context only. */
	| { readonly kind: 'threadUser'; readonly thread: string; readonly text: string };

export type FeedEntry =
	| { readonly kind: 'user'; readonly text: string; readonly at: number }
	| { readonly kind: 'coordinator'; readonly text: string; readonly at: number }
	| { readonly kind: 'thread'; readonly thread: string; readonly at: number };

export interface ProjectContext {
	/** The project's memory notes, if any. */
	memory?(): Promise<string | undefined>;
	conductor?(): Promise<ConductorContext | undefined>;
	trackBrief?(track: string): Promise<string | undefined>;
}

/** Counts for the spike and the usage meter. */
export interface HubStats {
	wakes: number;
	tools: Record<string, number>;
}

/** The first prompt's role brief. Short on purpose: the wake carries the facts. */
export const coordinatorBrief = [
	'You are the coordinator of a GeminiCode project. You never read code, write code, edit files or run commands yourself, even to look before starting a thread: your folder is empty on purpose, and threads work in the repository and read what they need.',
	'Threads do the work: each is an agent on its own branch and worktree. Use start_thread for any request that needs code read or changed, one thread per independent piece of work, with a brief that says everything it needs.',
	'Answer directly with post only when the wake already holds the answer (what threads exist, what one is waiting on).',
	'Relay what the user adds about a running thread with message_thread. Approvals are answered by the user in the thread that asked, never by you.',
	'The user finishes a thread\'s work in that thread: its results, questions and failures reach you only as context with the user\'s next message, and need no post of their own.',
	'Each wake arrives as <wake> with the threads, the project notes, open Conductor tracks if any, and the events. Act on the events in one turn: call the tools you need, then stop. Keep posts to a line or two.',
].join('\n');

/**
 * How many threads are in each state, for the project chat's side panel.
 * Starting counts as working and an error as done; merged threads count only
 * as merged, and undone ones not at all.
 */
export function threadCounts(threads: readonly Pick<ThreadInfo, 'id' | 'state'>[], merged: ReadonlySet<string>, removed: ReadonlySet<string>): { working: number; waiting: number; planned: number; done: number; merged: number } {
	const counts = { working: 0, waiting: 0, planned: 0, done: 0, merged: 0 };
	for (const thread of threads) {
		const state = panelState(thread, merged, removed);
		if (state) {
			counts[state]++;
		}
	}
	return counts;
}

/** The side panel's state for a thread, as `threadCounts` counts it; undefined for an undone thread. */
export function panelState(thread: Pick<ThreadInfo, 'id' | 'state'>, merged: ReadonlySet<string>, removed: ReadonlySet<string>): PanelThreadState | undefined {
	if (removed.has(thread.id)) {
		return undefined;
	}
	if (merged.has(thread.id)) {
		return 'merged';
	}
	switch (thread.state) {
		case 'starting':
		case 'working':
			return 'working';
		case 'waiting':
			return 'waiting';
		case 'planned':
			return 'planned';
		case 'done':
		case 'error':
			return 'done';
	}
}

export type PanelThreadState = 'working' | 'waiting' | 'planned' | 'done' | 'merged';

/**
 * The coordinator's model: a named Flash model (never Auto, which adds a
 * routing call before every prompt), the newest the agent offers, leaving out
 * Flash-Lite and the image, live and speech models.
 */
export function coordinatorModel(ids: readonly string[]): string | undefined {
	const flash = ids.filter(id => /flash/i.test(id) && !/lite|image|live|tts|audio/i.test(id));
	const version = (id: string) => Number(/(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
	return [...flash].sort((a, b) => version(b) - version(a) || Number(/preview/i.test(a)) - Number(/preview/i.test(b)))[0];
}

/** A thread's first prompt: its brief, then how it reports back. */
export function threadPrompt(brief: string, planFirst: boolean): string {
	return [
		brief.trim(),
		planFirst
			? 'Before changing anything, write a short plan and stop; the user reads it and says go.'
			: undefined,
		'When the work is done, or you are blocked, or only the user can answer something, call the report tool once with one or two sentences.',
	].filter(Boolean).join('\n\n');
}

export class ProjectHub implements ProjectToolHost {

	private readonly threads = new Map<string, ThreadInfo>();
	private readonly pending: ProjectEvent[] = [];
	private busy = false;
	private briefed = false;
	private disposed = false;
	private turn: Promise<void> | undefined;

	private readonly onDidPostEmitter = new Emitter<FeedEntry>();
	/** Entries for the project chat. */
	readonly onDidPost = this.onDidPostEmitter.event;
	private readonly onDidChangeThreadEmitter = new Emitter<ThreadInfo>();
	readonly onDidChangeThread = this.onDidChangeThreadEmitter.event;
	private readonly onDidChangeBusyEmitter = new Emitter<boolean>();
	readonly onDidChangeBusy = this.onDidChangeBusyEmitter.event;

	readonly stats: HubStats = { wakes: 0, tools: {} };

	constructor(
		readonly id: string,
		private readonly coordinator: CoordinatorSession,
		private readonly driver: ThreadDriver,
		private readonly context: ProjectContext = {},
	) { }

	get coordinatorBusy(): boolean {
		return this.busy;
	}

	get threadList(): readonly ThreadInfo[] {
		return [...this.threads.values()];
	}

	/** The user posts in the project chat. */
	post(text: string): void {
		this.onDidPostEmitter.fire({ kind: 'user', text, at: Date.now() });
		this.notify({ kind: 'user', text });
	}

	/** A thread the user starts directly: it begins at once, and the coordinator hears with the next wake. */
	async startThread(title: string, brief: string, planFirst = false, options: Pick<ThreadRequest, 'branch' | 'model'> = {}): Promise<string> {
		const id = await this.driver.start({ title, brief, planFirst, byCoordinator: false, ...options });
		this.setThread({ id, title, state: 'starting', byCoordinator: false });
		this.onDidPostEmitter.fire({ kind: 'thread', thread: id, at: Date.now() });
		this.notify({ kind: 'started', thread: id });
		return id;
	}

	/**
	 * Whether the coordinator's session already has the role brief: true when
	 * it was reopened with its history, false for a new session, which gets
	 * the brief with its next wake.
	 */
	setBriefed(briefed: boolean): void {
		this.briefed = briefed;
	}

	/** A thread from before a reload; tells nobody. */
	restoreThread(thread: ThreadInfo): void {
		this.threads.set(thread.id, thread);
	}

	/** The extension's view of a thread changed; never wakes the coordinator by itself. */
	updateThread(id: string, change: Partial<Omit<ThreadInfo, 'id' | 'byCoordinator'>>): void {
		const thread = this.threads.get(id);
		if (thread) {
			this.setThread({ ...thread, ...change });
		}
	}

	removeThread(id: string): void {
		this.threads.delete(id);
	}

	/** Queues an event; it wakes the coordinator unless it is context only. */
	notify(event: ProjectEvent): void {
		if (this.disposed) {
			return;
		}
		this.pending.push(event);
		if (event.kind === 'failed') {
			this.updateThread(event.thread, { state: 'error', detail: event.text });
		}
		if (wakes(event)) {
			void this.wake();
		}
	}

	/** Resolves once the coordinator has handled everything queued so far; for tests and the spike. */
	async idle(): Promise<void> {
		while (this.turn) {
			await this.turn;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.onDidPostEmitter.dispose();
		this.onDidChangeThreadEmitter.dispose();
		this.onDidChangeBusyEmitter.dispose();
	}

	private async wake(): Promise<void> {
		// One prompt at a time per session: what arrives meanwhile goes out when this turn ends.
		if (this.busy || this.disposed || !this.pending.some(wakes)) {
			return;
		}
		const events = this.pending.splice(0);
		this.setBusy(true);
		this.stats.wakes++;
		this.turn = (async () => {
			try {
				const prompt = await this.wakePrompt(events);
				await this.coordinator.prompt(prompt);
			} catch (err) {
				this.onDidPostEmitter.fire({ kind: 'coordinator', text: `The coordinator could not answer: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() });
			} finally {
				this.setBusy(false);
				this.turn = undefined;
			}
		})();
		await this.turn;
		void this.wake();
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.onDidChangeBusyEmitter.fire(busy);
	}

	private setThread(thread: ThreadInfo): void {
		this.threads.set(thread.id, thread);
		this.onDidChangeThreadEmitter.fire(thread);
	}

	/** The wake: the role brief the first time, then the facts the coordinator would otherwise fetch, then the events. */
	async wakePrompt(events: readonly ProjectEvent[]): Promise<string> {
		const [memory, conductor] = await Promise.all([
			this.context.memory?.().catch(() => undefined),
			this.context.conductor?.().catch(() => undefined),
		]);
		const parts: string[] = [];
		if (!this.briefed) {
			this.briefed = true;
			parts.push(coordinatorBrief);
		}
		parts.push('<wake>');
		parts.push(`<threads>\n${this.threads.size ? this.threadList.map(threadLine).join('\n') : 'none yet'}\n</threads>`);
		if (memory?.trim()) {
			parts.push(`<notes>\n${memory.trim()}\n</notes>`);
		}
		if (conductor) {
			parts.push(`<conductor>\n${conductorSummary(conductor)}\n</conductor>`);
		}
		for (const event of events) {
			parts.push(eventText(event));
		}
		parts.push('</wake>');
		return parts.join('\n');
	}

	async call(caller: ProjectCaller, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		if (caller.project !== this.id) {
			return error('This thread belongs to another project.');
		}
		this.stats.tools[name] = (this.stats.tools[name] ?? 0) + 1;
		if (caller.role === 'thread') {
			if (name !== 'report') {
				return error(`No tool named ${name}.`);
			}
			const kind = args.kind === 'blocker' || args.kind === 'question' ? args.kind : 'result';
			const text = str(args.text);
			if (!text) {
				return error('Say what to report in text.');
			}
			this.updateThread(caller.thread, { detail: text });
			this.notify({ kind: 'report', thread: caller.thread, report: kind, text });
			return ok('The coordinator has it.');
		}
		switch (name) {
			case 'start_thread': {
				const title = str(args.title);
				let brief = str(args.brief);
				const track = str(args.track);
				if (track) {
					const trackBrief = await this.context.trackBrief?.(track);
					if (!trackBrief) {
						return error(`No Conductor track "${track}".`);
					}
					brief = brief ? `${brief}\n\n${trackBrief}` : trackBrief;
				}
				if (!title || !brief) {
					return error('A thread needs a title and a brief.');
				}
				const planFirst = args.planFirst === true;
				const id = await this.driver.start({ title, brief, planFirst, byCoordinator: true, ...(track ? { track } : {}) });
				this.setThread({ id, title, state: 'starting', byCoordinator: true });
				this.onDidPostEmitter.fire({ kind: 'thread', thread: id, at: Date.now() });
				return ok(`Started thread ${id}.`);
			}
			case 'message_thread': {
				const thread = str(args.thread);
				const text = str(args.text);
				if (!this.threads.has(thread)) {
					return error(`No thread ${thread}.`);
				}
				if (!text) {
					return error('Say what to send in text.');
				}
				this.driver.message(thread, text);
				return ok('Queued for its next turn.');
			}
			case 'list_threads':
				return ok(this.threads.size ? this.threadList.map(threadLine).join('\n') : 'No threads yet.');
			case 'read_thread': {
				const thread = str(args.thread);
				const last = typeof args.last === 'number' && args.last > 0 ? Math.min(Math.floor(args.last), 50) : 10;
				const text = this.threads.has(thread) ? this.driver.read(thread, last) : undefined;
				return text === undefined ? error(`No thread ${thread}.`) : ok(text || '(no messages yet)');
			}
			case 'post': {
				const text = str(args.text);
				if (!text) {
					return error('Say what to post in text.');
				}
				this.onDidPostEmitter.fire({ kind: 'coordinator', text, at: Date.now() });
				return ok('Posted.');
			}
			default:
				return error(`No tool named ${name}.`);
		}
	}
}

/**
 * Only the user's own messages wake the coordinator. A thread's result,
 * question or failure is the user's to take up in that thread, where its card
 * leads; it reaches the coordinator as context with the next message.
 */
function wakes(event: ProjectEvent): boolean {
	return event.kind === 'user';
}

function threadLine(thread: ThreadInfo): string {
	return `- ${thread.id} "${thread.title}": ${thread.state}${thread.detail ? `, ${oneLine(thread.detail)}` : ''}${thread.byCoordinator ? '' : ' (started by the user)'}`;
}

function eventText(event: ProjectEvent): string {
	switch (event.kind) {
		case 'user':
			return `<event kind="user">\n${event.text}\n</event>`;
		case 'report':
			return `<event kind="report" thread="${event.thread}" report="${event.report}">\n${event.text}\n</event>`;
		case 'failed':
			return `<event kind="failed" thread="${event.thread}">\n${event.text}\n</event>`;
		case 'started':
			return `<event kind="started" thread="${event.thread}">The user started this thread themselves; it is already working.</event>`;
		case 'threadUser':
			return `<event kind="thread-user" thread="${event.thread}">\n${event.text}\n</event>`;
	}
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function ok(text: string): McpToolResult {
	return { content: [{ type: 'text', text }] };
}

function error(text: string): McpToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

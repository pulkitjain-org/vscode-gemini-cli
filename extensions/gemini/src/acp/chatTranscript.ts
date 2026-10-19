/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's model: folds the adapter's ChatEvents into a list of
// plain, serialisable items the webview renders. Streaming chunks extend the
// item they belong to; tool calls and the plan update in place.

import type * as acp from '@agentclientprotocol/sdk';
import { Emitter } from './events';
import type { PendingPermission } from './permissions';
import { Attachment, attachmentLabel } from './attachments';
import { ChatEvent, contentBlockToText, ToolCallModel } from './sessionUpdates';
import type { TurnReadout } from './traceRecording';
import type { ModelTokens } from './turnUsage';

export type ToolCallDetail =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'diff'; readonly path: string; readonly added: number; readonly removed: number }
	| { readonly type: 'terminal'; readonly terminalId: string };

export interface PromptAttachmentLabel {
	/** `page`: the page shared with the agent when the message was sent; its `path` is the page's address. */
	readonly kind: Attachment['kind'] | 'page';
	readonly label: string;
	/** For files and selections, so the view can open them. */
	readonly path?: string;
	readonly line?: number;
	/** For a Jira ticket, GitLab item or Figma frame: its tool and its `toolRefId`, so the view can open it there. */
	readonly tool?: 'jira' | 'gitlab' | 'figma';
	readonly ref?: string;
}

export interface ToolCallLocation {
	readonly path: string;
	/** 1-based, as ACP sends it. */
	readonly line?: number;
}

export type TranscriptItem =
	| {
		readonly id: string; readonly kind: 'user' | 'agent' | 'thought'; readonly text: string;
		/** Context sent with a user prompt, as labels (`app.ts`, `app.ts:10-20`). */
		readonly attachments?: readonly PromptAttachmentLabel[];
		/** When the user sent it, in ms since the epoch; unset for messages replayed from a saved session. */
		readonly at?: number;
		/** A thread's brief or a note relayed to it, sent by its project's coordinator rather than typed here. */
		readonly from?: 'coordinator';
	}
	| {
		readonly id: string; readonly kind: 'toolCall'; readonly title: string; readonly toolKind: string | undefined;
		readonly status: acp.ToolCallStatus; readonly locations: readonly ToolCallLocation[]; readonly details: readonly ToolCallDetail[];
	}
	| { readonly id: string; readonly kind: 'plan'; readonly entries: readonly { readonly content: string; readonly status: acp.PlanEntryStatus }[] }
	| {
		readonly id: string; readonly kind: 'permission'; readonly title: string;
		readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: acp.PermissionOptionKind }[];
		/** Files the tool would change; the view can open a diff for each. */
		readonly diffPaths: readonly string[];
		/** Confirm class (gemini/docs/adr/0006-confirm-class.md): hard to take back, so it asks every time with Allow once and Reject only. */
		readonly confirm?: boolean;
		/** Unset while the agent waits for an answer. */
		/** `automatic` when GeminiCode answered without asking, so the row doesn't say the user chose. */
		readonly answer?: { readonly kind: 'selected'; readonly name: string; readonly automatic?: true } | { readonly kind: 'cancelled' };
	}
	/** A project's thread, as a card in the project chat that updates in place. */
	| ThreadCard
	/** An update kind this version does not know (design rule 4 in gemini/docs/ARCHITECTURE.md). */
	| { readonly id: string; readonly kind: 'other'; readonly type: string }
	| { readonly id: string; readonly kind: 'notice'; readonly text: string; readonly severity: 'info' | 'error' }
	/** The saved chat's last turn never ended: GeminiCode quit while the agent worked. Offers to send the message again. */
	| { readonly id: string; readonly kind: 'cutOff'; readonly prompt: string; readonly dismissed?: boolean }
	/** Where a turn's time went, from the fork's measurements and the CLI's trace (while a trace is recording). */
	| { readonly id: string; readonly kind: 'trace'; readonly readout: TurnReadout; readonly file: string }
	/** Ends a turn: how long the agent worked, with a way to copy its reply, retry it, or undo its file changes. */
	| {
		readonly id: string; readonly kind: 'turnEnd'; readonly durationMs: number;
		/** When the turn ended, in ms since the epoch; unset in transcripts saved before it was recorded. */
		readonly at?: number;
		/** From the prompt's send to the agent's first reply text, in ms. */
		readonly firstTokenMs?: number;
		/** How many files the turn changed. */
		readonly files?: number;
		/** `available` while the turn's changes can be undone in this window; `undone` once they were. */
		readonly undo?: 'available' | 'undone';
		/** The latest turn offers to send its prompt again. */
		readonly retry?: boolean;
		/** The latest turn ended in Plan mode: it offers to leave Plan mode and carry out the plan. */
		readonly buildPlan?: boolean;
		/** Tokens the turn used per model, when the agent reported them. */
		readonly usage?: readonly ModelTokens[];
	};

/**
 * Update kinds that describe the session rather than the conversation. They
 * are not chat content, so the transcript skips them; later phases show them
 * elsewhere (commands, modes, usage).
 */
const SESSION_STATE_UPDATES: ReadonlySet<string> = new Set([
	'available_commands_update',
	'current_mode_update',
	'config_option_update',
	'session_info_update',
	'usage_update',
]);

export interface ThreadCard {
	readonly id: string;
	readonly kind: 'thread';
	/** The thread's agent id. */
	readonly thread: string;
	readonly title: string;
	readonly state: 'starting' | 'working' | 'waiting' | 'planned' | 'done' | 'error';
	/** What it is doing, waiting on, or last said; one line. */
	readonly detail?: string;
	readonly branch?: string;
	readonly changes?: { readonly files: number; readonly added: number; readonly removed: number };
	readonly startedAt: number;
	/** The Conductor track its brief came from. */
	readonly track?: string;
	/** Merged back into the project's branch; for a thread in several repositories, into every one it changed. */
	readonly merged?: boolean;
	/** A thread in several repositories: each one's changes, and whether they are merged back. */
	readonly repos?: readonly { readonly key: string; readonly files: number; readonly added: number; readonly removed: number; readonly merged?: boolean }[];
	/** Undone: its branch and folder are gone. */
	readonly removed?: boolean;
}

/** A thread card's item id. */
export function threadCardId(thread: string): string {
	return `thread-${thread}`;
}

type TextItem = Extract<TranscriptItem, { kind: 'user' | 'agent' | 'thought' }>;
export type TurnEndItem = Extract<TranscriptItem, { kind: 'turnEnd' }>;

export class ChatTranscript {

	private readonly onDidChangeItemEmitter = new Emitter<TranscriptItem>();
	/** Fires with an item that was added or replaced (same `id`). */
	readonly onDidChangeItem = this.onDidChangeItemEmitter.event;

	private readonly onDidResetEmitter = new Emitter<void>();
	readonly onDidReset = this.onDidResetEmitter.event;

	private _items: TranscriptItem[] = [];
	private nextId = 0;
	/** Index of the first item of the current turn; tool calls and the plan are looked up from here. */
	private turnStart = 0;
	private lastMessageId: string | null | undefined;
	/** The next text starts a new item even when it continues the last message. */
	private breakText = false;
	/**
	 * A coordinator's last post. Models often end the turn by saying the post
	 * again as their reply, so reply text is held while it repeats the post and
	 * dropped if that is all it was.
	 */
	private echo: string | undefined;
	private held = '';

	constructor(private readonly now: () => number = Date.now) { }

	get items(): readonly TranscriptItem[] {
		return this._items;
	}

	addPrompt(text: string, attachments: readonly Attachment[] = [], from?: 'coordinator'): void {
		this.settleEcho();
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.push({
			id: this.newId(), kind: 'user', text, at: this.now(), ...(from ? { from } : {}),
			...(attachments.length ? {
				attachments: attachments.map(a => ({
					kind: a.kind,
					label: attachmentLabel(a),
					...(a.kind === 'image' || a.path === undefined ? {} : { path: a.path }),
					...(a.kind === 'selection' ? { line: a.startLine } : {}),
					...(a.kind === 'document' && a.tool && a.ref ? { tool: a.tool, ref: a.ref } : {}),
				})),
			} : {}),
		});
	}

	/** Adds the page shared with the agent to the prompt just sent, as one of its attachments. */
	addPromptPage(title: string, url: string): void {
		const index = this._items.findLastIndex(item => item.kind === 'user');
		const item = this._items[index];
		if (item?.kind !== 'user' || index < this.turnStart) {
			return;
		}
		this.upsert({ ...item, attachments: [{ kind: 'page', label: title || url, path: url }, ...item.attachments ?? []] });
	}

	/** A user message replayed from a saved session: its own bubble, with no time, since the replay does not carry one. */
	addReplayedPrompt(text: string): void {
		this.settleEcho();
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.push({ id: this.newId(), kind: 'user', text });
	}

	apply(event: ChatEvent): void {
		if (event.kind !== 'text') {
			this.settleEcho();
		}
		switch (event.kind) {
			case 'text':
				this.appendText(event.role, event.text, event.messageId);
				break;
			case 'toolCall': {
				const item = toToolCallItem(event.call);
				const shown = !item.details.length ? this._items.findLast(i => i.id === item.id) : undefined;
				// An update of a finished call carries no content: it keeps what it showed.
				this.upsert(shown?.kind === 'toolCall' ? { ...item, details: shown.details } : item);
				break;
			}
			case 'plan':
				this.upsert({
					id: this.currentPlanId() ?? this.newId(),
					kind: 'plan',
					entries: event.entries.map(e => ({ content: e.content, status: e.status })),
				});
				break;
			case 'other':
				if (SESSION_STATE_UPDATES.has(event.type)) {
					break;
				}
				this.push({ id: this.newId(), kind: 'other', type: event.type });
				break;
		}
	}

	addPermission(permission: PendingPermission): void {
		const { toolCall, options } = permission.request;
		this.push({
			id: permission.id,
			kind: 'permission',
			title: toolCall.title ?? toolCall.toolCallId,
			options: options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
			diffPaths: (toolCall.content ?? []).flatMap(c => c.type === 'diff' ? [c.path] : []),
			...permission.confirm ? { confirm: true } : {},
		});
	}

	/** Records the answer; `label` says how it was chosen when the user didn't, such as "Allowed for this session". */
	resolvePermission(id: string, outcome: acp.RequestPermissionOutcome, label?: string): void {
		const item = this._items.find(i => i.id === id);
		if (item?.kind !== 'permission') {
			return;
		}
		const selected = outcome.outcome === 'selected' ? item.options.find(o => o.optionId === outcome.optionId) : undefined;
		this.upsert({ ...item, answer: selected ? { kind: 'selected', name: label ?? selected.name, ...(label === undefined ? {} : { automatic: true as const }) } : { kind: 'cancelled' } });
	}

	/** Ends the turn; returns the item's id. */
	addTurnEnd(durationMs: number, usage?: readonly ModelTokens[]): string {
		this.settleEcho();
		const id = this.newId();
		this.push({ id, kind: 'turnEnd', durationMs: Math.max(0, Math.round(durationMs)), at: this.now(), ...(usage?.length ? { usage } : {}) });
		return id;
	}

	/** Changes what a turnEnd item offers. */
	updateTurnEnd(id: string, patch: Pick<TurnEndItem, 'files' | 'undo' | 'retry' | 'buildPlan' | 'firstTokenMs'>): void {
		const item = this._items.find(i => i.id === id);
		if (item?.kind === 'turnEnd') {
			const next: Record<string, unknown> = { ...item, ...patch };
			for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
				if (patch[key] === undefined) {
					delete next[key];
				}
			}
			this.upsert(next as TurnEndItem);
		}
	}

	/** Adds a thread's card, or updates it in place. */
	showThread(card: Omit<ThreadCard, 'id' | 'kind'>): void {
		const id = threadCardId(card.thread);
		const current = this._items.find(item => item.id === id);
		const next: ThreadCard = { ...(current?.kind === 'thread' ? current : {}), ...card, id, kind: 'thread' };
		if (current?.kind === 'thread' && JSON.stringify(current) === JSON.stringify(next)) {
			return;
		}
		this.upsert(next);
	}

	/** A message from a project's coordinator, as its own paragraph of the reply. */
	addCoordinatorPost(text: string): void {
		this.settleEcho();
		this.push({ id: this.newId(), kind: 'agent', text });
		// Whatever it says next starts a new message.
		this.breakText = true;
		this.echo = squash(text) || undefined;
	}

	addNotice(text: string, severity: 'info' | 'error' = 'info'): void {
		this.push({ id: this.newId(), kind: 'notice', text, severity });
	}

	/** Says the last turn was cut off by a quit, with its prompt to send again. */
	addCutOff(prompt: string): void {
		this.push({ id: this.newId(), kind: 'cutOff', prompt });
	}

	/** Keeps the cut-off turn as it is: the card goes. */
	dismissCutOff(id: string): void {
		const item = this._items.find(i => i.id === id);
		if (item?.kind === 'cutOff') {
			this.upsert({ ...item, dismissed: true });
		}
	}

	/** The last turn's readout, after its end. */
	addTrace(readout: TurnReadout, file: string): void {
		this.push({ id: this.newId(), kind: 'trace', readout, file });
	}

	/** The last prompt the user sent, for a cut-off turn's Retry. */
	get lastUserPrompt(): string | undefined {
		for (let i = this._items.length - 1; i >= 0; i--) {
			const item = this._items[i];
			if (item.kind === 'user') {
				return item.text;
			}
		}
		return undefined;
	}

	/** Replaces the conversation with saved items, such as an agent's from an earlier window. */
	restore(items: readonly TranscriptItem[]): void {
		// A request still open when the chat was saved went with its session: nothing can answer its buttons now.
		this._items = items.map(item => item.kind === 'permission' && !item.answer ? { ...item, answer: { kind: 'cancelled' as const } } : item);
		this.nextId = Math.max(this.nextId, ...items.map(i => /^item-(\d+)$/.exec(i.id)).map(m => m ? Number(m[1]) + 1 : 0));
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.onDidResetEmitter.fire();
	}

	/** Takes item `id` and everything after it out of the conversation, for Rewind. */
	cutAt(id: string): void {
		const index = this._items.findIndex(item => item.id === id);
		if (index === -1) {
			return;
		}
		this.settleEcho();
		this._items = this._items.slice(0, index);
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.onDidResetEmitter.fire();
	}

	clear(): void {
		this._items = [];
		this.turnStart = 0;
		this.lastMessageId = undefined;
		this.onDidResetEmitter.fire();
	}

	dispose(): void {
		this.onDidChangeItemEmitter.dispose();
		this.onDidResetEmitter.dispose();
	}

	private appendText(role: TextItem['kind'], text: string, messageId: string | null | undefined): void {
		if (role === 'agent' && this.echo !== undefined) {
			this.held += text;
			const said = squash(this.held);
			if (this.echo.startsWith(said)) {
				return;
			}
			// It said more than the post: show only what is new.
			const rest = said.startsWith(this.echo) ? afterEcho(this.held, this.echo) : this.held;
			this.echo = undefined;
			this.held = '';
			if (rest) {
				this.appendText(role, rest, messageId);
			}
			return;
		}
		const last = this._items.at(-1);
		const sameMessage = !messageId || !this.lastMessageId || messageId === this.lastMessageId;
		if (last && last.kind === role && sameMessage && !this.breakText) {
			this.upsert({ ...last, text: last.text + text });
		} else {
			this.push({ id: this.newId(), kind: role, text });
		}
		this.breakText = false;
		if (messageId) {
			this.lastMessageId = messageId;
		}
	}

	/** Something other than reply text came: held text that only partly repeated the post is shown after all. */
	private settleEcho(): void {
		const held = this.held;
		const repeated = this.echo !== undefined && squash(held) === this.echo;
		this.echo = undefined;
		this.held = '';
		if (held && !repeated) {
			this.appendText('agent', held, undefined);
		}
	}

	private currentPlanId(): string | undefined {
		return this._items.slice(this.turnStart).find(item => item.kind === 'plan')?.id;
	}

	private upsert(item: TranscriptItem): void {
		const index = this._items.findIndex(existing => existing.id === item.id);
		if (index === -1) {
			this.push(item);
		} else {
			this._items[index] = item;
			this.onDidChangeItemEmitter.fire(item);
		}
	}

	private push(item: TranscriptItem): void {
		this._items.push(item);
		this.onDidChangeItemEmitter.fire(item);
	}

	private newId(): string {
		return `item-${this.nextId++}`;
	}
}

export function toolCallItemId(toolCallId: string): string {
	return `tool-${toolCallId}`;
}

function toToolCallItem(call: ToolCallModel): Extract<TranscriptItem, { readonly kind: 'toolCall' }> {
	return {
		id: toolCallItemId(call.id),
		kind: 'toolCall',
		title: call.title,
		toolKind: call.kind,
		status: call.status,
		locations: call.locations.map(l => l.line ? { path: l.path, line: l.line } : { path: l.path }),
		details: call.content.map(toToolCallDetail),
	};
}

function toToolCallDetail(content: acp.ToolCallContent): ToolCallDetail {
	switch (content.type) {
		case 'content':
			return { type: 'text', text: contentBlockToText(content.content) };
		case 'diff': {
			const { added, removed } = countChangedLines(content.oldText ?? '', content.newText);
			return { type: 'diff', path: content.path, added, removed };
		}
		case 'terminal':
			return { type: 'terminal', terminalId: content.terminalId };
	}
}

/** Lines only in the new text and only in the old text, compared as multisets. Enough for a summary. */
export function countChangedLines(oldText: string, newText: string): { added: number; removed: number } {
	const remaining = new Map<string, number>();
	const oldLines = oldText ? oldText.split('\n') : [];
	for (const line of oldLines) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1);
	}
	let added = 0;
	let kept = 0;
	for (const line of newText ? newText.split('\n') : []) {
		const count = remaining.get(line) ?? 0;
		if (count > 0) {
			remaining.set(line, count - 1);
			kept++;
		} else {
			added++;
		}
	}
	return { added, removed: oldLines.length - kept };
}

/** Text with its spacing evened out, to compare a reply with a post. */
function squash(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** What `text` says after repeating `echo`, which squash(text) starts with. */
function afterEcho(text: string, echo: string): string {
	let seen = 0;
	let index = 0;
	const squashed = text.replace(/^\s+/, '');
	const start = text.length - squashed.length;
	for (index = start; index < text.length && seen < echo.length; index++) {
		if (/\s/.test(text[index])) {
			if (!/\s/.test(text[index - 1] ?? '')) {
				seen++;
			}
		} else {
			seen++;
		}
	}
	return text.slice(index).replace(/^\s+/, '');
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's model: folds the adapter's ChatEvents into a list of
// plain, serialisable items the webview renders. Streaming chunks extend the
// item they belong to; tool calls and the plan update in place.

import type * as acp from '@agentclientprotocol/sdk';
import { Emitter } from './events';
import type { PendingPermission } from './permissions';
import { Attachment, attachmentLabel } from './attachments';
import { leadingReaction, type ReactionRef } from './reactions';
import type { TrimmedOutput } from './chatMemory';
import { ChatEvent, contentBlockToText, ToolCallModel } from './sessionUpdates';
import type { TurnReadout } from './traceRecording';
import type { ModelTokens } from './turnUsage';

export type ToolCallDetail =
	/**
	 * A tool's text output. A long one keeps only its first lines in `text` and its
	 * last in `tail`, with `hiddenLines` between them, which Show All fetches from the host.
	 */
	| { readonly type: 'text'; readonly text: string; readonly tail?: string; readonly hiddenLines?: number }
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

/**
 * The ways out a failed or cut-short turn's notice offers: send the prompt
 * again, pick another model, sign in again, carry on from the request limit,
 * open the Gemini log, or stop a stalled turn.
 */
/** `newSession`: the chat moves to a new session given the conversation so far, for a session Gemini keeps refusing. */
export type NoticeAction = 'retry' | 'switchModel' | 'signIn' | 'continue' | 'showLog' | 'stop' | 'newSession';

/** Another live agent in the same folder with changes still to review in a file this one edits. */
export interface OtherAgentChanges {
	/** The agent's id, to show its changes. */
	readonly agent: string;
	readonly title: string;
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
		/** A user prompt that carried reactions to the agent's replies. */
		readonly reactions?: readonly ReactionRef[];
		/** The emoji the agent reacted to this prompt with. */
		readonly agentReaction?: string;
	}
	| {
		readonly id: string; readonly kind: 'toolCall'; readonly title: string; readonly toolKind: string | undefined;
		readonly status: acp.ToolCallStatus; readonly locations: readonly ToolCallLocation[]; readonly details: readonly ToolCallDetail[];
		/** An edit applied without a card (Auto Edit) to a file another agent has unreviewed changes in. */
		readonly others?: readonly OtherAgentChanges[];
	}
	| { readonly id: string; readonly kind: 'plan'; readonly entries: readonly { readonly content: string; readonly status: acp.PlanEntryStatus }[] }
	| {
		readonly id: string; readonly kind: 'permission'; readonly title: string;
		readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: acp.PermissionOptionKind }[];
		/** Files the tool would change; the view can open a diff for each. */
		readonly diffPaths: readonly string[];
		/** Confirm class (gemini/docs/adr/0006-confirm-class.md): hard to take back, so it asks every time with Allow once and Reject only. */
		readonly confirm?: boolean;
		/** For a shell command, the prefixes "Allow for this session" covers (`npx vitest`, `git status`). */
		readonly prefixes?: readonly string[];
		/** Other agents with unreviewed changes in a file this edit changes. */
		readonly others?: readonly OtherAgentChanges[];
		/** Unset while the agent waits for an answer. */
		/** `automatic` when GeminiCode answered without asking, so the row doesn't say the user chose. */
		readonly answer?: { readonly kind: 'selected'; readonly name: string; readonly automatic?: true } | { readonly kind: 'cancelled' };
	}
	/** A project's thread, as a card in the project chat that updates in place. */
	| ThreadCard
	/** An update kind this version does not know (design rule 4 in gemini/docs/ARCHITECTURE.md). */
	| { readonly id: string; readonly kind: 'other'; readonly type: string }
	/**
	 * `retry`: a project's failed wake, which the hub can send again. `actions`: a failed
	 * or cut-short turn's ways out, on the latest such notice only, until the next turn starts.
	 */
	| { readonly id: string; readonly kind: 'notice'; readonly text: string; readonly severity: 'info' | 'error'; readonly retry?: boolean; readonly actions?: readonly NoticeAction[] }
	/** The saved chat's last turn never ended: GeminiCode quit while the agent worked. Offers to send the message again. */
	| { readonly id: string; readonly kind: 'cutOff'; readonly prompt: string; readonly dismissed?: boolean }
	/** Compact: the suggestion to compact this chat's session, then the switch to the compacted one. */
	| CompactItem
	/** Fork Agent: in a fork, where it was forked from; in its parent, a card for the fork. */
	| ForkItem
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
		/** How Build This Plan builds: in `mode`, the mode before Plan; its chevron offers `other`; `models` when the build's model differs from the plan's. */
		readonly build?: { readonly mode: string; readonly other?: string; readonly models?: { readonly plan: string; readonly build: string } };
		/** Tokens the turn used per model, when the agent reported them. */
		readonly usage?: readonly ModelTokens[];
		/** The turn was stopped or failed before the agent finished. */
		readonly unfinished?: boolean;
		/** Stopped for a message the user sent now, which the agent carries on with. */
		readonly steered?: boolean;
		/** The plan file a Plan mode turn wrote, for Review Plan. */
		readonly planFile?: string;
		/** The emoji the user reacted to this reply with, once each, oldest first. */
		readonly reactions?: readonly string[];
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
	/** Removed: its branch and folder are gone. */
	readonly removed?: boolean;
	/** Its work in the user's checkout: being tried, or kept as theirs. */
	readonly tried?: TriedCard;
	/** Discard Changes reset its folder; the work is saved for Restore. */
	readonly discarded?: boolean;
	/** Work Discard Changes saved, which later turns replaced: its ⋯ menu offers Restore. */
	readonly restorable?: boolean;
	/** Shows the first-try guide under the card. */
	readonly guide?: boolean;
	/** Merge Back makes a merge commit (`gemini.agents.mergeBack` set to "commit"): the card offers it instead of Try in Workspace. */
	readonly mergeCommits?: boolean;
}

/** A thread card's try: how many files, what the last update did, and what the user changed. */
export interface TriedCard {
	readonly state: 'trying' | 'kept';
	readonly files: number;
	/** How many times the checkout followed the thread's turns. */
	readonly updates?: number;
	/** Files whose conflict markers hold updating back. */
	readonly conflicts?: readonly string[];
	/** Files the last update couldn't merge (binary, a link, deleted on one side), left as the user had them. */
	readonly unmerged?: readonly string[];
	/** Tried files the user edited and hasn't sent to the thread. */
	readonly edits?: readonly string[];
}

/** A thread card's item id. */
export function threadCardId(thread: string): string {
	return `thread-${thread}`;
}

/** Where a compact stands: offered, under way, done (and maybe undone), refused or failed. */
export type CompactState = 'suggested' | 'dismissed' | 'running' | 'done' | 'undone' | 'failed';

/** The compact card and divider (`src/host/chat/chatCompact.ts`). */
export interface CompactItem {
	readonly id: string;
	readonly kind: 'compact';
	readonly state: CompactState;
	/** How full the context was when compacting was suggested, in whole percent. */
	readonly percent?: number;
	/** About how many tokens the session sent with each request before and after. */
	readonly before?: number;
	readonly after?: number;
	/** How many of the latest prompts were kept as they were. */
	readonly kept?: number;
	readonly summary?: string;
	/** The session compacted, which Undo goes back to, and the compacted one. */
	readonly from?: string;
	readonly to?: string;
	/** Why it failed, as a sentence. */
	readonly error?: string;
}

/** What a fork starts with: its parent's whole session, a compacted copy, or the conversation without tool output. */
export type ForkContext = 'whole' | 'compact' | 'conversation';

/** A fork's line in its own chat (`from`), or its card in its parent's (`child`). */
export interface ForkItem {
	readonly id: string;
	readonly kind: 'fork';
	readonly role: 'from' | 'child';
	/** The other agent: the parent, in a fork's chat; the fork, in its parent's. */
	readonly agent: string;
	/** Its title when forked. */
	readonly title: string;
	readonly context: ForkContext;
	/** The fork's own branch; unset when it shares its parent's folder. */
	readonly branch?: string;
	/** The fork was removed since. */
	readonly removed?: boolean;
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
	/**
	 * Whether a reply may start with the agent's reaction to the prompt
	 * (`<react>X</react>`), which is lifted onto the prompt. Off in a
	 * project's chat, which never asks for one.
	 */
	liftReactions = false;
	/** The turn's first reply text, held while it may still be a reaction tag. */
	private reactionHeld: string | undefined;
	/**
	 * Keeps a long tool output whole elsewhere and says what its card shows
	 * first (`ToolOutputStore.put`), so the transcript holds only its first and
	 * last lines; unset, outputs are kept whole.
	 */
	trimOutput: ((itemId: string, part: number, text: string) => TrimmedOutput) | undefined;

	constructor(private readonly now: () => number = Date.now) { }

	get items(): readonly TranscriptItem[] {
		return this._items;
	}

	addPrompt(text: string, attachments: readonly Attachment[] = [], from?: 'coordinator', reactions: readonly ReactionRef[] = []): void {
		this.settleEcho();
		this.startTurn();
		this.push({
			id: this.newId(), kind: 'user', text, at: this.now(), ...(from ? { from } : {}), ...(reactions.length ? { reactions } : {}),
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
	addReplayedPrompt(text: string, reactions: readonly ReactionRef[] = []): void {
		this.settleEcho();
		this.startTurn();
		this.push({ id: this.newId(), kind: 'user', text, ...(reactions.length ? { reactions } : {}) });
	}

	/** Puts the user's reaction on a reply, once per emoji. */
	addReaction(turnEndId: string, emoji: string): void {
		const item = this._items.find(i => i.id === turnEndId);
		if (item?.kind === 'turnEnd' && !item.reactions?.includes(emoji)) {
			this.upsert({ ...item, reactions: [...item.reactions ?? [], emoji] });
		}
	}

	apply(event: ChatEvent): void {
		if (event.kind !== 'text') {
			this.settleEcho();
			// Reply text cut short by a step is shown; before any reply text, the tag may still come after the steps.
			if (this.reactionHeld) {
				this.settleReaction();
			}
		}
		switch (event.kind) {
			case 'text':
				this.appendText(event.role, event.text, event.messageId);
				break;
			case 'toolCall': {
				const item = toToolCallItem(event.call, this.trimOutput);
				const shown = this._items.findLast(i => i.id === item.id);
				const others = shown?.kind === 'toolCall' ? shown.others : undefined;
				// An update of a finished call carries no content: it keeps what it showed.
				const details = !item.details.length && shown?.kind === 'toolCall' ? shown.details : item.details;
				this.upsert({ ...item, details, ...others ? { others } : {} });
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

	/** `others`: agents with unreviewed changes in a file the request edits. */
	addPermission(permission: PendingPermission, others?: readonly OtherAgentChanges[]): void {
		const { toolCall, options } = permission.request;
		this.push({
			id: permission.id,
			kind: 'permission',
			title: toolCall.title ?? toolCall.toolCallId,
			options: options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
			diffPaths: (toolCall.content ?? []).flatMap(c => c.type === 'diff' ? [c.path] : []),
			...permission.confirm ? { confirm: true } : {},
			...permission.prefixes?.length ? { prefixes: permission.prefixes } : {},
			...others?.length ? { others } : {},
		});
	}

	/** Notes on a tool call's row that other agents have unreviewed changes in a file it edited. */
	setOthers(id: string, others: readonly OtherAgentChanges[]): void {
		const item = this._items.findLast(i => i.id === id);
		if (item?.kind === 'toolCall' && others.length) {
			this.upsert({ ...item, others });
		}
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
		this.settleReaction();
		const id = this.newId();
		this.push({ id, kind: 'turnEnd', durationMs: Math.max(0, Math.round(durationMs)), at: this.now(), ...(usage?.length ? { usage } : {}) });
		return id;
	}

	/** Changes what a turnEnd item offers. */
	updateTurnEnd(id: string, patch: Pick<TurnEndItem, 'files' | 'undo' | 'retry' | 'buildPlan' | 'build' | 'firstTokenMs' | 'unfinished'>): void {
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

	/** `actions`: the notice's ways out, such as Retry; the latest notice's go when the next turn starts (`clearNoticeActions`). */
	addNotice(text: string, severity: 'info' | 'error' = 'info', actions: readonly NoticeAction[] = []): void {
		if (actions.length) {
			this.clearNoticeActions();
		}
		this.push({ id: this.newId(), kind: 'notice', text, severity, ...actions.length ? { actions } : {} });
	}

	/** The notice that offers `action` now, if `id` is it. */
	noticeOffering(id: string, action: NoticeAction): Extract<TranscriptItem, { kind: 'notice' }> | undefined {
		const item = this._items.findLast(i => i.id === id);
		return item?.kind === 'notice' && item.actions?.includes(action) ? item : undefined;
	}

	/** Takes the ways out off every notice that offers them, as the next turn starts. */
	clearNoticeActions(): void {
		for (const item of this._items) {
			if (item.kind === 'notice' && item.actions) {
				const { actions: _actions, ...rest } = item;
				this.upsert(rest);
			}
		}
	}

	/** Offers Retry on the latest error, and on no other. */
	offerRetry(): void {
		this.clearRetry();
		for (let i = this._items.length - 1; i >= 0; i--) {
			const item = this._items[i];
			if (item.kind === 'notice' && item.severity === 'error') {
				this.upsert({ ...item, retry: true });
				return;
			}
		}
	}

	/** Takes Retry off every error that offers it. */
	clearRetry(): void {
		for (const item of this._items) {
			if (item.kind === 'notice' && item.retry) {
				const { retry: _retry, ...rest } = item;
				this.upsert(rest);
			}
		}
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

	/** Adds a compact card; returns its id. */
	addCompact(item: Omit<CompactItem, 'id' | 'kind'>): string {
		const id = this.newId();
		this.push({ ...item, id, kind: 'compact' });
		return id;
	}

	/** Changes a compact card: its state, and what the compact did. */
	updateCompact(id: string, patch: Partial<Omit<CompactItem, 'id' | 'kind'>>): void {
		const item = this._items.find(i => i.id === id);
		if (item?.kind === 'compact') {
			this.upsert({ ...item, ...patch });
		}
	}

	/** Adds a fork's line or card; returns its id. */
	addFork(item: Omit<ForkItem, 'id' | 'kind'>): string {
		const id = this.newId();
		this.push({ ...item, id, kind: 'fork' });
		return id;
	}

	/** Marks the cards of fork `agent` as removed. */
	forkRemoved(agent: string): void {
		for (const item of this._items) {
			if (item.kind === 'fork' && item.role === 'child' && item.agent === agent && !item.removed) {
				this.upsert({ ...item, removed: true });
			}
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
		// Nor a failed turn's notice: its prompt went with the window. Long tool outputs are kept whole elsewhere again.
		this._items = items.map(item => {
			if (item.kind === 'permission' && !item.answer) {
				return { ...item, answer: { kind: 'cancelled' as const } };
			}
			if (item.kind === 'notice' && item.actions) {
				const { actions: _actions, ...rest } = item;
				return rest;
			}
			if (item.kind === 'toolCall' && this.trimOutput) {
				const trim = this.trimOutput;
				return { ...item, details: item.details.map((detail, part) => trimDetail(item.id, part, detail, trim)) };
			}
			return item;
		});
		this.nextId = Math.max(this.nextId, ...items.map(i => /^item-(\d+)$/.exec(i.id)).map(m => m ? Number(m[1]) + 1 : 0));
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.reactionHeld = undefined;
		this.onDidResetEmitter.fire();
	}

	/** Takes item `id` and everything after it out of the conversation, for Rewind. */
	cutAt(id: string): void {
		const index = this._items.findIndex(item => item.id === id);
		if (index === -1) {
			return;
		}
		this.settleEcho();
		this.reactionHeld = undefined;
		this._items = this._items.slice(0, index);
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.onDidResetEmitter.fire();
	}

	clear(): void {
		this._items = [];
		this.turnStart = 0;
		this.lastMessageId = undefined;
		this.reactionHeld = undefined;
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
		if (role === 'agent' && this.reactionHeld !== undefined) {
			this.reactionHeld += text;
			const found = leadingReaction(this.reactionHeld);
			if (found === 'pending') {
				return;
			}
			const held = this.reactionHeld;
			this.reactionHeld = undefined;
			if (found !== 'none') {
				this.setAgentReaction(found.emoji);
			}
			const rest = found === 'none' ? held : found.rest;
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

	/** A new prompt's turn: its first reply text may carry the agent's reaction. */
	private startTurn(): void {
		this.settleReaction();
		this.turnStart = this._items.length;
		this.lastMessageId = undefined;
		this.reactionHeld = this.liftReactions ? '' : undefined;
	}

	/** Something other than reply text came, or the turn ended: held text is shown, and no tag is looked for after it. */
	private settleReaction(): void {
		const held = this.reactionHeld;
		this.reactionHeld = undefined;
		if (held) {
			this.appendText('agent', held, undefined);
		}
	}

	/** The agent's reaction, on the prompt that started the turn. */
	private setAgentReaction(emoji: string): void {
		const item = this._items[this.turnStart];
		if (item?.kind === 'user') {
			this.upsert({ ...item, agentReaction: emoji });
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

function toToolCallItem(call: ToolCallModel, trim: ChatTranscript['trimOutput']): Extract<TranscriptItem, { readonly kind: 'toolCall' }> {
	const id = toolCallItemId(call.id);
	return {
		id,
		kind: 'toolCall',
		title: call.title,
		toolKind: call.kind,
		status: call.status,
		locations: call.locations.map(l => l.line ? { path: l.path, line: l.line } : { path: l.path }),
		details: call.content.map((content, part) => trim ? trimDetail(id, part, toToolCallDetail(content), trim) : toToolCallDetail(content)),
	};
}

/** A text output as its card first shows it: whole, or its first and last lines when long (see `ToolOutputStore`). */
function trimDetail(itemId: string, part: number, detail: ToolCallDetail, trim: NonNullable<ChatTranscript['trimOutput']>): ToolCallDetail {
	if (detail.type !== 'text' || detail.hiddenLines) {
		return detail;
	}
	const trimmed = trim(itemId, part, detail.text);
	return trimmed.hiddenLines ? { type: 'text', text: trimmed.head, tail: trimmed.tail, hiddenLines: trimmed.hiddenLines } : detail;
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

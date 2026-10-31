/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A prompt's turn: what goes with the prompt (src/acp/turnContent.ts), the
// wait for the session, the send and how the turn ended, its end line with
// Retry and Undo, and the ways out of a turn Gemini refused: a session whose
// history is over the model's context limit moves to a new one, and a
// request refused after a tool result is asked once to carry on.

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { type AgentClient, WaitAbortedError } from '../../acp/agentClient';
import type { Attachment } from '../../acp/attachments';
import { type ChatTranscript, toolCallItemId } from '../../acp/chatTranscript';
import { diffsOf, dropOldest, turnShape } from '../../acp/chatTurns';
import { readCliConversation } from '../../acp/cliSessions';
import { classifyTurnError, errorMessage, isContextOverflow, isModelTurnRefusal } from '../../acp/errors';
import { CoordinatorTurnFailed } from '../../acp/projectHub';
import { buildPromptContent } from '../../acp/promptContent';
import { type JoinedPrompt, type PromptExtras, steeringNote } from '../../acp/promptQueue';
import { reactionNote, reactionRule, type ReactionRequest } from '../../acp/reactions';
import { type ChatEvent, isModelOutput } from '../../acp/sessionUpdates';
import { TeamCommandCancelled } from '../../acp/teamCommandExpansion';
import { parseTraceFile, summarizeTrace, turnReadout } from '../../acp/traceRecording';
import { assembleTurnContent } from '../../acp/turnContent';
import type { ModelTokens } from '../../acp/turnUsage';
import { isBlockedWebFetch } from '../../acp/webFetchHint';
import type { ToWebview } from '../chatProtocol';
import { agentReactionsOn } from '../chatReactions';
import { stopReasonActions, stopReasonNotice, turnErrorNotice, type TurnErrorNotice } from '../chatStatus';
import { markStartup } from '../startup';
import { currentTraceFile } from '../traceCommand';
import type { ChatCheckpoints } from './chatCheckpoints';
import type { ChatCommands } from './chatCommands';
import type { ChatFileLinks } from './chatFiles';
import type { ChatFollow } from './chatFollow';
import type { ChatControllerOptions, ChatHost } from './chatOptions';
import type { ChatPermissions } from './chatPermissions';
import type { ChatPlan } from './chatPlan';
import type { ChatQueue } from './chatQueue';
import { reactionRef } from './chatReactions';
import type { ChatSessions } from './chatSessions';
import type { SharedPageChip } from './chatSharedPage';
import type { ChatUsage } from './chatUsage';

/** How a prompt's turn ended: `steer` stopped it for messages sent now, `failed` with an error the chat shows. */
export type TurnOutcome = 'done' | 'steer' | 'stopped' | 'failed';

/** When a turn's steps happened, in ms since the epoch. */
export interface TurnTiming {
	readonly started: number;
	ready?: number;
	sent?: number;
	/** The model's first output after the prompt was sent: a thought, a tool call, a plan or reply text. */
	firstToken?: number;
	/** The first reply text, which in an agentic turn often comes after every step. */
	firstText?: number;
}

/** The last prompt, for Retry. */
export interface LastPrompt {
	readonly text: string;
	readonly attachments: readonly Attachment[];
	readonly reactions?: readonly ReactionRequest[];
}

/** Gemini refused a turn's request after a tool result, and again when asked to carry on: the session likely refuses every later request. */
class RefusedAgainError extends Error { }

/** The chat's features a turn runs with. */
export interface TurnFeatures {
	readonly files: ChatFileLinks;
	readonly permissions: ChatPermissions;
	readonly follow: ChatFollow;
	readonly checkpoints: ChatCheckpoints;
	readonly commands: ChatCommands;
	readonly sessions: ChatSessions;
	readonly sharedPage: SharedPageChip;
	readonly usage: ChatUsage;
	readonly plan: ChatPlan;
	readonly queue: ChatQueue;
}

/** What a turn needs of its chat. */
export interface TurnHost {
	isBusy(): boolean;
	setBusy(busy: boolean): void;
	/** A turn runs whose updates stay out of the transcript, such as Compact's summary. */
	isQuiet(): boolean;
	/** The text of a prompt sent. */
	promptSent(text: string): void;
	/** A tool call completed with these edits. */
	editedFiles(diffs: readonly acp.Diff[]): void;
	/** A tool call arrived: the Agents pane hears of a new step. */
	toolCallStep(): void;
	/** The saved chat being read in, while it is. */
	restoring(): Promise<void> | undefined;
	isDisposed(): boolean;
	/** Settles when the chat is no longer busy, or is disposed. */
	untilNotBusy(): Promise<void>;
}

export class ChatTurn {

	/** The running turn's timestamps, for the turn's end line and the trace readout. */
	private timing: TurnTiming | undefined;
	private readonly completedToolCalls = new Set<string>();
	/** A project chat's calls of the project's own tools, which it leaves out. */
	private readonly hiddenToolCalls = new Set<string>();
	/** Web fetch calls already followed by the hint about private hosts. */
	private readonly hintedToolCalls = new Set<string>();
	/** Sessions told about the folder's index already. */
	private readonly hintedSessions = new Set<string>();
	/** Sessions told they may react to the user's prompts already. */
	private readonly reactionRuleSessions = new Set<string>();
	/** A prompt's turn is running; other work that keeps the chat busy (Compact, Undo, a new session) is not one. */
	private turnRunning = false;

	/** The last prompt, for Retry. */
	private _lastPrompt: LastPrompt | undefined;
	/** The turnEnd item that offers Retry. */
	private _retryItemId: string | undefined;
	/** Context sent ahead of the next prompt without showing in the chat, such as a project's memory for a thread. */
	private pendingContext: string | undefined;
	/** The agent's tried files the user edited and hasn't sent it. */
	private _triedEdits: readonly string[] = [];

	/** Aborts the running turn's wait for its session (`ensureReady`), so Stop works before the prompt is sent. */
	private turnWait: AbortController | undefined;
	private _includingEdits = false;
	/** The latest failed turn's notice, with the ways out it offers; cleared when the next turn starts. */
	private _lastTurnError: TurnErrorNotice | undefined;

	constructor(
		private readonly service: Pick<ChatHost, 'client' | 'ensureReady' | 'open' | 'writeLog'>,
		private readonly transcript: ChatTranscript,
		private readonly options: Pick<ChatControllerOptions, 'project' | 'indexHint' | 'designSystemNote' | 'reviewPlan' | 'errorsAfterTurn' | 'sendTriedEdits' | 'teamTools' | 'turnNote'>,
		private readonly features: TurnFeatures,
		private readonly host: TurnHost,
		private readonly post: (message: ToWebview) => void,
	) { }

	/** A prompt's turn is running; other work that keeps the chat busy (Compact, Undo, a new session) is not one. */
	get running(): boolean {
		return this.turnRunning;
	}

	/** The running turn still waits for its session: nothing was sent yet. */
	get waiting(): boolean {
		return !!this.turnWait;
	}

	/** The last prompt, for Retry. */
	get lastPrompt(): LastPrompt | undefined {
		return this._lastPrompt;
	}

	/** The turnEnd item that offers Retry. */
	get retryItemId(): string | undefined {
		return this._retryItemId;
	}

	/** Forgets the last prompt and the turn end that offered Retry, as the conversation is cleared or rewound. */
	forgetLastPrompt(): void {
		this._lastPrompt = undefined;
		this._retryItemId = undefined;
	}

	/**
	 * The latest failed turn's notice and its ways out (Retry, Switch Model,
	 * Sign In, Show Log), until the next turn starts; for the notice's buttons.
	 */
	get lastTurnError(): TurnErrorNotice | undefined {
		return this._lastTurnError;
	}

	/** The chat is busy copying the user's edits for its own turn: Send My Edits' busy check lets that through. */
	get includingEdits(): boolean {
		return this._includingEdits;
	}

	/** The agent's tried files the user edited and hasn't sent it. */
	get triedEdits(): readonly string[] {
		return this._triedEdits;
	}

	/** The agent's tried files the user edited and hasn't sent it (agentTries.ts): the message box offers to include them. */
	setTriedEdits(files: readonly string[]): void {
		this._triedEdits = files;
		this.post({ type: 'triedEdits', files });
	}

	/** Sends `text` to the agent ahead of the next prompt, without showing it in the chat. */
	addContext(text: string): void {
		this.pendingContext = this.pendingContext ? `${this.pendingContext}\n\n${text}` : text;
	}

	/** Ends the running turn's wait for its session, so Stop works before the prompt is sent. */
	abortWait(): void {
		this.turnWait?.abort();
	}

	/** Forgets the tool calls whose edits were recorded, as the conversation is cleared. */
	forgetCompletedToolCalls(): void {
		this.completedToolCalls.clear();
	}

	/** An event from the agent: a turn's updates go into the transcript, and not a quiet turn's. */
	onEvent(event: ChatEvent): void {
		const { checkpoints, files, follow, permissions, plan, queue } = this.features;
		const client = this.service.client;
		// Only a turn's updates belong in the transcript, and not a quiet turn's.
		if (this.host.isBusy() && !this.host.isQuiet()) {
			if (event.kind === 'toolCall' && this.options.project && (this.hiddenToolCalls.has(event.call.id) || this.options.project.hidesToolCall(event.call.title ?? ''))) {
				// The project's own tools show as posts and thread cards instead.
				this.hiddenToolCalls.add(event.call.id);
				dropOldest(this.hiddenToolCalls);
				return;
			}
			let edited: readonly acp.Diff[] = [];
			if (event.kind === 'toolCall') {
				const diffs = diffsOf(event.call.content);
				files.remember(toolCallItemId(event.call.id), diffs);
				if (event.call.status === 'completed' && diffs.length && !this.completedToolCalls.has(event.call.id)) {
					this.completedToolCalls.add(event.call.id);
					dropOldest(this.completedToolCalls);
					checkpoints.record(diffs);
					this.host.editedFiles(diffs);
					edited = diffs;
					// The plan a Plan mode turn writes, for its Review Plan.
					plan.noteEdits(diffs);
				}
			}
			if (this.timing?.sent !== undefined) {
				if (this.timing.firstToken === undefined && isModelOutput(event)) {
					this.timing.firstToken = Date.now();
				}
				if (this.timing.firstText === undefined && event.kind === 'text' && event.role === 'agent') {
					this.timing.firstText = Date.now();
					markStartup('first text');
				}
			}
			this.transcript.apply(event);
			// The model answering after a tool means the tool's result reached it: a message sent now can stop the turn.
			if (queue.hasSteer && isModelOutput(event)) {
				queue.trySteer();
			}
			if (event.kind === 'toolCall' && edited.length && editsWithoutCards(client.settings.mode?.currentId)) {
				// No card asked about this edit: its row says when another agent is changing the file too.
				this.transcript.setOthers(toolCallItemId(event.call.id), permissions.othersChanging(edited.map(diff => diff.path)));
			}
			if (event.kind === 'toolCall' && !this.hintedToolCalls.has(event.call.id) && isBlockedWebFetch(event.call)) {
				this.hintedToolCalls.add(event.call.id);
				dropOldest(this.hintedToolCalls);
				this.transcript.addNotice(vscode.l10n.t("Gemini's web fetch can't open pages on your machine or private network, such as a QA or intranet site. Open the page in the GeminiCode browser and use Let Gemini Use This Page, or ask Gemini to open it with its browser."));
			}
			if (event.kind === 'toolCall') {
				follow.onToolCall(event.call);
				queue.trySteer();
			}
			if (event.kind === 'toolCall') {
				this.host.toolCallStep();
			}
		}
	}

	/**
	 * Sends `text` as a turn with no message of its own in the chat, such as a
	 * project's wake for its coordinator; resolves when the turn ends, and
	 * rejects with {@link CoordinatorTurnFailed} when it failed.
	 */
	async sendUnseen(text: string): Promise<void> {
		const restoring = this.host.restoring();
		if (restoring) {
			await restoring;
		}
		// Other work that keeps the chat busy, such as Compact, ends first.
		while (this.host.isBusy() && !this.turnRunning && !this.host.isDisposed()) {
			await this.host.untilNotBusy();
		}
		if (this.host.isDisposed()) {
			throw new Error('The chat closed.');
		}
		if (this.host.isBusy()) {
			throw new Error('A turn is already running.');
		}
		this.features.sessions.stopReplay();
		this.service.open?.();
		if (await this.runTurn(text, [], false) === 'failed') {
			throw new CoordinatorTurnFailed();
		}
	}

	/** Starts a prompt's turn, the chat being idle: shows it, and sends it with the notes of any reactions it carries. */
	async startPrompt(text: string, attachments: readonly Attachment[], from?: 'coordinator', reactions: readonly ReactionRequest[] = [], extras: PromptExtras = {}): Promise<void> {
		this.features.sessions.stopReplay();
		this.service.open?.();
		if (this._retryItemId) {
			this.transcript.updateTurnEnd(this._retryItemId, { retry: undefined, buildPlan: undefined, build: undefined });
			this._retryItemId = undefined;
		}
		this.transcript.addPrompt(text, attachments, from, reactions.map(reactionRef));
		if (text.trim()) {
			this.host.promptSent(text);
		}
		this._lastPrompt = { text, attachments, ...(reactions.length ? { reactions } : {}) };
		// A ticket, merge request, page or design named here turns the team tools on for the agent before the prompt goes.
		this.options.teamTools?.notePrompt(text, attachments);
		await this.runTurn(text, attachments, true, false, reactions, extras);
	}

	/** Starts the turn of messages taken out of the queue: `steer` after a turn stopped for them. */
	async runNext(next: JoinedPrompt, steer: boolean): Promise<void> {
		this.transcript.addPrompt(next.text, next.attachments, next.from, (next.reactions ?? []).map(reactionRef));
		if (next.text.trim()) {
			this.host.promptSent(next.text);
		}
		this._lastPrompt = next;
		await this.runTurn(next.text, next.attachments, true, steer, next.reactions, next);
	}

	/**
	 * "Include your edits": the user's edits to tried files go to the agent's
	 * folder as its turn starts, the chat already busy so no other message
	 * starts one meanwhile; a failure shows in the chat.
	 */
	private async includeTriedEdits(): Promise<void> {
		if (this._triedEdits.length) {
			this._includingEdits = true;
			try {
				await this.options.sendTriedEdits?.().catch(err => this.transcript.addNotice(vscode.l10n.t("Your edits weren't sent to the agent: {0}", errorMessage(err)), 'error'));
			} finally {
				this._includingEdits = false;
			}
		}
	}

	/** `steer` carries on after a turn stopped for messages sent now: the agent is told why it stopped. */
	async runTurn(text: string, attachments: readonly Attachment[], expand: boolean, steer = false, reactions: readonly ReactionRequest[] = [], extras: PromptExtras = {}): Promise<TurnOutcome> {
		this.turnRunning = true;
		try {
			return await this.runTurnNow(text, attachments, expand, steer, reactions, extras);
		} finally {
			// Cleared however the turn ends, so a throw never leaves the chat unable to start the next one.
			this.turnRunning = false;
		}
	}

	private async runTurnNow(text: string, attachments: readonly Attachment[], expand: boolean, steer: boolean, reactions: readonly ReactionRequest[], extras: PromptExtras): Promise<TurnOutcome> {
		const { checkpoints, queue, sessions } = this.features;
		checkpoints.beginTurn();
		this.host.setBusy(true);
		const started = Date.now();
		let ended = false;
		let overflowed = false;
		let failed = false;
		/** Where the turn's output starts in the transcript, once its prompt went; and whether the agent took it. */
		let promptAt: number | undefined;
		let delivered = false;
		/** How the turn came to an end, for the messages waiting on it. */
		let outcome: 'done' | 'steer' | 'stopped' = 'stopped';
		this.timing = { started };
		this._lastTurnError = undefined;
		// The last failure's Retry and Continue have done their work, or were passed over.
		this.transcript.clearNoticeActions();
		const wait = this.turnWait = new AbortController();
		try {
			if (extras.includeEdits) {
				await this.includeTriedEdits();
			}
			try {
				await this.service.ensureReady(wait.signal);
			} finally {
				if (this.turnWait === wait) {
					this.turnWait = undefined;
				}
			}
			this.timing.ready = Date.now();
			// Built after the agent is ready, so it reflects what this agent accepts.
			const own = buildPromptContent(expand ? await this.features.commands.expand(text) : text, attachments, this.service.client.promptCapabilities);
			// A reaction with nothing typed stops the turn for itself: its note says so, in place of the steering note.
			const reactionOnly = !!reactions.length && !text.trim();
			const notes = reactions.map(reaction => reactionNote(reaction, steer && reactionOnly));
			if (!own.length && !notes.length) {
				throw new Error(vscode.l10n.t("The agent cannot take images, so there was nothing to send."));
			}
			// Told once per session: without it the model reaches for grep_search first (FINDINGS.md, workspace index).
			const state = this.service.client.state;
			const session = state.kind === 'ready' ? state.savedSessionId : undefined;
			const hint = session && !this.hintedSessions.has(session) ? this.options.indexHint?.() : undefined;
			if (session && hint) {
				this.hintedSessions.add(session);
			}
			const design = attachments.some(attachment => attachment.kind === 'document' && attachment.tool === 'figma') ? await this.options.designSystemNote?.().catch(() => undefined) : undefined;
			const page = await this.features.sharedPage.refresh();
			if (page && !this.options.project) {
				this.transcript.addPromptPage(page.title, page.url);
			}
			const carried = sessions.carriedConversation;
			const context = this.pendingContext;
			const note = this.options.turnNote?.();
			const reactionRuleDue = !!session && !this.options.project && agentReactionsOn() && !this.reactionRuleSessions.has(session);
			if (reactionRuleDue) {
				this.reactionRuleSessions.add(session!);
			}
			// In the order the agent should read them (turnContent.ts).
			const content = assembleTurnContent({
				content: own,
				steering: steer && !reactionOnly ? steeringNote() : undefined,
				notes,
				reactionRule: reactionRuleDue ? reactionRule() : undefined,
				context: note ? (context ? `${context}\n\n${note}` : note) : context,
				carried,
				undoNote: checkpoints.undoNote,
				hint,
				design,
				page: page?.note,
			});
			this.timing.sent = Date.now();
			markStartup('first prompt sent');
			promptAt = this.transcript.items.length;
			const { stopReason, usage } = await this.promptRecovering(content);
			delivered = true;
			checkpoints.noteDelivered();
			if (context === this.pendingContext) {
				this.pendingContext = undefined;
			}
			sessions.delivered(carried);
			// Stopped to steer: no "Stopped." notice, since the agent carries on with the messages at once.
			const steered = stopReason === 'cancelled' && queue.stopping && queue.hasSteer;
			const notice = steered ? undefined : stopReasonNotice(stopReason);
			if (notice) {
				this.transcript.addNotice(notice, stopReason === 'refusal' ? 'error' : 'info', this.options.project ? [] : stopReasonActions(stopReason));
			}
			this.endTurn(Date.now() - started, usage, !steered && stopReason !== 'end_turn', steered);
			ended = true;
			outcome = steered ? 'steer' : stopReason === 'end_turn' ? 'done' : 'stopped';
		} catch (err) {
			if (err instanceof WaitAbortedError) {
				// Stopped while the session was still opening: nothing was sent.
				this.transcript.addNotice(stopReasonNotice('cancelled') ?? '', 'info');
			} else if (isContextOverflow(errorMessage(err))) {
				overflowed = true;
			} else if (err instanceof TeamCommandCancelled) {
				this.transcript.addNotice(errorMessage(err), 'info');
			} else if (err instanceof RefusedAgainError) {
				this.service.writeLog?.(`The turn failed: ${errorMessage(err)}`);
				this.transcript.addNotice(errorMessage(err), 'error', this.options.project ? [] : ['newSession', 'switchModel']);
				failed = true;
			} else {
				const notice = this._lastTurnError = this.turnError(err);
				this.service.writeLog?.(`The turn failed (${notice.error.kind}): ${errorMessage(err)}`);
				// A project's chat retries its wake its own way (`offerRetry`).
				this.transcript.addNotice(notice.text, 'error', this.options.project ? [] : notice.actions);
				failed = true;
			}
		} finally {
			queue.setSteerWaiting(false);
			if (!ended && checkpoints.turnChangedFiles) {
				// The turn failed after changing files; they can still be undone.
				this.endTurn(Date.now() - started, undefined, true);
			}
			queue.endSteerStop();
			// Stopped to steer, the chat stays busy into the next turn.
			if (outcome !== 'steer') {
				this.host.setBusy(false);
			}
			void this.features.usage.postContext();
		}
		// Sent once the agent took the prompt: it answered, or the turn got as far as the model's output before failing.
		// A turn that failed before that, or overflowed (its prompt goes back in the box), never went.
		extras.settle?.(!overflowed && (delivered || (promptAt !== undefined && this.transcript.items.slice(promptAt).some(item => item.kind === 'agent' || item.kind === 'thought' || item.kind === 'toolCall'))));
		if (overflowed) {
			queue.holdSteers();
			this.turnRunning = false;
			await this.continueAfterOverflow(expand ? text : undefined);
			return 'failed';
		}
		// The next queued message may start its turn from here, so the flag is cleared before it is sent.
		this.turnRunning = false;
		await queue.sendPending(outcome);
		return failed ? 'failed' : outcome;
	}

	/**
	 * After Gemini refused a turn because the session's history is over the
	 * model's context limit, which no later request in that session can get
	 * past: moves the chat to a new session that is given the conversation so
	 * far (prompts and replies, without the tool output that filled it), and
	 * puts `prompt` back in the box. Nothing is sent again by itself, since the
	 * turn may have changed files before it failed.
	 */
	async continueAfterOverflow(prompt: string | undefined, reason: 'overflow' | 'refused' = 'overflow'): Promise<void> {
		const { sessions } = this.features;
		const sessionId = sessions.current();
		const conversation = sessionId ? await readCliConversation(this.service.client.cwd, sessionId).catch(() => undefined) : undefined;
		this.host.setBusy(true);
		try {
			// Moving on on purpose: not the agent losing the session.
			sessions.moveTo(undefined);
			await this.service.client.newSession();
			this.options.project?.sessionReplaced();
		} catch (err) {
			this.transcript.addNotice(reason === 'refused'
				? vscode.l10n.t("A new session could not start: {0} Start a new chat to carry on.", this.turnError(err).text)
				: vscode.l10n.t("Gemini's context for this chat is full, and a new session could not start: {0} Start a new chat to carry on.", this.turnError(err).text), 'error');
			return;
		} finally {
			this.host.setBusy(false);
		}
		const carried = sessions.carry('this chat', conversation);
		this.transcript.addNotice(reason === 'refused'
			? carried
				? vscode.l10n.t("The chat continues in a new session that is given the conversation so far, without the tool outputs. Send your message again to carry on.")
				: vscode.l10n.t("The chat continues in a new session that starts without the earlier conversation. Send your message again to carry on.")
			: carried
				? vscode.l10n.t("Gemini's context for this chat filled up, most likely with a large tool output, so Gemini could not answer. The chat continues in a new session that is given the conversation so far, without the tool outputs. Send your message again to carry on.")
				: vscode.l10n.t("Gemini's context for this chat filled up, most likely with a large tool output, so Gemini could not answer. The chat continues in a new session that starts without the earlier conversation. Send your message again to carry on."), reason === 'refused' ? 'info' : 'error');
		if (prompt) {
			this.post({ type: 'draft', text: prompt });
		}
	}

	/**
	 * Sends a prompt; when Gemini refuses the request after a tool result with
	 * "Requests ending with a model turn are not supported", logs the shape of
	 * the turn (no contents) and asks the agent once to carry on from the last
	 * tool result, as typing "continue" does. When that is refused too, says so
	 * in plain words rather than with the API's JSON.
	 */
	private async promptRecovering(content: acp.ContentBlock[]): ReturnType<AgentClient['promptTurn']> {
		const turnStart = this.transcript.items.length;
		try {
			return await this.service.client.promptTurn(content);
		} catch (err) {
			if (!isModelTurnRefusal(errorMessage(err))) {
				throw err;
			}
			this.service.writeLog?.(`Gemini refused the turn's request (${errorMessage(err)}). Mode ${this.service.client.settings.mode?.currentId ?? '?'}, model ${this.service.client.settings.model?.currentId ?? '?'}. Turn so far: ${turnShape(this.transcript.items.slice(turnStart))}`);
		}
		try {
			const result = await this.service.client.promptTurn([{ type: 'text', text: 'Continue from the last tool result.' }]);
			this.transcript.addNotice(vscode.l10n.t("Recovered after an API error: the agent carried on from the last tool result."));
			return result;
		} catch (err) {
			this.service.writeLog?.(`Gemini refused the retry too (${errorMessage(err)}).`);
			if (!isModelTurnRefusal(errorMessage(err))) {
				throw err;
			}
			throw new RefusedAgainError(vscode.l10n.t("Gemini refused this session's request twice after a tool result, a known Gemini CLI problem after images such as screenshots, and it is likely to refuse later messages in this session too. Your files are as the agent left them. Continue in a new session, which is given the conversation so far without tool outputs, or switch the model and retry."));
		}
	}

	/** Adds the turn's end, offering Retry and, when it changed files, Undo. */
	/** `steered`: stopped for a message sent now, which carries on at once, so it offers no Retry. */
	private endTurn(durationMs: number, usage?: readonly ModelTokens[], unfinished = false, steered = false): void {
		const { checkpoints, plan } = this.features;
		const id = this.transcript.addTurnEnd(durationMs, usage);
		const { files, undoable } = checkpoints.endTurn(id);
		if (files && !unfinished && !this.options.project) {
			void this.noteErrors();
		}
		const build = plan.build(usage);
		const turnPlanFile = plan.takeTurnPlanFile();
		const planFile = build && this.options.reviewPlan ? turnPlanFile : undefined;
		this.transcript.updateTurnEnd(id, { retry: !this.options.project && !steered, ...(files ? { files } : {}), ...(undoable ? { undo: 'available' } : {}), ...(build ? { buildPlan: true, build } : {}), ...(unfinished ? { unfinished } : {}), ...(steered ? { steered } : {}), ...(planFile ? { planFile } : {}) });
		this._retryItemId = id;
		const timing = this.timing;
		this.timing = undefined;
		if (timing?.sent && timing.firstToken) {
			this.transcript.updateTurnEnd(id, { firstTokenMs: timing.firstToken - timing.sent });
		}
		const file = currentTraceFile();
		if (timing && file) {
			void this.addTraceReadout(timing, durationMs, file);
		}
	}

	/** While a trace is recording: the turn's readout from the CLI's file, once it has flushed, under the turn's end. */
	private async addTraceReadout(timing: TurnTiming, durationMs: number, file: string): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 1500));
		let text = '';
		try {
			text = await fs.readFile(file, 'utf8');
		} catch {
			return;
		}
		const turns = summarizeTrace(parseTraceFile(text)).turns;
		const turn = turns[turns.length - 1];
		this.transcript.addTrace(turnReadout(turn, {
			totalMs: durationMs,
			...timing.ready ? { sessionMs: timing.ready - timing.started } : {},
			...timing.sent && timing.ready ? { sendMs: timing.sent - timing.ready } : {},
			...timing.sent && timing.firstToken ? { firstTokenMs: timing.firstToken - timing.sent } : {},
		}), file);
	}

	/** After a turn that changed files: a notice when the language servers report errors in them, offering Fix. */
	private async noteErrors(): Promise<void> {
		const text = await this.options.errorsAfterTurn?.().catch(() => undefined);
		if (text && !this.host.isBusy()) {
			this.transcript.addNotice(text, 'info', ['fixErrors']);
		}
	}

	/** The plain-words notice for a failed turn or session, from the error it failed with. */
	turnError(err: unknown): TurnErrorNotice {
		return turnErrorNotice(classifyTurnError(err, { model: this.service.client.settings.model?.currentId }));
	}
}

/** Whether the CLI applies edits in mode `mode` without a card: Auto Edit and YOLO. */
function editsWithoutCards(mode: string | undefined): boolean {
	return mode === 'autoEdit' || mode === 'yolo';
}

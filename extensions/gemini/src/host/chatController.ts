/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { onDidChangeFoldWork } from './foldWork';
import { onDidChangeSpellCheck } from './spellCheck';
import { currentTraceFile } from './traceCommand';
import { parseTraceFile, summarizeTrace, turnReadout } from '../acp/traceRecording';
import type { Attachment } from '../acp/attachments';
import { isValidAttachment } from '../acp/attachmentValidation';
import { chatToMarkdown } from '../acp/chatMarkdown';
import { ChatTranscript, ForkContext, ThreadCard, toolCallItemId, TranscriptItem } from '../acp/chatTranscript';
import { buildModeAfterPlan, diffsOf, dropOldest, lastPromptAt, runningStep, turnShape, wasCutOff } from '../acp/chatTurns';
import type { StoredCheckpoints } from '../acp/checkpoints';
import { buildPromptContent } from '../acp/promptContent';
import { atSafePoint, PromptQueue, steeringNote } from '../acp/promptQueue';
import { meaningOf, olderReplyExcerpt, reactionNote, reactionRule, routeReaction, type ReactionRef, type ReactionRequest } from '../acp/reactions';
import { CoordinatorTurnFailed } from '../acp/projectHub';
import { TeamCommandCancelled } from '../acp/teamCommandExpansion';
import { ConversationEntry, readCliConversation } from '../acp/cliSessions';
import { isModelOutput } from '../acp/sessionUpdates';
import { TextDeltas } from '../acp/textDeltas';
import type { ModelTokens } from '../acp/turnUsage';
import { UpdateBatcher } from '../acp/updateBatcher';
import { isBlockedWebFetch } from '../acp/webFetchHint';
import type { AgentClient } from '../acp/agentClient';
import { errorMessage, isContextOverflow, isModelTurnRefusal } from '../acp/errors';
import { recordPilot } from '../acp/pilotLog';
import { chatProtocolVersion, FromWebview, ProjectPanel, ProjectRepoView, ProjectSettingsView, statusCommands, ToWebview } from './chatProtocol';
import { stopReasonNotice, toViewStatus } from './chatStatus';
import type { DiffPreview } from './diffPreview';
import { agentReactionsOn, onDidChangeReactions, reactionMeanings, reactionsOn, recentReactions, rememberReaction } from './chatReactions';
import { preferredComposerHeight, rememberComposerHeight } from './modelPreference';
import { onDidChangeThemeTokens, themeTokenColors } from './themeTokens';
import { ChatAttachments } from './chat/chatAttachments';
import { ChatCheckpoints } from './chat/chatCheckpoints';
import { ChatCommands } from './chat/chatCommands';
import { ChatCompact, compactCommand } from './chat/chatCompact';
import { ChatFork, forkCommand } from './chat/chatFork';
import { ChatEnhance } from './chat/chatEnhance';
import { ChatFileLinks } from './chat/chatFiles';
import { ChatFollow } from './chat/chatFollow';
import { ChatGitControls } from './chat/chatGit';
import { chatHtml } from './chat/chatHtml';
import type { ChatControllerOptions, ChatHost, FileSearch } from './chat/chatOptions';
import { ChatPermissions } from './chat/chatPermissions';
import { ChatProjectView } from './chat/chatProject';
import { ChatRun } from './chat/chatRun';
import { ChatSessions, resumeCommand } from './chat/chatSessions';
import { ChatSettings } from './chat/chatSettings';
import { SharedPageChip } from './chat/chatSharedPage';
import { ChatUsage } from './chat/chatUsage';

export type { ChatControllerOptions, ChatEnhancer, ChatGit, ChatHost, ChatProject, ChatSharedPage, ChatTerminal, ChatWorkspace, FileSearch } from './chat/chatOptions';

/** How a prompt's turn ended: `steer` stopped it for messages sent now, `failed` with an error the chat shows. */
type TurnOutcome = 'done' | 'steer' | 'stopped' | 'failed';

/** How long after the view loads a session waiting for it to show opens anyway. */
const openFallbackMs = 2_000;

/** What the Agents pane shows about a chat. */
export interface ChatActivity {
	readonly busy: boolean;
	readonly needsPermission: boolean;
	/** What the agent asks permission for, or the step it is on: a tool call's title. */
	readonly step?: string;
	/** When the running turn started, in ms since the epoch. */
	readonly startedAt?: number;
}

/**
 * One chat: sends prompts, streams agent messages and thoughts, shows
 * tool-call cards and stops a turn, in whichever webview it is attached to.
 * The transcript lives here, so it survives the webview being hidden, moved
 * or closed. Each of the chat's features keeps its own webview messages and
 * state in `./chat/`; this class routes the view's messages to them.
 */
export class ChatController implements vscode.Disposable {

	private readonly transcript = new ChatTranscript();
	/** Streams item changes to the webview at most about 30 times a second. */
	private readonly textDeltas = new TextDeltas();
	private readonly items = new UpdateBatcher<TranscriptItem>(items => this.post({ type: 'items', items: this.textDeltas.toUpdates(items) }));
	private readonly disposables: vscode.Disposable[] = [];
	private webview: vscode.Webview | undefined;
	private webviewListener: vscode.Disposable | undefined;
	private busy = false;
	/** While a turn runs whose updates stay out of the transcript, such as Compact's summary. */
	private quiet = false;
	/** When the running turn started, for the Agents side bar's clock. */
	private turnStartedAt: number | undefined;
	/** The running turn's timestamps, for the turn's end line and the trace readout. */
	private timing: TurnTiming | undefined;
	/** The step last reported, so tool call updates report only a new one. */
	private lastStep: string | undefined;
	/** Sessions told about the folder's index already. */
	private readonly hintedSessions = new Set<string>();
	/** Sessions told they may react to the user's prompts already. */
	private readonly reactionRuleSessions = new Set<string>();

	/** Messages sent while the agent works: queued for after the turn, or steering it at its next safe point. */
	private readonly queue = new PromptQueue();
	/** The turn is being stopped to send the messages that steer it. */
	private steerStopping = false;
	/** A prompt's turn is running; other work that keeps the chat busy (Compact, Undo, a new session) is not one. */
	private turnRunning = false;

	/** The last prompt, for Retry. */
	private lastPrompt: { readonly text: string; readonly attachments: readonly Attachment[]; readonly reactions?: readonly ReactionRequest[] } | undefined;
	/** The turnEnd item that offers Retry. */
	private retryItemId: string | undefined;
	/** Context sent ahead of the next prompt without showing in the chat, such as a project's memory for a thread. */
	private pendingContext: string | undefined;
	/** The saved chat being read in, while it is: prompts wait for it, so neither replaces the other. */
	private restoring: Promise<void> | undefined;
	/** Whether the view's script has said it is ready since the view was attached. */
	private viewReady = false;
	/** Opens a session waiting for the chat to show, if the view does not say it is shown. */
	private openTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly onDidChangeActivityEmitter = new vscode.EventEmitter<ChatActivity>();
	readonly onDidChangeActivity = this.onDidChangeActivityEmitter.event;

	private readonly onDidEditFilesEmitter = new vscode.EventEmitter<readonly acp.Diff[]>();
	/** The edits of each tool call that completed, once per tool call. */
	readonly onDidEditFiles = this.onDidEditFilesEmitter.event;
	private readonly completedToolCalls = new Set<string>();
	/** A project chat's calls of the project's own tools, which it leaves out. */
	private readonly hiddenToolCalls = new Set<string>();
	/** Web fetch calls already followed by the hint about private hosts. */
	private readonly hintedToolCalls = new Set<string>();

	private readonly onDidRestoreSessionEmitter = new vscode.EventEmitter<string>();
	/** A saved session was reopened here; fires with its title. */
	readonly onDidRestoreSession = this.onDidRestoreSessionEmitter.event;

	private readonly onDidSendPromptEmitter = new vscode.EventEmitter<string>();
	/** The text of each prompt sent. */
	readonly onDidSendPrompt = this.onDidSendPromptEmitter.event;

	// The chat's features, each with its own webview messages and state.
	private readonly files: ChatFileLinks;
	private readonly permissions: ChatPermissions;
	private readonly follow: ChatFollow;
	private readonly git: ChatGitControls;
	private readonly usage: ChatUsage;
	private readonly attachments: ChatAttachments;
	private readonly sharedPage: SharedPageChip;
	private readonly settings: ChatSettings;
	private readonly enhance: ChatEnhance;
	private readonly commands: ChatCommands;
	private readonly sessions: ChatSessions;
	private readonly checkpoints: ChatCheckpoints;
	private readonly compacting: ChatCompact;
	private readonly forks: ChatFork;
	private readonly project: ChatProjectView;
	private readonly runs: ChatRun;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly service: ChatHost,
		diffPreview: DiffPreview,
		private readonly fileIndex: FileSearch,
		private readonly options: ChatControllerOptions,
	) {
		const post = (message: ToWebview) => this.post(message);
		const isAttached = () => !!this.webview;
		const isViewReady = () => this.viewReady;
		const isBusy = () => this.busy;
		const setBusy = (busy: boolean) => this.setBusy(busy);
		const client = service.client;
		// A project's chat never asks its coordinator to react.
		this.transcript.liftReactions = !options.project;
		this.files = new ChatFileLinks(diffPreview, () => options.git?.folder() ?? client.cwd, options);
		this.permissions = new ChatPermissions(service.permissions, this.transcript, this.files, options);
		this.follow = new ChatFollow(client.cwd, options, post);
		this.git = new ChatGitControls(options, isBusy, isAttached, post);
		this.usage = new ChatUsage(client, options, () => this.transcript.items.length > 0, isAttached, post, (used, limit) => this.compacting.contextChanged(used, limit));
		this.attachments = new ChatAttachments(fileIndex, options, isAttached, isViewReady, post);
		this.sharedPage = new SharedPageChip(options, post);
		this.settings = new ChatSettings(service, this.transcript, options, post);
		this.enhance = new ChatEnhance(client, options, () => this.transcript.items, post);
		this.commands = new ChatCommands(client, this.transcript, [...options.savedSessions ? [resumeCommand()] : [], compactCommand(), ...options.fork ? [forkCommand()] : []], isAttached, post);
		this.sessions = new ChatSessions(service, this.transcript, options, {
			isBusy,
			setBusy,
			clearConversation: () => this.clearConversation(),
			restored: title => this.onDidRestoreSessionEmitter.fire(title),
		}, isAttached, post);
		this.checkpoints = new ChatCheckpoints(service, this.transcript, this.sessions, options, {
			isBusy,
			setBusy,
			restoredFiles: diffs => this.onDidEditFilesEmitter.fire(diffs),
			rewound: text => {
				this.lastPrompt = undefined;
				this.retryItemId = undefined;
				this.post({ type: 'draft', text });
			},
		});
		this.compacting = new ChatCompact(service, this.transcript, this.sessions, options, {
			isBusy,
			quietly: work => this.quietly(work),
			refreshContext: () => void this.usage.postContext(),
			// A coordinator on another session needs its role brief again.
			movedSession: () => options.project?.sessionReplaced(),
		});
		this.forks = new ChatFork(service, this.transcript, this.sessions, this.compacting, options, {
			isBusy,
			title: () => options.title?.() ?? '',
		}, post);
		this.project = new ChatProjectView(options, isViewReady, post);
		this.runs = new ChatRun(options, isAttached, post, attachments => void this.addAttachments(attachments));
		this.disposables.push(
			onDidChangeSpellCheck(on => this.post({ type: 'spellCheck', on })),
			onDidChangeFoldWork(on => this.post({ type: 'foldWork', on })),
			onDidChangeReactions(() => this.postReactions()),
			this.onDidChangeActivityEmitter,
			this.onDidEditFilesEmitter,
			this.onDidSendPromptEmitter,
			this.onDidRestoreSessionEmitter,
			this.follow,
			this.git,
			this.attachments,
			this.settings,
			this.enhance,
			this.commands,
			this.sessions,
			this.runs,
			service.permissions.onDidChange(event => {
				if (event.kind === 'requested' && this.timing) {
					this.timing.permissions++;
				}
				this.permissions.apply(event);
				this.fireActivity();
				this.trySteer();
			}),
			this.transcript,
			this.transcript.onDidChangeItem(item => this.items.push(item)),
			{ dispose: () => this.items.dispose() },
			this.transcript.onDidReset(() => this.postReset()),
			client.onDidAllowInYolo(params => service.writeLog?.(`Allowed "${params.toolCall.title ?? params.toolCall.toolCallId}" at once: the chat is in YOLO mode`)),
			client.onDidReceiveEvent(event => {
				// Only a turn's updates belong in the transcript, and not a quiet turn's.
				if (this.busy && !this.quiet) {
					if (event.kind === 'toolCall' && this.options.project && (this.hiddenToolCalls.has(event.call.id) || this.options.project.hidesToolCall(event.call.title ?? ''))) {
						// The project's own tools show as posts and thread cards instead.
						this.hiddenToolCalls.add(event.call.id);
						dropOldest(this.hiddenToolCalls);
						return;
					}
					if (event.kind === 'toolCall') {
						const diffs = diffsOf(event.call.content);
						this.files.remember(toolCallItemId(event.call.id), diffs);
						if (event.call.status === 'completed' && diffs.length && !this.completedToolCalls.has(event.call.id)) {
							this.completedToolCalls.add(event.call.id);
							dropOldest(this.completedToolCalls);
							this.checkpoints.record(diffs);
							this.onDidEditFilesEmitter.fire(diffs);
						}
					}
					if (this.timing?.sent !== undefined) {
						if (this.timing.firstToken === undefined && isModelOutput(event)) {
							this.timing.firstToken = Date.now();
						}
						if (this.timing.firstText === undefined && event.kind === 'text' && event.role === 'agent') {
							this.timing.firstText = Date.now();
						}
					}
					this.transcript.apply(event);
					if (event.kind === 'toolCall' && !this.hintedToolCalls.has(event.call.id) && isBlockedWebFetch(event.call)) {
						this.hintedToolCalls.add(event.call.id);
						dropOldest(this.hintedToolCalls);
						this.transcript.addNotice(vscode.l10n.t("Gemini's web fetch can't open pages on your machine or private network, such as a QA or intranet site. Open the page in the GeminiCode browser and use Let Gemini Use This Page, or ask Gemini to open it with its browser."));
					}
					if (event.kind === 'toolCall') {
						this.follow.onToolCall(event.call);
						this.trySteer();
					}
					if (event.kind === 'toolCall' && this.activity.step !== this.lastStep) {
						this.fireActivity();
					}
				}
			}),
			client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.post({ type: 'capabilities', image: client.promptCapabilities.image });
					this.sessions.opened(state.savedSessionId);
					void this.usage.postContext();
				}
			}),
			service.onDidChangeStatus(status => this.post({ type: 'status', status: toViewStatus(status) })),
			client.onDidChangeSettings(settings => this.post({ type: 'settings', settings })),
			onDidChangeThemeTokens(() => this.webview && void this.postTokenColors()),
		);
	}

	get activity(): ChatActivity {
		const [permission] = this.service.permissions.pendingPermissions;
		const step = permission ? permission.request.toolCall.title ?? undefined : this.busy ? runningStep(this.transcript.items) : undefined;
		return { busy: this.busy, needsPermission: !!permission, ...(step ? { step } : {}), ...(this.busy && this.turnStartedAt !== undefined ? { startedAt: this.turnStartedAt } : {}) };
	}

	/** The conversation, as shown. */
	get conversation(): readonly TranscriptItem[] {
		return this.transcript.items;
	}

	/** Holds prompts until `loading` (reading this chat's saved conversation) settles. */
	holdPrompts(loading: Promise<unknown>): void {
		const held: Promise<void> = loading.then(() => undefined, () => undefined).finally(() => {
			if (this.restoring === held) {
				this.restoring = undefined;
			}
		});
		this.restoring = held;
	}

	/** Settles once the saved conversation is in; undefined when nothing is being read. */
	get whenRestored(): Promise<void> | undefined {
		return this.restoring;
	}

	/**
	 * Shows a saved conversation, unless one has started here. `sessionId` is
	 * the session it belongs to: if the agent opens another, the chat says the
	 * agent does not remember it.
	 */
	restore(items: readonly TranscriptItem[], sessionId: string | undefined): void {
		if (this.busy || this.transcript.items.length || !items.length) {
			return;
		}
		this.transcript.restore(items);
		if (wasCutOff(items)) {
			// The last prompt never got its turn end: the app quit (or the window reloaded) while the agent worked.
			this.transcript.addCutOff(this.transcript.lastUserPrompt ?? '');
		}
		this.sessions.shownConversation(sessionId);
	}

	/**
	 * Takes back the checkpoints saved with the chat, after {@link restore}:
	 * the turns they cover offer Undo again.
	 */
	restoreCheckpoints(stored: StoredCheckpoints | undefined): void {
		this.checkpoints.restore(stored);
	}

	/** Whether a webview shows this chat. */
	get attached(): boolean {
		return !!this.webview;
	}

	/** Shows the chat in `webview`, replacing any webview it was in. */
	attach(webview: vscode.Webview): void {
		this.detach();
		this.webview = webview;
		this.viewReady = false;
		// Start the agent with the view rather than once its script has loaded. The @-mention
		// file list waits until the chat is used. A failure shows in the view's status line.
		this.service.ensureReady().catch(() => undefined);
		const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
		webview.html = chatHtml(webview, mediaUri, !!this.options.project, this.forks.available);
		this.webviewListener = webview.onDidReceiveMessage((message: FromWebview) => this.onMessage(message));
	}

	/** The chat's tab came to the front: puts the cursor in the message box, so the user can type at once. */
	focusComposer(): void {
		if (this.viewReady) {
			this.post({ type: 'focus' });
		}
	}

	/** The view went out of sight or came back (its tab or pane); a hidden view defers rendering. */
	setHidden(hidden: boolean): void {
		if (this.viewReady) {
			this.post({ type: 'visibility', hidden });
		}
	}

	/** Forgets the webview, when it is disposed. The conversation carries on. */
	detach(webview?: vscode.Webview): void {
		if (webview && webview !== this.webview) {
			return;
		}
		this.webviewListener?.dispose();
		this.webviewListener = undefined;
		this.webview = undefined;
		this.viewReady = false;
	}

	/** Leaves Plan mode and carries out the plan, as the latest turn's Build button does; false when it offers none. */
	async approvePlan(): Promise<boolean> {
		if (!this.retryItemId || !buildModeAfterPlan(this.service.client.settings)) {
			return false;
		}
		await this.buildPlan(this.retryItemId);
		return true;
	}

	/** A project chat's card for one of its threads, added or updated in place. */
	showThread(card: Omit<ThreadCard, 'id' | 'kind'>): void {
		this.transcript.showThread(card);
	}

	/** A message the project's coordinator posted. */
	addCoordinatorPost(text: string): void {
		this.transcript.addCoordinatorPost(text);
	}

	/** The project chat's side panel; kept to show again when the view reloads. */
	showProjectPanel(panel: ProjectPanel): void {
		this.project.showPanel(panel);
	}

	/** Opens Project settings with `settings`, or refreshes it if it is open; `open` false only refreshes. */
	showProjectSettings(settings: ProjectSettingsView, open: boolean): void {
		this.project.showSettings(settings, open);
	}

	/** The folder Project settings' Add repository picked. */
	pickedRepository(repo: ProjectRepoView): void {
		this.project.pickedRepository(repo);
	}

	/** Opens the New thread dialog in a project chat, once its view has loaded if it is still loading. */
	openNewThread(): void {
		this.project.openNewThread();
	}

	/** Whether a turn is running; `send` does nothing meanwhile. */
	get running(): boolean {
		return this.busy;
	}

	/**
	 * Sends a prompt as if typed in the view; `from` marks one its project's
	 * coordinator sent. While the agent works, `when` decides: `queue` holds
	 * it until the turn ends, `now` steers the turn at its next safe point;
	 * without it the prompt is dropped, as before.
	 */
	async send(text: string, attachments: readonly Attachment[] = [], from?: 'coordinator', when?: 'now' | 'queue'): Promise<void> {
		attachments = attachments.filter(isValidAttachment);
		if (!text.trim() && !attachments.length) {
			return;
		}
		if (this.restoring) {
			await this.restoring;
		}
		const project = this.options.project;
		if (project) {
			if (this.busy) {
				// The coordinator is working: the message waits for its turn to end, never stopping it.
				this.queue.add(text, attachments, false);
				this.postQueue();
				return;
			}
			if (text.trim() === `/${compactCommand().name}` && !attachments.length) {
				void this.compacting.compact();
				return;
			}
			// A project's chat: the message goes to the hub, which wakes the coordinator with it.
			this.transcript.addPrompt(text, attachments);
			this.onDidSendPromptEmitter.fire(text);
			project.post(text, attachments);
			return;
		}
		if (this.busy) {
			// A coordinator's note waits for the turn to end; the user's own message steers when sent now.
			if (when || from) {
				this.queue.add(text, attachments, when === 'now', from);
				this.postQueue();
				this.trySteer();
			}
			return;
		}
		if (this.options.savedSessions && text.trim() === `/${resumeCommand().name}` && !attachments.length) {
			void this.pickSession();
			return;
		}
		if (text.trim() === `/${compactCommand().name}` && !attachments.length) {
			void this.compacting.compact();
			return;
		}
		if (this.forks.available && text.trim() === `/${forkCommand().name}` && !attachments.length) {
			void this.forks.open();
			return;
		}
		await this.startPrompt(text, attachments, from);
	}

	/** Starts a prompt's turn, the chat being idle: shows it, and sends it with the notes of any reactions it carries. */
	private async startPrompt(text: string, attachments: readonly Attachment[], from?: 'coordinator', reactions: readonly ReactionRequest[] = []): Promise<void> {
		this.sessions.stopReplay();
		this.service.open?.();
		if (this.retryItemId) {
			this.transcript.updateTurnEnd(this.retryItemId, { retry: undefined, buildPlan: undefined });
			this.retryItemId = undefined;
		}
		this.transcript.addPrompt(text, attachments, from, reactions.map(reactionRef));
		if (text.trim()) {
			this.onDidSendPromptEmitter.fire(text);
		}
		this.lastPrompt = { text, attachments, ...(reactions.length ? { reactions } : {}) };
		await this.runTurn(text, attachments, true, false, reactions);
	}

	/**
	 * The user reacted to the reply that `turnEnd` ends: the reply gets the
	 * chip, and the reaction goes to the agent as {@link routeReaction} says.
	 * The same reaction while it is still waiting or running is not sent again.
	 */
	private react(turnEnd: string, emoji: string, name: string): void {
		const target = this.transcript.items.find(item => item.id === turnEnd);
		if (this.options.project || !reactionsOn() || target?.kind !== 'turnEnd' || this.queue.hasReaction(turnEnd, emoji) || this.reactionRunning(turnEnd, emoji)) {
			return;
		}
		rememberReaction(emoji);
		this.postReactions();
		const meanings = reactionMeanings();
		const route = routeReaction(emoji, meanings, { busy: this.busy || !!this.restoring, buildPlan: !!target.buildPlan && turnEnd === this.retryItemId });
		this.transcript.addReaction(turnEnd, emoji);
		if (route === 'mark') {
			return;
		}
		if (route === 'buildPlan') {
			void this.buildPlan(turnEnd);
			return;
		}
		const meaning = meaningOf(emoji, meanings);
		const excerpt = olderReplyExcerpt(this.transcript.items, turnEnd);
		const request: ReactionRequest = { turnEnd, emoji, name, ...(meaning ? { meaning } : {}), ...(excerpt ? { excerpt } : {}), ...(target.unfinished ? { unfinished: true } : {}) };
		if (route === 'send') {
			void this.sendReaction(request);
			return;
		}
		this.queue.addReaction(request, route === 'now');
		this.postQueue();
		this.trySteer();
	}

	/** Sends a reaction as its own turn, once a saved conversation is in; it waits in the queue if a turn started meanwhile. */
	private async sendReaction(request: ReactionRequest): Promise<void> {
		if (this.restoring) {
			await this.restoring;
		}
		if (this.busy) {
			this.queue.addReaction(request, false);
			this.postQueue();
			return;
		}
		await this.startPrompt('', [], undefined, [request]);
	}

	/** Whether the running turn's prompt carried this reaction. */
	private reactionRunning(turnEnd: string, emoji: string): boolean {
		if (!this.busy) {
			return false;
		}
		const prompt = this.transcript.items.findLast(item => item.kind === 'user');
		return prompt?.kind === 'user' && !!prompt.reactions?.some(reaction => reaction.turnEnd === turnEnd && reaction.emoji === emoji);
	}

	private postReactions(): void {
		this.post({ type: 'reactions', on: !this.options.project && reactionsOn(), recents: recentReactions() });
	}

	/** Sends `text` to the agent ahead of the next prompt, without showing it in the chat. */
	addContext(text: string): void {
		this.pendingContext = this.pendingContext ? `${this.pendingContext}\n\n${text}` : text;
	}

	/** Opens the agent's session, as a prompt would, without sending one. */
	async openSession(): Promise<void> {
		if (this.restoring) {
			await this.restoring;
		}
		this.service.open?.();
		await this.service.ensureReady();
	}

	/**
	 * Sends `text` as a turn with no message of its own in the chat, such as a
	 * project's wake for its coordinator; resolves when the turn ends, and
	 * rejects with {@link CoordinatorTurnFailed} when it failed.
	 */
	async sendUnseen(text: string): Promise<void> {
		if (this.restoring) {
			await this.restoring;
		}
		// Other work that keeps the chat busy, such as Compact, ends first.
		while (this.busy && !this.turnRunning) {
			await new Promise<void>(resolve => {
				const listener = this.onDidChangeActivity(activity => {
					if (!activity.busy) {
						listener.dispose();
						resolve();
					}
				});
			});
		}
		if (this.busy) {
			throw new Error('A turn is already running.');
		}
		this.sessions.stopReplay();
		this.service.open?.();
		if (await this.runTurn(text, [], false) === 'failed') {
			throw new CoordinatorTurnFailed();
		}
	}

	/** Puts Retry on the latest error in the chat (adding `text` as one first, when given), for a project's failed wake. */
	offerRetry(text?: string): void {
		if (text) {
			this.transcript.addNotice(text, 'error');
		}
		this.transcript.offerRetry();
	}

	/** Takes Retry off the chat's errors again, as a project's next wake starts. */
	clearRetry(): void {
		this.transcript.clearRetry();
	}

	/** `steer` carries on after a turn stopped for messages sent now: the agent is told why it stopped. */
	private async runTurn(text: string, attachments: readonly Attachment[], expand: boolean, steer = false, reactions: readonly ReactionRequest[] = []): Promise<TurnOutcome> {
		this.turnRunning = true;
		this.checkpoints.beginTurn();
		this.setBusy(true);
		const started = Date.now();
		let ended = false;
		let overflowed = false;
		let failed = false;
		/** How the turn came to an end, for the messages waiting on it. */
		let outcome: 'done' | 'steer' | 'stopped' = 'stopped';
		this.timing = { started, permissions: 0 };
		try {
			await this.service.ensureReady();
			this.timing.ready = Date.now();
			// Built after the agent is ready, so it reflects what this agent accepts.
			const content = buildPromptContent(expand ? await this.commands.expand(text) : text, attachments, this.service.client.promptCapabilities);
			// A reaction with nothing typed stops the turn for itself: its note says so, in place of the steering note.
			const reactionOnly = !!reactions.length && !text.trim();
			const notes = reactions.map(reaction => reactionNote(reaction, steer && reactionOnly));
			if (!content.length && !notes.length) {
				throw new Error(vscode.l10n.t("The agent cannot take images, so there was nothing to send."));
			}
			// Told once per session: without it the model reaches for grep_search first (FINDINGS.md, workspace index).
			const state = this.service.client.state;
			const session = state.kind === 'ready' ? state.savedSessionId : undefined;
			const hint = session && !this.hintedSessions.has(session) ? this.options.indexHint?.() : undefined;
			if (session && hint) {
				this.hintedSessions.add(session);
				content.push({ type: 'text', text: hint });
			}
			const page = await this.sharedPage.refresh();
			if (page) {
				content.push({ type: 'text', text: page.note });
				if (!this.options.project) {
					this.transcript.addPromptPage(page.title, page.url);
				}
			}
			const undoNote = this.checkpoints.undoNote;
			if (undoNote) {
				content.unshift({ type: 'text', text: undoNote });
			}
			const carried = this.sessions.carriedConversation;
			if (carried) {
				content.unshift({ type: 'text', text: carried });
			}
			const context = this.pendingContext;
			if (context) {
				content.unshift({ type: 'text', text: context });
			}
			if (session && !this.options.project && agentReactionsOn() && !this.reactionRuleSessions.has(session)) {
				this.reactionRuleSessions.add(session);
				content.unshift({ type: 'text', text: reactionRule() });
			}
			for (const note of [...notes].reverse()) {
				content.unshift({ type: 'text', text: note });
			}
			if (steer && !reactionOnly) {
				content.unshift({ type: 'text', text: steeringNote() });
			}
			this.timing.sent = Date.now();
			recordPilot({ kind: 'prompt', waitedMs: this.timing.ready - started });
			const { stopReason, usage } = await this.promptRecovering(content);
			this.checkpoints.noteDelivered();
			if (context === this.pendingContext) {
				this.pendingContext = undefined;
			}
			this.sessions.delivered(carried);
			// Stopped to steer: no "Stopped." notice, since the agent carries on with the messages at once.
			const steered = stopReason === 'cancelled' && this.steerStopping && this.queue.hasSteer;
			const notice = steered ? undefined : stopReasonNotice(stopReason);
			if (notice) {
				this.transcript.addNotice(notice, stopReason === 'refusal' ? 'error' : 'info');
			}
			this.endTurn(Date.now() - started, usage, !steered && stopReason !== 'end_turn');
			ended = true;
			outcome = steered ? 'steer' : stopReason === 'end_turn' ? 'done' : 'stopped';
		} catch (err) {
			if (isContextOverflow(errorMessage(err))) {
				overflowed = true;
			} else {
				this.transcript.addNotice(errorMessage(err), err instanceof TeamCommandCancelled ? 'info' : 'error');
				failed = !(err instanceof TeamCommandCancelled);
			}
		} finally {
			if (!ended && this.checkpoints.turnChangedFiles) {
				// The turn failed after changing files; they can still be undone.
				this.endTurn(Date.now() - started, undefined, true);
			}
			this.steerStopping = false;
			// Stopped to steer, the chat stays busy into the next turn.
			if (outcome !== 'steer') {
				this.setBusy(false);
			}
			void this.usage.postContext();
		}
		if (overflowed) {
			this.queue.holdSteers();
			this.postQueue();
			await this.continueAfterOverflow(expand ? text : undefined);
			this.turnRunning = false;
			return 'failed';
		}
		this.turnRunning = false;
		await this.sendPending(outcome);
		return failed ? 'failed' : outcome;
	}

	/**
	 * After a turn: messages sent now go at once, steering a stopped turn or
	 * starting the next one if the turn ended first; queued ones go when the
	 * turn finished, all together. A turn the user stopped, or that failed,
	 * keeps them waiting, and what was sent now waits like a queued message.
	 */
	private async sendPending(outcome: 'done' | 'steer' | 'stopped'): Promise<void> {
		if (outcome !== 'steer' && this.busy) {
			return;
		}
		if (outcome === 'stopped') {
			if (this.queue.hasSteer) {
				this.queue.holdSteers();
				this.postQueue();
			}
			return;
		}
		const next = outcome === 'steer' || this.queue.hasSteer ? this.queue.takeSteers() : this.queue.takeAll();
		this.postQueue();
		if (!next) {
			if (outcome === 'steer') {
				this.setBusy(false);
			}
			return;
		}
		if (this.options.project) {
			// What waited in a project's chat goes to the hub, which wakes the coordinator again.
			await this.send(next.text, next.attachments);
			return;
		}
		this.transcript.addPrompt(next.text, next.attachments, next.from, (next.reactions ?? []).map(reactionRef));
		if (next.text.trim()) {
			this.onDidSendPromptEmitter.fire(next.text);
		}
		this.lastPrompt = next;
		await this.runTurn(next.text, next.attachments, true, outcome === 'steer', next.reactions);
	}

	/** Stops the turn for the messages sent now, once no tool is running; a running tool's end calls this again. */
	private trySteer(): void {
		if (!this.busy || this.quiet || this.steerStopping || !this.queue.hasSteer) {
			return;
		}
		const waiting = this.service.permissions.pendingPermissions.length > 0;
		if (!atSafePoint(this.transcript.items, waiting)) {
			return;
		}
		this.steerStopping = true;
		void this.service.cancel();
	}

	private postQueue(): void {
		this.post({ type: 'queue', items: this.queue.view });
	}

	/** A pending message's buttons in the composer. */
	private queueAction(id: string, action: 'send' | 'edit' | 'remove'): void {
		if (action === 'send') {
			if (!this.busy) {
				const prompt = this.queue.remove(id);
				this.postQueue();
				if (prompt?.reactions?.length) {
					void this.startPrompt(prompt.text, prompt.attachments, prompt.from, prompt.reactions);
				} else if (prompt) {
					void this.send(prompt.text, prompt.attachments, prompt.from);
				}
				return;
			}
			// A coordinator's turn is never stopped: its messages go when it ends.
			if (!this.options.project && this.queue.steer(id)) {
				this.postQueue();
				this.trySteer();
			}
			return;
		}
		const prompt = this.queue.remove(id);
		this.postQueue();
		// A reaction has no text to edit: Edit only takes it out.
		if (action === 'edit' && prompt?.text) {
			this.post({ type: 'draft', text: prompt.text });
			if (prompt.attachments.length) {
				void this.attachments.add(prompt.attachments);
			}
		}
	}

	/**
	 * After Gemini refused a turn because the session's history is over the
	 * model's context limit, which no later request in that session can get
	 * past: moves the chat to a new session that is given the conversation so
	 * far (prompts and replies, without the tool output that filled it), and
	 * puts `prompt` back in the box. Nothing is sent again by itself, since the
	 * turn may have changed files before it failed.
	 */
	private async continueAfterOverflow(prompt: string | undefined): Promise<void> {
		const sessionId = this.sessions.current();
		const conversation = sessionId ? await readCliConversation(this.service.client.cwd, sessionId).catch(() => undefined) : undefined;
		this.setBusy(true);
		try {
			// Moving on on purpose: not the agent losing the session.
			this.sessions.moveTo(undefined);
			await this.service.client.newSession();
			this.options.project?.sessionReplaced();
		} catch (err) {
			this.transcript.addNotice(vscode.l10n.t("Gemini's context for this chat is full, and a new session could not start: {0} Start a new chat to carry on.", errorMessage(err)), 'error');
			return;
		} finally {
			this.setBusy(false);
		}
		this.transcript.addNotice(this.sessions.carry('this chat', conversation)
			? vscode.l10n.t("Gemini's context for this chat filled up, most likely with a large tool output, so Gemini could not answer. The chat continues in a new session that is given the conversation so far, without the tool outputs. Send your message again to carry on.")
			: vscode.l10n.t("Gemini's context for this chat filled up, most likely with a large tool output, so Gemini could not answer. The chat continues in a new session that starts without the earlier conversation. Send your message again to carry on."), 'error');
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
			throw new Error(vscode.l10n.t("Gemini refused the request after a tool result, and again when asked to carry on. This is a known Gemini CLI problem after screenshots. The work so far is kept: send your message again, or switch the model and retry."));
		}
	}

	/** Adds the turn's end, offering Retry and, when it changed files, Undo. */
	private endTurn(durationMs: number, usage?: readonly ModelTokens[], unfinished = false): void {
		const id = this.transcript.addTurnEnd(durationMs, usage);
		const { files, undoable } = this.checkpoints.endTurn(id);
		this.transcript.updateTurnEnd(id, { retry: !this.options.project, ...(files ? { files } : {}), ...(undoable ? { undo: 'available' } : {}), ...(buildModeAfterPlan(this.service.client.settings) ? { buildPlan: true } : {}), ...(unfinished ? { unfinished } : {}) });
		this.retryItemId = id;
		const timing = this.timing;
		this.timing = undefined;
		recordPilot({
			kind: 'turn', permissions: timing?.permissions ?? 0, durationMs,
			...timing?.sent && timing.firstToken ? { firstTokenMs: timing.firstToken - timing.sent } : {},
			...timing?.sent && timing.firstText ? { firstTextMs: timing.firstText - timing.sent } : {},
		});
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

	/** Leaves Plan mode and asks the agent to carry out the plan it just wrote. */
	private async buildPlan(itemId: string): Promise<void> {
		const mode = buildModeAfterPlan(this.service.client.settings);
		if (this.busy || itemId !== this.retryItemId || !mode) {
			return;
		}
		await this.settings.change(() => this.service.client.setMode(mode));
		if (this.service.client.settings.mode?.currentId === mode) {
			await this.send(vscode.l10n.t("Carry out the plan above."));
		}
	}

	/** Every saved session for the folder, in a quick pick; the one picked opens here. */
	async pickSession(): Promise<void> {
		return this.sessions.pick();
	}

	/**
	 * Reopens saved session `id` here: the agent picks it up where it left
	 * off and replays it into the chat. A conversation already here is
	 * replaced, after asking; it stays saved by the CLI.
	 */
	async restoreSession(id: string, title?: string): Promise<void> {
		return this.sessions.restore(id, title);
	}

	/** Shows the shared page's chip as the browser has it now; resolves with the page, if one is shared. */
	async refreshSharedPage(): Promise<{ readonly title: string; readonly url: string; readonly note: string } | undefined> {
		return this.sharedPage.refresh();
	}

	/** Adds context to the composer (Add File / Add Selection to Chat), showing the chat first. */
	async addAttachments(attachments: readonly Attachment[]): Promise<void> {
		return this.attachments.add(attachments);
	}

	/** Shows an information line in the conversation. */
	addNotice(text: string): void {
		this.transcript.addNotice(text);
	}

	/** The model the session is on, when known. */
	get model(): string | undefined {
		return this.service.client.settings.model?.currentId;
	}

	/** Lists the shell programs allowed for this session, to forget some or all of them. */
	async manageApprovals(): Promise<void> {
		return this.permissions.manageApprovals();
	}

	/** Opens the usage popover, or closes it if open; the chat comes into view first. */
	async showUsage(): Promise<void> {
		return this.usage.show();
	}

	/** Clears the conversation and, when the agent runs, starts a fresh session so it forgets it too. */
	async newChat(): Promise<void> {
		if (this.busy) {
			return;
		}
		this.clearConversation();
		if (this.service.client.state.kind !== 'ready') {
			// The next prompt starts the agent, and with it a new session.
			this.service.client.forgetSession();
			this.fireActivity();
			return;
		}
		this.setBusy(true);
		try {
			await this.service.client.newSession();
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		} finally {
			this.setBusy(false);
		}
	}

	/** Opens the conversation as a Markdown document, titled `title`. */
	async openAsMarkdown(title: string): Promise<void> {
		return openChatAsMarkdown(title, this.transcript.items, await this.options.editorColumn?.());
	}

	/** Turns Follow the agent on or off in this chat; new chats start the same way. */
	toggleFollowing(): void {
		this.follow.toggle();
	}

	/** The Enhance Prompt command: enhances what the composer holds, showing the chat first. */
	async requestEnhance(): Promise<void> {
		return this.enhance.request();
	}

	/** Commits the files the agent changed on a new branch, as the composer's Commit button does. */
	async commit(): Promise<void> {
		return this.git.commit();
	}

	/** Shows the branch and folder again, as after a project's repositories changed. */
	refreshGit(): void {
		this.git.refresh();
		this.runs.postView();
	}

	dispose(): void {
		clearTimeout(this.openTimer);
		this.detach();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private onMessage(message: FromWebview): void {
		if (message.type !== 'ready' && message.type !== 'shown') {
			// The user is using the chat: a session waiting for it to show opens now, and the
			// @-mention file list starts building, well before an @ is typed.
			this.service.open?.();
			this.fileIndex.warm();
		}
		switch (message.type) {
			case 'shown':
				this.service.open?.();
				break;
			case 'ready':
				if (message.protocol !== chatProtocolVersion) {
					void vscode.window.showWarningMessage(vscode.l10n.t("The Gemini chat view's script is out of date. Rebuild it with \"npm run gulp compile-extension-media\" (or keep \"npm run watch\" running) and reload the window."));
				}
				this.viewReady = true;
				// Before the items, so their shell blocks show Run as they are drawn.
				this.runs.postView();
				this.postReset();
				// In case the view never says it is shown, such as one hidden as it loads.
				clearTimeout(this.openTimer);
				this.openTimer = setTimeout(() => this.service.open?.(), openFallbackMs);
				this.post({ type: 'capabilities', image: this.service.client.promptCapabilities.image });
				this.post({ type: 'composerHeight', height: preferredComposerHeight() });
				this.follow.postFollowing();
				this.follow.postFollowed();
				this.attachments.postPending();
				this.postQueue();
				this.postReactions();
				this.usage.onReady();
				this.git.refresh();
				void this.sharedPage.refresh();
				void this.attachments.postToolRefs();
				// The agent was started with the view (see attach); this retries one that has since stopped.
				this.service.ensureReady().catch(() => undefined);
				// After starting the agent: finding the theme's file scans every extension the first time.
				setTimeout(() => void this.postTokenColors(), 0);
				break;
			case 'prompt':
				void this.send(message.text, message.attachments ?? [], undefined, message.when);
				break;
			case 'queueAction':
				this.queueAction(message.id, message.action);
				break;
			case 'react':
				this.react(message.turnEnd, message.emoji, message.name);
				break;
			case 'composerHeight':
				rememberComposerHeight(message.height);
				break;
			case 'stop':
				// Stop means stop: messages sent now wait instead, for the user to send.
				this.steerStopping = false;
				if (this.queue.hasSteer) {
					this.queue.holdSteers();
					this.postQueue();
				}
				void this.service.cancel();
				break;
			case 'command':
				if (statusCommands.includes(message.command)) {
					void vscode.commands.executeCommand(message.command);
				}
				break;
			case 'retry':
				if (this.options.project) {
					// A project's failed wake: the hub sends its events again.
					this.transcript.clearRetry();
					this.options.project.retryWake();
				} else if (this.lastPrompt?.reactions && message.itemId === this.retryItemId && !this.busy) {
					void this.startPrompt(this.lastPrompt.text, this.lastPrompt.attachments, undefined, this.lastPrompt.reactions);
				} else if (this.lastPrompt && message.itemId === this.retryItemId) {
					void this.send(this.lastPrompt.text, this.lastPrompt.attachments);
				}
				break;
			case 'retryCutOff': {
				const item = this.transcript.items.find(i => i.id === message.itemId);
				if (item?.kind === 'cutOff' && item.prompt) {
					this.transcript.dismissCutOff(item.id);
					void this.send(item.prompt);
				}
				break;
			}
			case 'dismissCutOff':
				this.transcript.dismissCutOff(message.itemId);
				break;
			case 'buildPlan':
				void this.buildPlan(message.itemId);
				break;
			case 'listCommands':
				void this.commands.postCommands();
				break;
			case 'permission':
				this.permissions.onMessage(message);
				break;
			case 'setMode':
			case 'setModel':
				this.settings.onMessage(message);
				break;
			case 'openDiff':
			case 'openLocation':
			case 'openPath':
			case 'openTrace':
				this.files.onMessage(message);
				break;
			case 'pickFiles':
			case 'attachUris':
			case 'searchFiles':
			case 'resolveToolRef':
			case 'openToolRef':
			case 'pickToolItem':
				this.attachments.onMessage(message);
				break;
			case 'stopSharing':
			case 'openSharedPage':
				this.sharedPage.onMessage(message);
				break;
			case 'setFollow':
			case 'showFollowed':
			case 'closeFollowed':
				this.follow.onMessage(message);
				break;
			case 'listBranches':
			case 'switchBranch':
			case 'createBranchAndCommit':
			case 'workspaceAction':
			case 'openReview':
			case 'openMergeRequest':
				this.git.onMessage(message);
				break;
			case 'restoreSession':
			case 'pickSession':
				this.sessions.onMessage(message);
				break;
			case 'undoTurn':
			case 'rewind':
			case 'pickRewind':
				this.checkpoints.onMessage(message);
				break;
			case 'requestFork':
			case 'fork':
			case 'forkAction':
				this.forks.onMessage(message);
				break;
			case 'compact':
			case 'undoCompact':
			case 'dismissCompact':
			case 'viewCompactSummary':
				this.compacting.onMessage(message);
				break;
			case 'threadAction':
			case 'prepareThread':
			case 'openProjectSettings':
			case 'saveProjectSettings':
			case 'projectSettingsAction':
			case 'startThread':
			case 'openParentProject':
				this.project.onMessage(message);
				break;
			case 'prepareEnhance':
			case 'enhancePrompt':
			case 'cancelEnhance':
				this.enhance.onMessage(message);
				break;
			case 'readQuota':
			case 'openUpgrade':
				this.usage.onMessage(message);
				break;
			case 'runCommand':
			case 'sendRunOutput':
				this.runs.onMessage(message);
				break;
		}
	}

	/** Opens the Fork dialog in this chat, as its Fork button does; the chat comes into view first. */
	async openFork(): Promise<void> {
		await this.options.reveal(false);
		await this.forks.open();
	}

	/** This chat starts a fork's conversation: its parent's, then a line naming the parent. */
	startFork(items: readonly TranscriptItem[], sessionId: string | undefined, line: { readonly parent: string; readonly title: string; readonly context: ForkContext }): void {
		this.restore(items, sessionId);
		this.transcript.addFork({ role: 'from', agent: line.parent, title: line.title, context: line.context });
	}

	/** Gives the next prompt `conversation` from agent `title`, which this chat's new session would not otherwise have. */
	carryConversation(title: string, conversation: readonly ConversationEntry[]): void {
		this.sessions.carry(title, conversation);
	}

	/** Fork `agent` was removed: its cards here say so. */
	forkRemoved(agent: string): void {
		this.transcript.forkRemoved(agent);
	}

	/** Clears the conversation and what the chat keeps about it: proposed edits, checkpoints, Retry, and what the next prompt would carry. */
	private clearConversation(): void {
		this.transcript.clear();
		this.queue.clear();
		this.postQueue();
		this.files.clear();
		this.completedToolCalls.clear();
		this.checkpoints.clear();
		this.lastPrompt = undefined;
		this.retryItemId = undefined;
		this.sessions.forgetConversation();
	}

	/** Runs `work` with the chat busy and its turn's updates kept out of the transcript. */
	private async quietly<T>(work: () => Promise<T>): Promise<T> {
		this.quiet = true;
		this.setBusy(true);
		try {
			return await work();
		} finally {
			this.quiet = false;
			this.setBusy(false);
		}
	}

	private setBusy(busy: boolean): void {
		if (busy && !this.busy) {
			this.turnStartedAt = lastPromptAt(this.transcript.items) ?? Date.now();
		}
		const finished = this.busy && !busy;
		this.busy = busy;
		if (finished && !this.turnRunning && this.queue.pending.length) {
			// Messages sent during other work, such as Compact, go once it is done.
			setTimeout(() => void this.sendPending('done'), 0);
		}
		if (this.options.busyContextKey) {
			void vscode.commands.executeCommand('setContext', this.options.busyContextKey, busy);
		}
		this.post({ type: 'busy', busy });
		this.fireActivity();
		// A turn may have switched branches or changed files.
		this.git.refresh();
	}

	private fireActivity(): void {
		const activity = this.activity;
		this.lastStep = activity.step;
		this.onDidChangeActivityEmitter.fire(activity);
	}

	private postReset(): void {
		// The reset carries every item, so pending updates are already in it.
		this.items.clear();
		this.textDeltas.reset(this.transcript.items);
		this.post({ type: 'reset', items: this.transcript.items, busy: this.busy, status: toViewStatus(this.service.status), settings: this.service.client.settings });
		this.project.postReset();
		if (!this.busy) {
			void this.sessions.postSessions();
		}
		void this.usage.postContext();
	}

	private post(message: ToWebview): void {
		if (message.type !== 'items') {
			// Keep the order: item updates first, then whatever follows them.
			this.items.flush();
		}
		void this.webview?.postMessage(message);
	}

	private async postTokenColors(): Promise<void> {
		this.post({ type: 'tokenColors', colors: await themeTokenColors() });
	}
}

/** Opens `items` as an untitled Markdown document, beside the chat when `column` is set. */
export async function openChatAsMarkdown(title: string, items: readonly TranscriptItem[], column?: vscode.ViewColumn): Promise<void> {
	const content = chatToMarkdown(title, items, {
		you: vscode.l10n.t("You"),
		gemini: vscode.l10n.t("Gemini"),
		thought: vscode.l10n.t("Thought"),
		plan: vscode.l10n.t("Plan"),
		attached: vscode.l10n.t("Attached"),
		workedFor: vscode.l10n.t("Worked for {0}"),
		permission: vscode.l10n.t("Permission for {0}: {1}"),
		cancelled: vscode.l10n.t("Cancelled"),
		reacted: vscode.l10n.t("You reacted {0} to Gemini's reply"),
	});
	const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
	await vscode.window.showTextDocument(document, { preview: false, viewColumn: column });
}

/** When a turn's steps happened, in ms since the epoch. */
interface TurnTiming {
	readonly started: number;
	/** Permission cards the turn showed, for the pilot's counters. */
	permissions: number;
	ready?: number;
	sent?: number;
	/** The model's first output after the prompt was sent: a thought, a tool call, a plan or reply text. */
	firstToken?: number;
	/** The first reply text, which in an agentic turn often comes after every step. */
	firstText?: number;
}

/** What the transcript keeps of a reaction sent with a prompt. */
function reactionRef({ turnEnd, emoji, name }: ReactionRequest): ReactionRef {
	return { ...(turnEnd ? { turnEnd } : {}), emoji, name };
}

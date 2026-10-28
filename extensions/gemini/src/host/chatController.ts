/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sideQuestionOf } from '../acp/sideChat';
import { ChatSide, sideCommand } from './chat/chatSide';
import { ChatResearch, researchCommand } from './chat/chatResearch';
import { researchQuestionOf } from '../acp/researchQuestion';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { onDidChangeFoldWork } from './foldWork';
import { onDidChangeSpellCheck } from './spellCheck';
import { currentTraceFile } from './traceCommand';
import { parseTraceFile, summarizeTrace, turnReadout } from '../acp/traceRecording';
import type { Attachment } from '../acp/attachments';
import { isValidAttachment } from '../acp/attachmentValidation';
import { chatToMarkdown } from '../acp/chatMarkdown';
import { ChatTranscript, ForkContext, ThreadCard, toolCallItemId, TranscriptItem } from '../acp/chatTranscript';
import { buildModeAfterPlan, diffsOf, nextApprovalMode, dropOldest, lastPromptAt, planBuildChoice, planBuildModels, runningStep, turnShape, wasCutOff } from '../acp/chatTurns';
import type { StoredCheckpoints } from '../acp/checkpoints';
import { buildPromptContent } from '../acp/promptContent';
import { atSafePoint, PromptQueue, steeringNote, steerWaitMs, type PromptExtras } from '../acp/promptQueue';
import { meaningOf, olderReplyExcerpt, reactionNote, reactionRule, reactionShortcut, routeReaction, type ReactionRef, type ReactionRequest } from '../acp/reactions';
import { CoordinatorTurnFailed } from '../acp/projectHub';
import { TeamCommandCancelled } from '../acp/teamCommandExpansion';
import { cliHome, ConversationEntry, readCliConversation, readSessionMessages } from '../acp/cliSessions';
import { projectTempDirName } from '../acp/cli/formats';
import { sessionFolder } from '../acp/sessionFolder';
import { isModelOutput } from '../acp/sessionUpdates';
import { TextDeltas } from '../acp/textDeltas';
import type { ModelTokens } from '../acp/turnUsage';
import { UpdateBatcher } from '../acp/updateBatcher';
import { isBlockedWebFetch } from '../acp/webFetchHint';
import { type AgentClient, type TurnStall, WaitAbortedError } from '../acp/agentClient';
import { classifyTurnError, errorMessage, isContextOverflow, isModelTurnRefusal } from '../acp/errors';
import { chatProtocolVersion, FromWebview, ProjectPanel, ProjectRepoView, ProjectSettingsView, statusCommands, ToWebview, type ViewStall } from './chatProtocol';
import { stallNotice, stopReasonActions, stopReasonNotice, toViewStatus, turnErrorNotice, type TurnErrorNotice } from './chatStatus';
import type { DiffPreview } from './diffPreview';
import { agentReactionsOn, onDidChangeReactions, reactionMeanings, reactionsOn, recentReactions, rememberReaction, shownMeanings } from './chatReactions';
import { preferredComposerHeight, rememberComposerHeight } from './modelPreference';
import { onDidChangeThemeTokens, themeTokenColors } from './themeTokens';
import { ChatAttachments } from './chat/chatAttachments';
import { ChatCheckpoints } from './chat/chatCheckpoints';
import { ChatCommands } from './chat/chatCommands';
import { ChatCompact, compactCommand } from './chat/chatCompact';
import { ChatFork, forkCommand } from './chat/chatFork';
import { ChatEnhance } from './chat/chatEnhance';
import { ChatFileLinks, isFile } from './chat/chatFiles';
import { extensionChunk } from './lazyFeature';
import { ChatFollow } from './chat/chatFollow';
import { ChatGitControls } from './chat/chatGit';
import { chatHtml } from './chat/chatHtml';
import type { ChatControllerOptions, ChatHost, FileSearch } from './chat/chatOptions';
import { ChatPermissions } from './chat/chatPermissions';
import { ChatProjectView } from './chat/chatProject';
import { ChatRun } from './chat/chatRun';
import { ChatSessions, resumeCommand } from './chat/chatSessions';
import { ChatSettings, onDidChangeSendWith, sendsWithCmdEnter } from './chat/chatSettings';
import { SharedPageChip } from './chat/chatSharedPage';
import { SideLinksColumn } from './chat/chatSideLinks';
import { ChatUsage, contextCommand } from './chat/chatUsage';

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
	/** Offers Stop Now on a message sent now that has waited `steerWaitMs` for a safe point. */
	private steerWaitTimer: ReturnType<typeof setTimeout> | undefined;
	private steerWaiting = false;
	/** A prompt's turn is running; other work that keeps the chat busy (Compact, Undo, a new session) is not one. */
	private turnRunning = false;

	/** The last prompt, for Retry. */
	private lastPrompt: { readonly text: string; readonly attachments: readonly Attachment[]; readonly reactions?: readonly ReactionRequest[] } | undefined;
	/** The turnEnd item that offers Retry. */
	private retryItemId: string | undefined;
	/** Context sent ahead of the next prompt without showing in the chat, such as a project's memory for a thread. */
	private pendingContext: string | undefined;
	/** The agent's tried files the user edited and hasn't sent it. */
	private triedEdits: readonly string[] = [];
	/** The Markdown file the running Plan mode turn wrote last: its plan. */
	private turnPlanFile: string | undefined;
	/** The saved chat being read in, while it is: prompts wait for it, so neither replaces the other. */
	private restoring: Promise<void> | undefined;
	/** Whether the view's script has said it is ready since the view was attached. */
	private viewReady = false;
	/** Opens a session waiting for the chat to show, if the view does not say it is shown. */
	private openTimer: ReturnType<typeof setTimeout> | undefined;

	/** Aborts the running turn's wait for its session (`ensureReady`), so Stop works before the prompt is sent. */
	private turnWait: AbortController | undefined;
	private _includingEdits = false;
	/** The latest failed turn's notice, with the ways out it offers; cleared when the next turn starts. */
	private _lastTurnError: TurnErrorNotice | undefined;
	private disposed = false;
	/** Called on dispose, so waits on this chat end. */
	private readonly onDispose = new Set<() => void>();
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
	private readonly sideLinks: SideLinksColumn;
	private readonly settings: ChatSettings;
	private readonly enhance: ChatEnhance;
	private readonly commands: ChatCommands;
	private readonly sessions: ChatSessions;
	private readonly checkpoints: ChatCheckpoints;
	private readonly compacting: ChatCompact;
	private readonly forks: ChatFork;
	private readonly side: ChatSide;
	private readonly research: ChatResearch;
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
		this.files = new ChatFileLinks(diffPreview, () => options.git?.folder() ?? client.cwd, options, file => this.reviewPlanFile(file), file => this.rebuildPlan(file));
		// A long tool output is kept whole here for Show All; the transcript, and every reset, carries its first and last lines.
		this.transcript.trimOutput = (itemId, part, text) => this.files.outputs.put(itemId, part, text);
		this.permissions = new ChatPermissions(service.permissions, this.transcript, this.files, options);
		this.follow = new ChatFollow(client.cwd, options, post);
		this.git = new ChatGitControls(options, isBusy, isAttached, post);
		this.usage = new ChatUsage(client, options, () => this.transcript.items.length > 0, isAttached, post, (used, limit) => this.compacting.contextChanged(used, limit));
		this.attachments = new ChatAttachments(fileIndex, options, () => options.git?.folder() ?? client.cwd, isAttached, isViewReady, post);
		this.sharedPage = new SharedPageChip(options, post);
		this.sideLinks = new SideLinksColumn(options, isViewReady, post);
		this.settings = new ChatSettings(service, this.transcript, options, post);
		this.enhance = new ChatEnhance(client, options, () => this.transcript.items, post);
		this.commands = new ChatCommands(client, this.transcript, [...options.savedSessions ? [resumeCommand()] : [], compactCommand(), contextCommand(), sideCommand(), ...options.research ? [researchCommand()] : [], ...options.fork ? [forkCommand()] : []], isAttached, post);
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
		this.side = new ChatSide(options, this.transcript, isBusy, post);
		this.research = new ChatResearch(options, this.transcript, post);
		this.project = new ChatProjectView(options, isViewReady, post);
		this.runs = new ChatRun(options, isAttached, post, attachments => void this.addAttachments(attachments),
			() => this.transcript.items.flatMap(item => item.kind === 'agent' || item.kind === 'user' ? [item.text] : []));
		this.disposables.push(
			onDidChangeSpellCheck(on => this.post({ type: 'spellCheck', on })),
			onDidChangeFoldWork(on => this.post({ type: 'foldWork', on })),
			onDidChangeReactions(() => this.postReactions()),
			onDidChangeSendWith(cmdEnter => this.post({ type: 'sendWith', cmdEnter })),
			// The build's model may have changed since the plan: Build This Plan's hint follows.
			client.onDidChangeSettings(() => this.refreshPlanBuild()),
			this.onDidChangeActivityEmitter,
			this.onDidEditFilesEmitter,
			this.onDidSendPromptEmitter,
			this.onDidRestoreSessionEmitter,
			this.follow,
			this.git,
			this.attachments,
			this.settings,
			this.enhance,
			this.side,
			this.research,
			this.commands,
			this.sessions,
			this.runs,
			this.usage,
			service.permissions.onDidChange(event => {
				this.permissions.apply(event);
				this.fireActivity();
				this.trySteer();
			}),
			this.transcript,
			this.sideLinks,
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
					let edited: readonly acp.Diff[] = [];
					if (event.kind === 'toolCall') {
						const diffs = diffsOf(event.call.content);
						this.files.remember(toolCallItemId(event.call.id), diffs);
						if (event.call.status === 'completed' && diffs.length && !this.completedToolCalls.has(event.call.id)) {
							this.completedToolCalls.add(event.call.id);
							dropOldest(this.completedToolCalls);
							this.checkpoints.record(diffs);
							this.onDidEditFilesEmitter.fire(diffs);
							edited = diffs;
							// The plan a Plan mode turn writes, for its Review Plan.
							const plan = client.settings.mode?.currentId === 'plan' ? diffs.map(diff => diff.path).findLast(file => /\.(md|markdown)$/i.test(file)) : undefined;
							if (plan) {
								this.turnPlanFile = plan;
							}
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
					// The model answering after a tool means the tool's result reached it: a message sent now can stop the turn.
					if (this.queue.hasSteer && isModelOutput(event)) {
						this.trySteer();
					}
					if (event.kind === 'toolCall' && edited.length && editsWithoutCards(client.settings.mode?.currentId)) {
						// No card asked about this edit: its row says when another agent is changing the file too.
						this.transcript.setOthers(toolCallItemId(event.call.id), this.permissions.othersChanging(edited.map(diff => diff.path)));
					}
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
			// A turn with no update for a while says so in the chat, until anything arrives.
			client.onDidChangeStall(stall => this.post({ type: 'stall', stall: this.viewStall(stall) })),
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
		if (!this.retryItemId || !this.planBuild()) {
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
	 * without it the prompt is dropped, as before. `extras.settle` is told
	 * whether the prompt went, once its own turn is over.
	 */
	async send(text: string, attachments: readonly Attachment[] = [], from?: 'coordinator', when?: 'now' | 'queue', extras: PromptExtras = {}): Promise<void> {
		attachments = attachments.filter(isValidAttachment);
		if (!text.trim() && !attachments.length) {
			extras.settle?.(false);
			return;
		}
		if (this.restoring) {
			await this.restoring;
		}
		const project = this.options.project;
		// `/btw` asks on the side: the agent's turn and history are left alone.
		const side = !from && !attachments.length ? sideQuestionOf(text) : undefined;
		if (side !== undefined) {
			extras.settle?.(true);
			this.side.open(side);
			return;
		}
		// `/research` reads widely on the side, read-only; the agent's turn and history are left alone.
		const research = !project && !from && !attachments.length && this.options.research ? researchQuestionOf(text) : undefined;
		if (research !== undefined) {
			extras.settle?.(true);
			void this.research.run(research);
			return;
		}
		// `+` and one emoji alone reacts to the latest reply instead of being sent.
		const shortcut = !project && !from && !attachments.length && reactionsOn() ? reactionShortcut(text) : undefined;
		const latest = shortcut && this.transcript.items.findLast(item => item.kind === 'turnEnd');
		if (shortcut && latest) {
			extras.settle?.(true);
			this.react(latest.id, shortcut, shortcut);
			return;
		}
		if (project) {
			if (this.busy) {
				// The coordinator is working: the message waits for its turn to end, never stopping it.
				this.queue.add(text, attachments, false, undefined, extras);
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
			extras.settle?.(true);
			return;
		}
		if (this.busy) {
			// A coordinator's note waits for the turn to end; the user's own message steers when sent now,
			// except one with the user's edits, which can only go once the agent's turn is over.
			if (when || from) {
				this.queue.add(text, attachments, when === 'now' && !extras.includeEdits, from, extras);
				this.postQueue();
				this.trySteer();
			} else {
				extras.settle?.(false);
			}
			return;
		}
		if (extras.settle) {
			// Plan Review's message, never a command.
			return this.startPrompt(text, attachments, from, [], extras);
		}
		if (this.options.savedSessions && text.trim() === `/${resumeCommand().name}` && !attachments.length) {
			void this.pickSession();
			return;
		}
		if (text.trim() === `/${compactCommand().name}` && !attachments.length) {
			void this.compacting.compact();
			return;
		}
		if (text.trim() === `/${contextCommand().name}` && !attachments.length) {
			void this.usage.show(true);
			return;
		}
		if (this.forks.available && text.trim() === `/${forkCommand().name}` && !attachments.length) {
			void this.forks.open();
			return;
		}
		await this.startPrompt(text, attachments, from, [], extras);
	}

	/** Starts a prompt's turn, the chat being idle: shows it, and sends it with the notes of any reactions it carries. */
	private async startPrompt(text: string, attachments: readonly Attachment[], from?: 'coordinator', reactions: readonly ReactionRequest[] = [], extras: PromptExtras = {}): Promise<void> {
		this.sessions.stopReplay();
		this.service.open?.();
		if (this.retryItemId) {
			this.transcript.updateTurnEnd(this.retryItemId, { retry: undefined, buildPlan: undefined, build: undefined });
			this.retryItemId = undefined;
		}
		this.transcript.addPrompt(text, attachments, from, reactions.map(reactionRef));
		if (text.trim()) {
			this.onDidSendPromptEmitter.fire(text);
		}
		this.lastPrompt = { text, attachments, ...(reactions.length ? { reactions } : {}) };
		await this.runTurn(text, attachments, true, false, reactions, extras);
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
		this.post({ type: 'reactions', on: !this.options.project && reactionsOn(), recents: recentReactions(), meanings: shownMeanings() });
	}

	/** The agent's tried files the user edited and hasn't sent it (agentTries.ts): the message box offers to include them. */
	setTriedEdits(files: readonly string[]): void {
		this.triedEdits = files;
		this.post({ type: 'triedEdits', files });
	}

	/**
	 * "Include your edits": the user's edits to tried files go to the agent's
	 * folder as its turn starts, the chat already busy so no other message
	 * starts one meanwhile; a failure shows in the chat.
	 */
	private async includeTriedEdits(): Promise<void> {
		if (this.triedEdits.length) {
			this._includingEdits = true;
			try {
				await this.options.sendTriedEdits?.().catch(err => this.transcript.addNotice(vscode.l10n.t("Your edits weren't sent to the agent: {0}", errorMessage(err)), 'error'));
			} finally {
				this._includingEdits = false;
			}
		}
	}

	/** The chat is busy copying the user's edits for its own turn: Send My Edits' busy check lets that through. */
	get includingEdits(): boolean {
		return this._includingEdits;
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
		while (this.busy && !this.turnRunning && !this.disposed) {
			await new Promise<void>(resolve => {
				const done = () => {
					listener.dispose();
					this.onDispose.delete(done);
					resolve();
				};
				const listener = this.onDidChangeActivity(activity => !activity.busy && done());
				this.onDispose.add(done);
			});
		}
		if (this.disposed) {
			throw new Error('The chat closed.');
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
	private async runTurn(text: string, attachments: readonly Attachment[], expand: boolean, steer = false, reactions: readonly ReactionRequest[] = [], extras: PromptExtras = {}): Promise<TurnOutcome> {
		this.turnRunning = true;
		this.checkpoints.beginTurn();
		this.setBusy(true);
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
			if (attachments.some(attachment => attachment.kind === 'document' && attachment.tool === 'figma')) {
				const design = await this.options.designSystemNote?.().catch(() => undefined);
				if (design) {
					content.push({ type: 'text', text: design });
				}
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
			promptAt = this.transcript.items.length;
			const { stopReason, usage } = await this.promptRecovering(content);
			delivered = true;
			this.checkpoints.noteDelivered();
			if (context === this.pendingContext) {
				this.pendingContext = undefined;
			}
			this.sessions.delivered(carried);
			// Stopped to steer: no "Stopped." notice, since the agent carries on with the messages at once.
			const steered = stopReason === 'cancelled' && this.steerStopping && this.queue.hasSteer;
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
			this.setSteerWaiting(false);
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
		// Sent once the agent took the prompt: it answered, or the turn got as far as the model's output before failing.
		// A turn that failed before that, or overflowed (its prompt goes back in the box), never went.
		extras.settle?.(!overflowed && (delivered || (promptAt !== undefined && this.transcript.items.slice(promptAt).some(item => item.kind === 'agent' || item.kind === 'thought' || item.kind === 'toolCall'))));
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
			this.queue.holdSteers();
			this.queue.dropAwaited();
			this.postQueue();
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
			await this.send(next.text, next.attachments, undefined, undefined, next);
			return;
		}
		this.transcript.addPrompt(next.text, next.attachments, next.from, (next.reactions ?? []).map(reactionRef));
		if (next.text.trim()) {
			this.onDidSendPromptEmitter.fire(next.text);
		}
		this.lastPrompt = next;
		await this.runTurn(next.text, next.attachments, true, outcome === 'steer', next.reactions, next);
	}

	/** Stops the turn for the messages sent now, once no tool is running; a running tool's end calls this again. */
	private trySteer(): void {
		// While the session still opens there is no turn to stop: the messages go when it ends.
		if (!this.busy || this.quiet || this.steerStopping || !this.queue.hasSteer || this.turnWait) {
			return;
		}
		const waiting = this.service.permissions.pendingPermissions.length > 0;
		if (!atSafePoint(this.transcript.items, waiting)) {
			// A long tool chain may not reach one for a while: the queue then offers Stop Now.
			this.steerWaitTimer ??= setTimeout(() => {
				this.steerWaitTimer = undefined;
				if (this.busy && this.queue.hasSteer && !this.steerStopping) {
					this.setSteerWaiting(true);
				}
			}, steerWaitMs);
			return;
		}
		this.stopForSteer();
	}

	/** Stops the turn for the messages sent now; Stop Now does it without waiting for a safe point. */
	private stopForSteer(): void {
		this.setSteerWaiting(false);
		this.steerStopping = true;
		void this.service.cancel();
	}

	private setSteerWaiting(waiting: boolean): void {
		if (!waiting) {
			clearTimeout(this.steerWaitTimer);
			this.steerWaitTimer = undefined;
		}
		if (this.steerWaiting !== waiting) {
			this.steerWaiting = waiting;
			this.post({ type: 'steerWaiting', waiting });
		}
	}

	private postQueue(): void {
		this.post({ type: 'queue', items: this.queue.view });
	}

	/** A pending message's buttons in the composer. */
	private queueAction(id: string, action: 'send' | 'edit' | 'remove' | 'stopNow'): void {
		if (action === 'stopNow') {
			// As `trySteer`: no turn to stop while the session opens, nor a quiet one.
			if (this.busy && !this.quiet && !this.turnWait && this.queue.hasSteer && !this.steerStopping) {
				this.stopForSteer();
			}
			return;
		}
		if (action === 'send') {
			if (!this.busy) {
				const prompt = this.queue.remove(id);
				this.postQueue();
				if (prompt?.reactions?.length) {
					void this.startPrompt(prompt.text, prompt.attachments, prompt.from, prompt.reactions);
				} else if (prompt) {
					void this.send(prompt.text, prompt.attachments, prompt.from, undefined, prompt);
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
		prompt?.settle?.(false);
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
	private async continueAfterOverflow(prompt: string | undefined, reason: 'overflow' | 'refused' = 'overflow'): Promise<void> {
		const sessionId = this.sessions.current();
		const conversation = sessionId ? await readCliConversation(this.service.client.cwd, sessionId).catch(() => undefined) : undefined;
		this.setBusy(true);
		try {
			// Moving on on purpose: not the agent losing the session.
			this.sessions.moveTo(undefined);
			await this.service.client.newSession();
			this.options.project?.sessionReplaced();
		} catch (err) {
			this.transcript.addNotice(reason === 'refused'
				? vscode.l10n.t("A new session could not start: {0} Start a new chat to carry on.", this.turnError(err).text)
				: vscode.l10n.t("Gemini's context for this chat is full, and a new session could not start: {0} Start a new chat to carry on.", this.turnError(err).text), 'error');
			return;
		} finally {
			this.setBusy(false);
		}
		const carried = this.sessions.carry('this chat', conversation);
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
		const id = this.transcript.addTurnEnd(durationMs, usage);
		const { files, undoable } = this.checkpoints.endTurn(id);
		if (files && !unfinished && !this.options.project) {
			void this.noteErrors();
		}
		const build = this.planBuild(usage);
		const planFile = build && this.options.reviewPlan ? this.turnPlanFile : undefined;
		this.turnPlanFile = undefined;
		this.transcript.updateTurnEnd(id, { retry: !this.options.project && !steered, ...(files ? { files } : {}), ...(undoable ? { undo: 'available' } : {}), ...(build ? { buildPlan: true, build } : {}), ...(unfinished ? { unfinished } : {}), ...(steered ? { steered } : {}), ...(planFile ? { planFile } : {}) });
		this.retryItemId = id;
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

	/** Switches a session in Plan mode to Default, as a project's coordinator needs before each wake. */
	async leavePlanMode(): Promise<void> {
		const mode = buildModeAfterPlan(this.service.client.settings);
		if (mode) {
			await this.settings.change(() => this.service.client.setMode(mode));
		}
	}

	/** Opens the side question panel (⌥⌘;): ask about the chat while the agent keeps working. */
	openSide(): void {
		this.side.open();
	}

	/**
	 * Switches to the next approval mode, as the CLI's ⇧Tab does; the
	 * composer's mode chip shows it. A project's coordinator has no modes to pick.
	 */
	cycleMode(): void {
		const next = this.options.project ? undefined : nextApprovalMode(this.service.client.settings);
		if (!next) {
			return;
		}
		this.settings.onMessage({ type: 'setMode', id: next });
	}

	/** Picks the session's model in a quick pick, as the composer's model picker does. */
	async pickModel(): Promise<void> {
		const model = this.service.client.settings.model;
		if (!model) {
			void vscode.window.showInformationMessage(vscode.l10n.t("This agent offers no other model."));
			return;
		}
		const picked = await vscode.window.showQuickPick(model.available.map(choice => ({
			label: choice.name,
			description: choice.id === model.currentId ? vscode.l10n.t("Current") : undefined,
			detail: choice.description,
			id: choice.id,
		})), { title: vscode.l10n.t("Switch Model"), placeHolder: vscode.l10n.t("The model this agent's next prompts use") });
		if (picked && picked.id !== model.currentId) {
			this.settings.onMessage({ type: 'setModel', id: picked.id });
		}
	}

	/**
	 * How Build This Plan builds, while the chat is in Plan mode: in the mode
	 * the chat was in before Plan, with the other choice on its chevron, and the
	 * models when the build's differs from the plan's (`planUsage`, the plan
	 * turn's token counts).
	 */
	private planBuild(planUsage?: readonly ModelTokens[]): TurnEndBuild | undefined {
		const settings = this.service.client.settings;
		const choice = planBuildChoice(settings, this.settings.modeBeforePlan);
		if (!choice) {
			return undefined;
		}
		const models = planBuildModels(planUsage, settings.model?.currentId);
		return { ...choice, ...models ? { models } : {} };
	}

	/** The latest turn's Build This Plan, again: the model or the modes changed since the turn ended. */
	private refreshPlanBuild(): void {
		const item = this.transcript.items.find(each => each.id === this.retryItemId);
		if (item?.kind !== 'turnEnd' || !item.buildPlan) {
			return;
		}
		const build = this.planBuild(item.usage);
		if (JSON.stringify(build) !== JSON.stringify(item.build)) {
			this.transcript.updateTurnEnd(item.id, build ? { buildPlan: true, build } : { buildPlan: undefined, build: undefined });
		}
	}

	/** Leaves Plan mode and asks the agent to carry out the plan it just wrote: in `picked` (the chevron's other choice), else the mode before Plan. */
	private async buildPlan(itemId: string, picked?: string, text = vscode.l10n.t("Carry out the plan above.")): Promise<boolean> {
		const choice = this.planBuild();
		const mode = picked && (picked === choice?.mode || picked === choice?.other) ? picked : choice?.mode;
		if (this.busy || itemId !== this.retryItemId || !mode) {
			return false;
		}
		const item = this.transcript.items.find(each => each.id === itemId);
		if (item?.kind === 'turnEnd' && item.planFile) {
			// The agent reads its plan to carry it out.
			await this.rebuildPlan(item.planFile);
		}
		await this.settings.change(() => this.service.client.setMode(mode));
		if (this.service.client.settings.mode?.currentId === mode) {
			await this.send(text);
			return true;
		}
		return false;
	}

	/** Whether the latest turn ended in Plan mode and offers Build This Plan, for Plan Review. */
	get canBuildPlan(): boolean {
		const item = this.retryItemId ? this.transcript.items.find(each => each.id === this.retryItemId) : undefined;
		return !this.busy && item?.kind === 'turnEnd' && !!item.buildPlan;
	}

	/** Build This Plan on the latest turn, from Plan Review, telling the agent `text`; resolves whether it started. */
	buildLatestPlan(text: string): Promise<boolean> {
		return this.canBuildPlan && this.retryItemId ? this.buildPlan(this.retryItemId, undefined, text) : Promise.resolve(false);
	}

	/**
	 * Writes plan `file` again when the CLI deleted it, as it did on reopening
	 * a session before GeminiCode kept sessions' plans (src/acp/sessionFolder.ts):
	 * from Plan Review's copy, else the session's saved calls (sessionReplay.ts).
	 */
	private async rebuildPlan(file: string): Promise<void> {
		const home = cliHome();
		const cwd = this.service.client.cwd;
		if (file.startsWith(path.join(home, projectTempDirName) + path.sep) && !await isFile(file)) {
			const rebuilt = await extensionChunk<typeof import('../onDemand')>('onDemand')().rebuildSessionFile(cwd, file, {
				home,
				folder: id => sessionFolder(cwd, id, home),
				messages: async id => (await readSessionMessages(cwd, id, home))?.messages,
				reviews: this.options.planReviewFolder,
			}).catch(() => undefined);
			if (rebuilt === 'history') {
				this.transcript.addNotice(vscode.l10n.t("The plan file was gone, so it was rebuilt from the session's history. It may differ a little from the one the agent wrote."), 'info');
			}
		}
	}

	/** Plan mode's plan, opened from its chip: in Plan Review when there is one; false otherwise. */
	private reviewPlanFile(file: string): boolean {
		if (!this.options.reviewPlan || this.service.client.settings.mode?.currentId !== 'plan') {
			return false;
		}
		this.options.reviewPlan(file);
		return true;
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
			// The chat is cleared either way; the next prompt opens a new session (the old one is never reopened).
			this.transcript.addNotice(vscode.l10n.t("A new session could not start: {0}", this.turnError(err).text), 'error');
		} finally {
			this.setBusy(false);
		}
	}

	/** The plain-words notice for a failed turn or session, from the error it failed with. */
	private turnError(err: unknown): TurnErrorNotice {
		return turnErrorNotice(classifyTurnError(err, { model: this.service.client.settings.model?.currentId }));
	}

	/**
	 * The latest failed turn's notice and its ways out (Retry, Switch Model,
	 * Sign In, Show Log), until the next turn starts; for the notice's buttons.
	 */
	get lastTurnError(): TurnErrorNotice | undefined {
		return this._lastTurnError;
	}

	/**
	 * Stops the running turn, as the Stop button does: one still waiting for
	 * its session ends at once, without sending; messages sent now wait.
	 */
	stop(): void {
		this.steerStopping = false;
		this.setSteerWaiting(false);
		if (this.queue.hasSteer) {
			this.queue.holdSteers();
			this.postQueue();
		}
		this.turnWait?.abort();
		void this.service.cancel();
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
		this.disposed = true;
		this.turnWait?.abort();
		clearTimeout(this.steerWaitTimer);
		this.queue.clear();
		for (const done of [...this.onDispose]) {
			done();
		}
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
				// Before the items, so their shell blocks show Run, and the empty chat's hints the keys, as they are drawn.
				this.post({ type: 'sendWith', cmdEnter: sendsWithCmdEnter() });
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
				this.post({ type: 'triedEdits', files: this.triedEdits });
				this.usage.onReady();
				this.git.refresh();
				void this.sharedPage.refresh();
				this.sideLinks.refresh();
				void this.attachments.postToolRefs();
				// The agent was started with the view (see attach); this retries one that has since stopped.
				this.service.ensureReady().catch(() => undefined);
				// After starting the agent: finding the theme's file scans every extension the first time.
				setTimeout(() => void this.postTokenColors(), 0);
				break;
			case 'prompt':
				void this.send(message.text, message.attachments ?? [], undefined, message.when, { includeEdits: !!message.includeEdits });
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
				this.stop();
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
				void this.buildPlan(message.itemId, typeof message.mode === 'string' ? message.mode : undefined);
				break;
			case 'reviewPlan': {
				const item = this.transcript.items.find(each => each.id === message.itemId);
				if (item?.kind === 'turnEnd' && item.planFile) {
					const file = item.planFile;
					void this.rebuildPlan(file).then(() => this.options.reviewPlan?.(file));
				}
				break;
			}
			case 'listCommands':
				void this.commands.postCommands();
				break;
			case 'permission':
				this.permissions.onMessage(message);
				break;
			case 'noticeAction':
				this.noticeAction(message.itemId, message.action);
				break;
			case 'showOutput':
				this.post({ type: 'output', itemId: message.itemId, part: message.part, text: this.files.outputs.get(message.itemId, message.part) });
				break;
			case 'showAgentChanges':
				this.options.sharedFiles?.show(message.agent);
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
			case 'attachMention':
				this.attachments.onMessage(message);
				break;
			case 'stopSharing':
			case 'openSharedPage':
				this.sharedPage.onMessage(message);
				break;
			case 'openSideLink':
				this.sideLinks.onMessage(message);
				break;
			case 'setFollow':
			case 'showFollowed':
			case 'closeFollowed':
				this.follow.onMessage(message);
				break;
			case 'listBranches':
			case 'switchBranch':
			case 'createBranchAndCommit':
			case 'writeCommitMessage':
			case 'commitToBranch':
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
			case 'sideAsk':
			case 'sideCancel':
				this.side.onMessage(message);
				break;
			case 'researchStop':
			case 'researchUse':
				this.research.onMessage(message);
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
			case 'setPlanFirst':
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
			case 'measureContext':
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
		const stall = this.viewStall(this.service.client.stall);
		this.post({ type: 'reset', items: this.transcript.items, busy: this.busy, status: toViewStatus(this.service.status), settings: this.service.client.settings, ...stall ? { stall } : {} });
		this.project.postReset();
		if (!this.busy) {
			void this.sessions.postSessions();
		}
		void this.usage.postContext();
	}

	/** The stall notice for the chat, while its own turn (not a quiet one, such as Compact's) stalls. */
	private viewStall(stall: TurnStall | undefined): ViewStall | undefined {
		return stall && this.busy && !this.quiet ? stallNotice(stall) : undefined;
	}

	/** A failed or cut-short turn's Retry or Continue, from its notice, while that notice still offers it. */
	/** After a turn that changed files: a notice when the language servers report errors in them, offering Fix. */
	private async noteErrors(): Promise<void> {
		const text = await this.options.errorsAfterTurn?.().catch(() => undefined);
		if (text && !this.busy) {
			this.transcript.addNotice(text, 'info', ['fixErrors']);
		}
	}

	private noticeAction(itemId: string, action: 'retry' | 'continue' | 'newSession' | 'fixErrors'): void {
		const notice = this.busy ? undefined : this.transcript.noticeOffering(itemId, action);
		if (!notice) {
			return;
		}
		if (action === 'fixErrors') {
			void this.send(`Fix these errors in the files you changed, then check again with code_diagnostics:\n${notice.text.split('\n').slice(1).join('\n')}`);
		} else if (action === 'newSession') {
			void this.continueAfterOverflow(this.lastPrompt?.text, 'refused');
		} else if (action === 'continue') {
			// Carries on where the request limit stopped the turn, as the CLI's own "continue" does.
			void this.send('Continue.');
		} else if (this.lastPrompt?.reactions) {
			void this.startPrompt(this.lastPrompt.text, this.lastPrompt.attachments, undefined, this.lastPrompt.reactions);
		} else if (this.lastPrompt) {
			// A session that failed to open is opened again first (`ensureReady`, `AgentClient.retryOpen`).
			void this.send(this.lastPrompt.text, this.lastPrompt.attachments);
		}
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
	ready?: number;
	sent?: number;
	/** The model's first output after the prompt was sent: a thought, a tool call, a plan or reply text. */
	firstToken?: number;
	/** The first reply text, which in an agentic turn often comes after every step. */
	firstText?: number;
}

/** What a turn end's Build This Plan offers. */
type TurnEndBuild = NonNullable<Extract<TranscriptItem, { readonly kind: 'turnEnd' }>['build']>;

/** What the transcript keeps of a reaction sent with a prompt. */
function reactionRef({ turnEnd, emoji, name }: ReactionRequest): ReactionRef {
	return { ...(turnEnd ? { turnEnd } : {}), emoji, name };
}

/** Whether the CLI applies edits in mode `mode` without a card: Auto Edit and YOLO. */
function editsWithoutCards(mode: string | undefined): boolean {
	return mode === 'autoEdit' || mode === 'yolo';
}

/** Gemini refused a turn's request after a tool result, and again when asked to carry on: the session likely refuses every later request. */
class RefusedAgainError extends Error { }

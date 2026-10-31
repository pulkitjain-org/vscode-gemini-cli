/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sideQuestionOf } from '../acp/sideChat';
import { ChatSide, sideCommand } from './chat/chatSide';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { onDidChangeFoldWork } from './foldWork';
import type { Attachment } from '../acp/attachments';
import { isValidAttachment } from '../acp/attachmentValidation';
import { chatToMarkdown } from '../acp/chatMarkdown';
import { ChatTranscript, ForkContext, ThreadCard, TranscriptItem } from '../acp/chatTranscript';
import { lastPromptAt, runningStep, wasCutOff } from '../acp/chatTurns';
import type { StoredCheckpoints } from '../acp/checkpoints';
import { permissionsCommand, planCommand, rewindCommand } from './chat/cliCommands';
import { type PromptExtras } from '../acp/promptQueue';
import { reactionShortcut } from '../acp/reactions';
import { ConversationEntry } from '../acp/cliSessions';
import { TextDeltas } from '../acp/textDeltas';
import { UpdateBatcher } from '../acp/updateBatcher';
import { type TurnStall } from '../acp/agentClient';
import { chatProtocolVersion, FromWebview, ProjectPanel, ProjectRepoView, ProjectSettingsView, ToWebview, type ViewStall } from './chatProtocol';
import type { DebugBarView } from './debug/debugProtocol';
import { stallNotice, toViewStatus, type TurnErrorNotice } from './chatStatus';
import type { DiffPreview } from './diffPreview';
import { onDidChangeReactions, reactionsOn } from './chatReactions';
import { preferredComposerHeight } from './modelPreference';
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
import { ChatPlan } from './chat/chatPlan';
import { ChatProjectView } from './chat/chatProject';
import { ChatQueue } from './chat/chatQueue';
import { ChatReactions } from './chat/chatReactions';
import { chatRouter } from './chat/chatRouter';
import { ChatRun } from './chat/chatRun';
import { ChatSessions, chatCommand, resumeCommand } from './chat/chatSessions';
import { ChatSettings, onDidChangeSendWith, sendsWithCmdEnter } from './chat/chatSettings';
import { SharedPageChip } from './chat/chatSharedPage';
import { SideLinksColumn } from './chat/chatSideLinks';
import { ChatTurn } from './chat/chatTurn';
import { ChatUsage, contextCommand, statsCommand } from './chat/chatUsage';

export type { ChatControllerOptions, ChatEnhancer, ChatGit, ChatHost, ChatProject, ChatSharedPage, ChatTerminal, ChatWorkspace, FileSearch } from './chat/chatOptions';

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
/** How often a burst of transcript updates reaches the view: at a frame's pace while it shows, rarely while it is hidden. */
const visibleBatchMs = 32;
const hiddenBatchMs = 500;

export class ChatController implements vscode.Disposable {

	private readonly transcript = new ChatTranscript();
	/** Streams item changes to the webview at most about 30 times a second. */
	private readonly textDeltas = new TextDeltas();
	private readonly items = new UpdateBatcher<TranscriptItem>(items => this.post({ type: 'items', items: this.textDeltas.toUpdates(items) }), visibleBatchMs);
	private readonly disposables: vscode.Disposable[] = [];
	private webview: vscode.Webview | undefined;
	private webviewListener: vscode.Disposable | undefined;
	private busy = false;
	/** While a turn runs whose updates stay out of the transcript, such as Compact's summary. */
	private quiet = false;
	/** When the running turn started, for the Agents side bar's clock. */
	private turnStartedAt: number | undefined;
	/** The step last reported, so tool call updates report only a new one. */
	private lastStep: string | undefined;
	/** Debug mode's bar, while the agent is in it. */
	private debugView: DebugBarView | undefined;

	/** The saved chat being read in, while it is: prompts wait for it, so neither replaces the other. */
	private restoring: Promise<void> | undefined;
	/** Whether the view's script has said it is ready since the view was attached. */
	private viewReady = false;
	/** Opens a session waiting for the chat to show, if the view does not say it is shown. */
	private openTimer: ReturnType<typeof setTimeout> | undefined;

	private disposed = false;
	/** Called on dispose, so waits on this chat end. */
	private readonly onDispose = new Set<() => void>();
	private readonly onDidChangeActivityEmitter = new vscode.EventEmitter<ChatActivity>();
	readonly onDidChangeActivity = this.onDidChangeActivityEmitter.event;

	private readonly onDidEditFilesEmitter = new vscode.EventEmitter<readonly acp.Diff[]>();
	/** The edits of each tool call that completed, once per tool call. */
	readonly onDidEditFiles = this.onDidEditFilesEmitter.event;

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
	private readonly project: ChatProjectView;
	private readonly runs: ChatRun;
	/** Plan mode's plan and Approve Plan. */
	private readonly plan: ChatPlan;
	/** Messages sent while the agent works: queued for after the turn, or steering it at its next safe point. */
	private readonly queue: ChatQueue;
	/** A prompt's turn, from its send to its end line. */
	private readonly turn: ChatTurn;
	private readonly reactions: ChatReactions;
	/** Routes the view's messages to the features. */
	private readonly route: (message: FromWebview) => void;

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
		this.files = new ChatFileLinks(diffPreview, () => options.git?.folder() ?? client.cwd, options, file => this.plan.reviewPlanFile(file), file => this.plan.rebuildPlan(file));
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
		this.sessions = new ChatSessions(service, this.transcript, options, {
			isBusy,
			setBusy,
			clearConversation: () => this.clearConversation(),
			restored: title => this.onDidRestoreSessionEmitter.fire(title),
			fireActivity: () => this.fireActivity(),
			turnError: err => this.turn.turnError(err),
		}, isAttached, post);
		this.checkpoints = new ChatCheckpoints(service, this.transcript, this.sessions, options, {
			isBusy,
			setBusy,
			restoredFiles: diffs => this.onDidEditFilesEmitter.fire(diffs),
			rewound: text => {
				this.turn.forgetLastPrompt();
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
		this.project = new ChatProjectView(options, isViewReady, post);
		this.runs = new ChatRun(options, isAttached, post, attachments => void this.addAttachments(attachments),
			() => this.transcript.items.flatMap(item => item.kind === 'agent' || item.kind === 'user' ? [item.text] : []));
		this.plan = new ChatPlan(service, this.transcript, this.settings, options, {
			isBusy,
			retryItemId: () => this.turn.retryItemId,
			send: text => this.send(text),
			startPrompt: text => this.turn.startPrompt(text, []),
		});
		// The CLI's own names first (/resume and /chat, /rewind, /plan, /compress, /context and /stats, /permissions), then GeminiCode's own.
		this.commands = new ChatCommands(client, this.transcript, [...options.savedSessions ? [resumeCommand(), chatCommand()] : [], rewindCommand(), planCommand(), compactCommand(), contextCommand(), statsCommand(), permissionsCommand(), sideCommand(), ...options.fork ? [forkCommand()] : []], isAttached, post,
			options, { sessions: this.sessions, compacting: this.compacting, usage: this.usage, checkpoints: this.checkpoints, plan: this.plan, forks: this.forks }, folder => service.askToTrust(folder));
		this.queue = new ChatQueue(service, this.transcript, this.attachments, options, {
			isBusy,
			setBusy,
			isQuiet: () => this.quiet,
			turnWaiting: () => this.turn.waiting,
			send: (text, attachments, from, when, extras) => this.send(text, attachments, from, when, extras),
			startPrompt: (text, attachments, from, reactions) => this.turn.startPrompt(text, attachments, from, reactions),
			runNext: (next, steer) => this.turn.runNext(next, steer),
		}, post);
		const features = {
			files: this.files, permissions: this.permissions, follow: this.follow, git: this.git, usage: this.usage, attachments: this.attachments,
			sharedPage: this.sharedPage, sideLinks: this.sideLinks, settings: this.settings, enhance: this.enhance, commands: this.commands, sessions: this.sessions,
			checkpoints: this.checkpoints, compacting: this.compacting, forks: this.forks, side: this.side, project: this.project, runs: this.runs, plan: this.plan, queue: this.queue,
		};
		this.turn = new ChatTurn(service, this.transcript, options, features, {
			isBusy,
			setBusy,
			isQuiet: () => this.quiet,
			promptSent: text => this.onDidSendPromptEmitter.fire(text),
			editedFiles: diffs => this.onDidEditFilesEmitter.fire(diffs),
			toolCallStep: () => {
				if (this.activity.step !== this.lastStep) {
					this.fireActivity();
				}
			},
			restoring: () => this.restoring,
			isDisposed: () => this.disposed,
			untilNotBusy: () => this.untilNotBusy(),
		}, post);
		this.reactions = new ChatReactions(this.transcript, options, this.turn, this.queue, this.plan, {
			isBusy,
			restoring: () => this.restoring,
		}, post);
		this.route = chatRouter(service, this.transcript, options, { ...features, reactions: this.reactions, turn: this.turn }, {
			isBusy,
			ready: message => this.onReady(message),
			send: (text, attachments, from, when, extras) => this.send(text, attachments, from, when, extras),
			stop: () => this.stop(),
			post,
		});
		this.disposables.push(
			onDidChangeFoldWork(on => this.post({ type: 'foldWork', on })),
			onDidChangeReactions(() => this.reactions.postReactions()),
			onDidChangeSendWith(cmdEnter => this.post({ type: 'sendWith', cmdEnter })),
			// The build's model may have changed since the plan: Approve Plan's hint follows.
			client.onDidChangeSettings(() => this.plan.refreshBuild()),
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
			this.commands,
			this.sessions,
			this.runs,
			this.usage,
			service.permissions.onDidChange(event => {
				this.permissions.apply(event);
				this.fireActivity();
				this.queue.trySteer();
			}),
			this.transcript,
			this.sideLinks,
			this.transcript.onDidChangeItem(item => this.items.push(item)),
			{ dispose: () => this.items.dispose() },
			this.transcript.onDidReset(() => this.postReset()),
			client.onDidAllowInYolo(params => service.writeLog?.(`Allowed "${params.toolCall.title ?? params.toolCall.toolCallId}" at once: the chat is in YOLO mode`)),
			client.onDidReceiveEvent(event => this.turn.onEvent(event)),
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
		// Hidden, the view renders nothing anyone sees: a burst of updates goes every half second, and the whole state follows when it shows.
		this.items.setInterval(hidden ? hiddenBatchMs : visibleBatchMs);
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
	approvePlan(): Promise<boolean> {
		return this.plan.approvePlan();
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
		// `+` and one emoji alone reacts to the latest reply instead of being sent.
		const shortcut = !project && !from && !attachments.length && reactionsOn() ? reactionShortcut(text) : undefined;
		const latest = shortcut && this.transcript.items.findLast(item => item.kind === 'turnEnd');
		if (shortcut && latest) {
			extras.settle?.(true);
			this.reactions.react(latest.id, shortcut, shortcut);
			return;
		}
		if (project) {
			if (this.busy) {
				// The coordinator is working: the message waits for its turn to end, never stopping it.
				this.queue.holdForCoordinator(text, attachments, extras);
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
			this.queue.holdOrSteer(text, attachments, from, when, extras);
			return;
		}
		if (extras.settle) {
			// Plan Review's message, never a command.
			return this.turn.startPrompt(text, attachments, from, [], extras);
		}
		if (await this.commands.run(text, attachments)) {
			return;
		}
		await this.turn.startPrompt(text, attachments, from, [], extras);
	}

	/** The agent's tried files the user edited and hasn't sent it (agentTries.ts): the message box offers to include them. */
	setTriedEdits(files: readonly string[]): void {
		this.turn.setTriedEdits(files);
	}

	/** The chat is busy copying the user's edits for its own turn: Send My Edits' busy check lets that through. */
	get includingEdits(): boolean {
		return this.turn.includingEdits;
	}

	/** Sends `text` to the agent ahead of the next prompt, without showing it in the chat. */
	addContext(text: string): void {
		this.turn.addContext(text);
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
	sendUnseen(text: string): Promise<void> {
		return this.turn.sendUnseen(text);
	}

	/** Settles when the chat is no longer busy, or is disposed. */
	private untilNotBusy(): Promise<void> {
		return new Promise<void>(resolve => {
			const done = () => {
				listener.dispose();
				this.onDispose.delete(done);
				resolve();
			};
			const listener = this.onDidChangeActivity(activity => !activity.busy && done());
			this.onDispose.add(done);
		});
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

	/** Switches a session in Plan mode to Default, as a project's coordinator needs before each wake. */
	leavePlanMode(): Promise<void> {
		return this.plan.leavePlanMode();
	}

	/** Opens the side question panel (Alt+Cmd+;): ask about the chat while the agent keeps working. */
	openSide(): void {
		this.side.open();
	}

	/**
	 * Switches to the next approval mode, as the CLI's Shift+Tab does; the
	 * composer's mode chip shows it. A project's coordinator has no modes to pick.
	 */
	cycleMode(): void {
		this.settings.cycleMode(this.busy);
	}

	/** Switches to YOLO, or back to the mode before it, as the CLI's Ctrl+Y does; nothing where policy or the agent offers no YOLO. */
	toggleYolo(): void {
		this.settings.toggleYolo();
	}

	/** Picks the session's model in a quick pick, as the composer's model picker does. */
	pickModel(): Promise<void> {
		return this.settings.pickModel();
	}

	/** Whether the latest turn ended in Plan mode and offers Approve Plan, for Plan Review. */
	get canBuildPlan(): boolean {
		return this.plan.canBuildPlan;
	}

	/** Approve Plan on the latest turn, from Plan Review, telling the agent `text`; resolves whether it started. */
	buildLatestPlan(text: string): Promise<boolean> {
		return this.plan.buildLatestPlan(text);
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

	/** The session's approval mode, when known. */
	get mode(): string | undefined {
		return this.service.client.settings.mode?.currentId;
	}

	/** The open session's id, which the agent's file requests carry. */
	get sessionId(): string | undefined {
		const state = this.service.client.state;
		return state.kind === 'ready' ? state.sessionId : undefined;
	}

	/** Debug mode's bar and cards; kept, so a view attached again shows them. */
	postDebug(view: DebugBarView | undefined): void {
		this.debugView = view;
		this.post({ type: 'debug', view });
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
	newChat(): Promise<void> {
		return this.sessions.newChat();
	}

	/**
	 * The latest failed turn's notice and its ways out (Retry, Switch Model,
	 * Sign In, Show Log), until the next turn starts; for the notice's buttons.
	 */
	get lastTurnError(): TurnErrorNotice | undefined {
		return this.turn.lastTurnError;
	}

	/**
	 * Stops the running turn, as the Stop button does: one still waiting for
	 * its session ends at once, without sending; messages sent now wait.
	 */
	stop(): void {
		this.queue.stopped();
		this.turn.abortWait();
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
		this.turn.abortWait();
		this.queue.dispose();
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
		this.route(message);
	}

	/** The view's script is ready: sends it everything the chat shows. */
	private onReady(message: Extract<FromWebview, { readonly type: 'ready' }>): void {
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
		this.queue.postQueue();
		this.reactions.postReactions();
		this.post({ type: 'triedEdits', files: this.turn.triedEdits });
		this.usage.onReady();
		this.git.refresh();
		void this.sharedPage.refresh();
		this.sideLinks.refresh();
		void this.attachments.postToolRefs();
		// The agent was started with the view (see attach); this retries one that has since stopped.
		this.service.ensureReady().catch(() => undefined);
		// After starting the agent: finding the theme's file scans every extension the first time.
		setTimeout(() => void this.postTokenColors(), 0);
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
		this.files.clear();
		this.turn.forgetCompletedToolCalls();
		this.checkpoints.clear();
		this.turn.forgetLastPrompt();
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
		if (finished && !this.turn.running && this.queue.pending.length) {
			// Messages sent during other work, such as Compact, go once it is done.
			setTimeout(() => void this.queue.sendPending('done'), 0);
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
		this.postTeamTools();
		if (this.debugView) {
			this.post({ type: 'debug', view: this.debugView });
		}
	}

	/** Tells the view whether the team tools are on offer in its + menu, on for this agent, or not connected. */
	postTeamTools(): void {
		const tools = this.options.teamTools;
		this.post({ type: 'teamTools', state: !tools?.available() ? 'none' : tools.enabled() ? 'on' : 'available' });
	}

	/** The stall notice for the chat, while its own turn (not a quiet one, such as Compact's) stalls. */
	private viewStall(stall: TurnStall | undefined): ViewStall | undefined {
		return stall && this.busy && !this.quiet ? stallNotice(stall) : undefined;
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

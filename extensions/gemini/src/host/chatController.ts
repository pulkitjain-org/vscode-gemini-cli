/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { Attachment, attachmentLabel } from '../acp/attachments';
import { isValidAttachment } from '../acp/attachmentValidation';
import { chatToMarkdown } from '../acp/chatMarkdown';
import { ChatTranscript, toolCallItemId, TranscriptItem } from '../acp/chatTranscript';
import { Checkpoints } from '../acp/checkpoints';
import { isInside, secretPathReason } from '../acp/fileAccess';
import { FollowTarget, FollowTracker } from '../acp/follow';
import { PendingPermission, PermissionBroker } from '../acp/permissions';
import { buildPromptContent } from '../acp/promptContent';
import { skillPrompt } from '../acp/skills';
import { expandTeamCommand, mergeCommands, parseInvocation, SlashCommand } from '../acp/slashCommands';
import { CliSession, isPrompt, listCliSessions, readSessionTokens } from '../acp/cliSessions';
import type { ChatEvent } from '../acp/sessionUpdates';
import { AgentStatus } from '../acp/status';
import { TextDeltas } from '../acp/textDeltas';
import type { ModelTokens } from '../acp/turnUsage';
import { UpdateBatcher } from '../acp/updateBatcher';
import type { AgentClient } from '../acp/agentClient';
import { AgentError, errorMessage } from '../acp/errors';
import { readGitHead } from '../acp/gitHead';
import { EnhanceCancelledError, enhanceHistory } from '../acp/promptEnhancer';
import type { EnhancePromptInput } from '../acp/quickPrompts';
import { ChatStrings, chatProtocolVersion, FromWebview, statusCommands, ToWebview } from './chatProtocol';
import { stopReasonNotice, toViewStatus } from './chatStatus';
import { chatFontSize, onDidChangeChatFontSize } from './chatFont';
import { DiffPreview } from './diffPreview';
import { relativeTime, tildify } from './displayText';
import { attachmentsForFiles } from './addToChat';
import { createBranchAndCommit, pickBranch } from './gitActions';
import { preferredComposerHeight, rememberComposerHeight, rememberModel } from './modelPreference';
import { skills, teamCommands } from './teamCommands';
import { onDidChangeThemeTokens, themeTokenColors } from './themeTokens';
import type { UsageMeter } from './usageMeter';
import { createNonce, escapeAttribute } from './webviewHtml';
import type { FileMatch } from './workspaceFiles';
import { deleteFile, replaceFileText, WorkspaceFileSystem } from './workspaceFileSystem';

/**
 * Every current Gemini model's context window, in tokens, as gemini-cli's
 * `tokenLimit` has it; the CLI's footer shows context use against it too.
 */
const contextWindow = 1_048_576;

/** The agent session a chat talks to: the sidebar's, or one agent's in the Agents pane. */
export interface ChatHost {
	readonly client: AgentClient;
	/** This session's permission requests, answered in its chat. */
	readonly permissions: PermissionBroker;
	readonly status: AgentStatus;
	readonly onDidChangeStatus: vscode.Event<AgentStatus>;
	/** Starts the agent if needed and resolves once this session is ready. */
	ensureReady(): Promise<unknown>;
	/** Stops the current turn. */
	cancel(): Promise<void>;
	/** Trusts `folder` for the CLI and restarts the agent; returns whether the restart waits for running prompts. */
	trustFolder(folder: string): boolean;
}

/** The files the @-mention picker offers. */
export interface FileSearch {
	warm(): void;
	search(query: string, limit: number): Promise<readonly FileMatch[]>;
}

export interface ChatControllerOptions {
	/** Brings the chat into view, for example when the agent asks for permission. */
	reveal(preserveFocus: boolean): Promise<void>;
	/** A context key kept equal to whether a turn runs, for menus. */
	readonly busyContextKey?: string;
	/** The branch pill and Create Branch & Commit; without it the composer shows neither. */
	readonly git?: ChatGit;
	/** Where files and diffs open; unset opens them in the active editor group. */
	editorColumn?(): vscode.ViewColumn;
	/** Rewrites the composer's draft for Enhance prompt. */
	readonly enhancer: ChatEnhancer;
	/** The workspace pill; without it the composer shows none. */
	workspace?(): ChatWorkspace | undefined;
	/** Today's quota, for the usage popover; unset shows it as off. */
	usage?(): UsageMeter | undefined;
	/** Offers to reopen the CLI's saved sessions for the folder (and /resume); unset in chats that do not. */
	readonly savedSessions?: {
		/** Sessions other chats have open, which this one must not take. */
		inUse(): ReadonlySet<string>;
	};
}

export interface ChatWorkspace {
	/** The workspace folder, which names the pill. */
	readonly folder: string;
	/** Where the agent runs: the folder, or its place in the agent's own worktree. */
	readonly cwd: string;
	readonly worktree: boolean;
}

/** Rewrites drafts as precise prompts; one, shared by every chat. */
export interface ChatEnhancer {
	/** Gets a rewrite ready, so the next one only waits for the model. */
	prepare(): void;
	enhance(input: EnhancePromptInput, signal: AbortSignal): Promise<string>;
}

export interface ChatGit {
	/** The folder whose branch the chat shows; unset when there is none. */
	folder(): string | undefined;
	/** Create Branch & Commit, for chats that know which files their agent changed. */
	readonly commit?: {
		/** Absolute paths; empty hides the button. */
		files(): readonly string[];
		onDidChange(listener: () => void): { dispose(): void };
		suggestion(): { readonly branch: string; readonly message: string };
		/** The files were committed. */
		committed(): void;
	};
	/** Set for an agent on its own branch: the chat must not switch it, or Merge Back would miss the work. */
	readonly ownBranch?: string;
}

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
 * or closed.
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
	/** When the running turn started, for the Agents side bar's clock. */
	private turnStartedAt: number | undefined;
	/** The step last reported, so tool call updates report only a new one. */
	private lastStep: string | undefined;
	private lastSessionId: string | undefined;
	/** Proposed edits by transcript item id (tool calls and permission requests), so their diffs can be opened later. */
	private readonly diffs = new Map<string, readonly acp.Diff[]>();

	/** Show Usage and Quota ran before the view was ready; the popover opens once it is. */
	private usageRequested = false;
	/** Attachments from the Add to Chat commands that arrived before the view was ready. */
	private pendingAttachments: Attachment[] = [];

	/** What each recent turn's edits replaced, so a turn can be undone. */
	private readonly checkpoints: Checkpoints;
	/** The last prompt, for Retry. */
	private lastPrompt: { readonly text: string; readonly attachments: readonly Attachment[] } | undefined;
	/** The turnEnd item that offers Retry. */
	private retryItemId: string | undefined;
	/** Told to the agent with the next prompt: files the user put back, which it would otherwise think it changed. */
	private undoNote: string | undefined;
	/** The rewrite running for the composer, so it can be cancelled. */
	private enhancing: { readonly requestId: number; readonly abort: AbortController } | undefined;
	/** While a reopened session replays, its messages belong in the transcript. Ends with the next prompt. */
	private replaying = false;
	/** Follow the agent: open each file it reads or edits. Starts as the last chat left it. */
	private following = vscode.workspace.getConfiguration('gemini').get<boolean>('chat.followAgent', false);
	private readonly follow = new FollowTracker();
	/** The file to show next; files are shown at most every {@link followIntervalMs}, the latest winning. */
	private followTarget: FollowTarget | undefined;
	private followTimer: ReturnType<typeof setTimeout> | undefined;
	/** The file Follow the agent opened last, until its tab closes. */
	private followed: vscode.Uri | undefined;

	private readonly onDidChangeActivityEmitter = new vscode.EventEmitter<ChatActivity>();
	readonly onDidChangeActivity = this.onDidChangeActivityEmitter.event;

	private readonly onDidEditFilesEmitter = new vscode.EventEmitter<readonly acp.Diff[]>();
	/** The edits of each tool call that completed, once per tool call. */
	readonly onDidEditFiles = this.onDidEditFilesEmitter.event;
	private readonly completedToolCalls = new Set<string>();

	private readonly onDidRestoreSessionEmitter = new vscode.EventEmitter<string>();
	/** A saved session was reopened here; fires with its title. */
	readonly onDidRestoreSession = this.onDidRestoreSessionEmitter.event;

	private readonly onDidSendPromptEmitter = new vscode.EventEmitter<string>();
	/** The text of each prompt sent. */
	readonly onDidSendPrompt = this.onDidSendPromptEmitter.event;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly service: ChatHost,
		private readonly diffPreview: DiffPreview,
		private readonly fileIndex: FileSearch,
		private readonly options: ChatControllerOptions,
	) {
		this.checkpoints = new Checkpoints(service.client.cwd);
		this.disposables.push(
			this.onDidChangeActivityEmitter,
			this.onDidEditFilesEmitter,
			this.onDidSendPromptEmitter,
			this.onDidRestoreSessionEmitter,
			service.permissions.onDidChange(event => {
				if (event.kind === 'requested') {
					this.rememberDiffs(event.permission.id, diffsOf(event.permission.request.toolCall.content));
					this.transcript.addPermission(event.permission);
					void this.revealForPermission(event.permission);
				} else {
					this.transcript.resolvePermission(event.id, event.outcome);
				}
				this.fireActivity();
			}),
			this.transcript,
			this.transcript.onDidChangeItem(item => this.items.push(item)),
			{ dispose: () => this.items.dispose() },
			vscode.window.tabGroups.onDidChangeTabs(() => {
				if (this.followed && !followedTabs(this.followed).length) {
					this.followed = undefined;
					this.postFollowed();
				}
			}),
			this.transcript.onDidReset(() => this.postReset()),
			service.client.onDidReceiveEvent(event => {
				if (this.replaying) {
					this.applyReplayed(event);
					return;
				}
				// Only a turn's updates belong in the transcript.
				if (this.busy) {
					if (event.kind === 'toolCall') {
						const diffs = diffsOf(event.call.content);
						this.rememberDiffs(toolCallItemId(event.call.id), diffs);
						if (event.call.status === 'completed' && diffs.length && !this.completedToolCalls.has(event.call.id)) {
							this.completedToolCalls.add(event.call.id);
							dropOldest(this.completedToolCalls);
							this.checkpoints.record(diffs);
							this.onDidEditFilesEmitter.fire(diffs);
						}
					}
					this.transcript.apply(event);
					if (event.kind === 'toolCall' && this.following) {
						this.scheduleFollow(this.follow.next(event.call));
					}
					if (event.kind === 'toolCall' && this.activity.step !== this.lastStep) {
						this.fireActivity();
					}
				}
			}),
			service.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.post({ type: 'capabilities', image: service.client.promptCapabilities.image });
					if (this.lastSessionId && state.savedSessionId !== this.lastSessionId && this.transcript.items.length) {
						this.addSessionLostNotice();
					}
					this.lastSessionId = state.savedSessionId;
					void this.postContext();
				}
			}),
			service.onDidChangeStatus(status => this.post({ type: 'status', status: toViewStatus(status) })),
			// The branch may have changed outside the editor.
			vscode.window.onDidChangeWindowState(state => state.focused && this.webview && this.postGit()),
			service.client.onDidChangeSettings(settings => this.post({ type: 'settings', settings })),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('gemini.appearance.accent') && this.post({ type: 'accent', solid: solidAccent() })),
			onDidChangeThemeTokens(() => this.webview && void this.postTokenColors()),
			onDidChangeChatFontSize(size => this.post({ type: 'fontSize', size })),
			// Keeps an open "/" menu current; the agent lists its commands just after a session opens.
			service.client.onDidChangeCommands(() => this.webview && void this.postCommands()),
		);
		if (options.git?.commit) {
			this.disposables.push(options.git.commit.onDidChange(() => this.postGit()));
		}
	}

	get activity(): ChatActivity {
		const [permission] = this.service.permissions.pendingPermissions;
		const step = permission ? permission.request.toolCall.title ?? undefined : this.busy ? this.runningStep() : undefined;
		return { busy: this.busy, needsPermission: !!permission, ...(step ? { step } : {}), ...(this.busy && this.turnStartedAt !== undefined ? { startedAt: this.turnStartedAt } : {}) };
	}

	/** When the latest prompt was sent, as the working strip's clock counts from it. */
	private lastPromptAt(): number | undefined {
		const items = this.transcript.items;
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.kind === 'user') {
				return item.at;
			}
		}
		return undefined;
	}

	/** The title of the tool call the turn is on, if any. */
	private runningStep(): string | undefined {
		const items = this.transcript.items;
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.kind === 'user') {
				return undefined;
			}
			if (item.kind === 'toolCall') {
				return item.status === 'pending' || item.status === 'in_progress' ? item.title : undefined;
			}
		}
		return undefined;
	}

	/** The conversation, as shown. */
	get conversation(): readonly TranscriptItem[] {
		return this.transcript.items;
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
		const state = this.service.client.state;
		if (state.kind === 'ready' && sessionId && state.savedSessionId !== sessionId) {
			this.addSessionLostNotice();
		}
		this.lastSessionId = state.kind === 'ready' ? state.savedSessionId : sessionId;
	}

	/** Whether a webview shows this chat. */
	get attached(): boolean {
		return !!this.webview;
	}

	/** Shows the chat in `webview`, replacing any webview it was in. */
	attach(webview: vscode.Webview): void {
		this.detach();
		this.webview = webview;
		// Start the agent with the view rather than once its script has loaded, and build the
		// @-mention file list after that, so the two do not compete while the agent starts.
		// A failure shows in the view's status line.
		const warmFiles = () => this.fileIndex.warm();
		this.service.ensureReady().then(warmFiles, warmFiles);
		const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
		webview.html = this.getHtml(webview, mediaUri);
		this.webviewListener = webview.onDidReceiveMessage((message: FromWebview) => this.onMessage(message));
	}

	/** Forgets the webview, when it is disposed. The conversation carries on. */
	detach(webview?: vscode.Webview): void {
		if (webview && webview !== this.webview) {
			return;
		}
		this.webviewListener?.dispose();
		this.webviewListener = undefined;
		this.webview = undefined;
	}

	/** Sends a prompt as if typed in the view. */
	async send(text: string, attachments: readonly Attachment[] = []): Promise<void> {
		attachments = attachments.filter(isValidAttachment);
		if (this.busy || (!text.trim() && !attachments.length)) {
			return;
		}
		if (this.options.savedSessions && text.trim() === `/${resumeCommand().name}` && !attachments.length) {
			void this.pickSession();
			return;
		}
		this.replaying = false;
		if (this.retryItemId) {
			this.transcript.updateTurnEnd(this.retryItemId, { retry: undefined });
			this.retryItemId = undefined;
		}
		this.transcript.addPrompt(text, attachments);
		this.onDidSendPromptEmitter.fire(text);
		this.lastPrompt = { text, attachments };
		this.checkpoints.beginTurn();
		this.setBusy(true);
		const started = Date.now();
		let ended = false;
		try {
			await this.service.ensureReady();
			// Built after the agent is ready, so it reflects what this agent accepts.
			const content = buildPromptContent(await this.expandCommand(text), attachments, this.service.client.promptCapabilities);
			if (!content.length) {
				throw new Error(vscode.l10n.t("The agent cannot take images, so there was nothing to send."));
			}
			if (this.undoNote) {
				content.unshift({ type: 'text', text: this.undoNote });
			}
			const { stopReason, usage } = await this.service.client.promptTurn(content);
			this.undoNote = undefined;
			const notice = stopReasonNotice(stopReason);
			if (notice) {
				this.transcript.addNotice(notice, stopReason === 'refusal' ? 'error' : 'info');
			}
			this.endTurn(Date.now() - started, usage);
			ended = true;
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		} finally {
			if (!ended && this.checkpoints.running) {
				// The turn failed after changing files; they can still be undone.
				this.endTurn(Date.now() - started);
			}
			this.setBusy(false);
			void this.postContext();
		}
	}

	/** Adds the turn's end, offering Retry and, when it changed files, Undo. */
	private endTurn(durationMs: number, usage?: readonly ModelTokens[]): void {
		const id = this.transcript.addTurnEnd(durationMs, usage);
		const { undoable, dropped } = this.checkpoints.endTurn(id);
		for (const old of dropped) {
			this.transcript.updateTurnEnd(old, { undo: undefined });
		}
		const files = this.checkpoints.fileCount(id);
		this.transcript.updateTurnEnd(id, { retry: true, ...(files ? { files } : {}), ...(undoable ? { undo: 'available' } : {}) });
		this.retryItemId = id;
	}

	/**
	 * Puts back every file turn `id` changed, and the changes of the turns
	 * after it. Asks first when that reaches further than the turn, or when a
	 * file was changed after the agent wrote it.
	 */
	private async undoTurn(id: string): Promise<void> {
		const plan = this.checkpoints.plan(id);
		if (this.busy || !plan) {
			return;
		}
		const files = new WorkspaceFileSystem();
		const current = await Promise.all(plan.restores.map(r => files.readTextFile(r.path).catch(() => undefined)));
		const changedSince = plan.restores.filter((r, i) => (current[i] ?? '') !== r.agentText);
		if (plan.laterTurns || changedSince.length) {
			const undo = vscode.l10n.t("Undo Changes");
			const detail = [
				plan.laterTurns === 1 ? vscode.l10n.t("This also undoes the changes from the reply after it.") : plan.laterTurns ? vscode.l10n.t("This also undoes the changes from the {0} replies after it.", plan.laterTurns) : '',
				changedSince.length ? vscode.l10n.t("These files changed after Gemini edited them, and those changes will be lost: {0}", changedSince.map(r => path.basename(r.path)).join(', ')) : '',
			].filter(Boolean).join('\n\n');
			if (await vscode.window.showWarningMessage(vscode.l10n.t("Undo the changes to {0} files?", plan.restores.length), { modal: true, detail }, undo) !== undo) {
				return;
			}
		}
		const restored: acp.Diff[] = [];
		const failed: string[] = [];
		for (const [i, restore] of plan.restores.entries()) {
			try {
				if (restore.text === undefined) {
					await deleteFile(restore.path);
				} else {
					await replaceFileText(restore.path, restore.text);
				}
				restored.push({ path: restore.path, oldText: current[i] ?? '', newText: restore.text ?? '' });
			} catch (err) {
				failed.push(`${path.basename(restore.path)}: ${errorMessage(err)}`);
			}
		}
		for (const undone of this.checkpoints.undone(id)) {
			this.transcript.updateTurnEnd(undone, { undo: 'undone' });
		}
		if (restored.length) {
			this.onDidEditFilesEmitter.fire(restored);
			const names = restored.map(r => path.relative(this.service.client.cwd, r.path) || r.path);
			this.undoNote = `[The user undid your file changes. These files are back to how they were before those replies, so read them again before editing them: ${names.join(', ')}]`;
			this.transcript.addNotice(restored.length === 1
				? vscode.l10n.t("Undid the changes to {0}. Gemini will be told with your next message.", path.basename(restored[0].path))
				: vscode.l10n.t("Undid the changes to {0} files. Gemini will be told with your next message.", restored.length));
		}
		if (failed.length) {
			this.transcript.addNotice(vscode.l10n.t("Some files could not be put back: {0}", failed.join('; ')), 'error');
		}
	}

	/**
	 * The text to send for `text`: a team command's prompt when it invokes
	 * one, a request to load the skill when it names one, else `text` itself. The agent's own commands go as typed, and win
	 * over a team command with the same name.
	 */
	private async expandCommand(text: string): Promise<string> {
		const invocation = parseInvocation(text);
		if (!invocation || this.service.client.commands.some(c => c.name === invocation.name)) {
			return text;
		}
		const command = (await teamCommands(this.service.client.cwd)).find(c => c.name === invocation.name);
		if (command) {
			return expandTeamCommand(command, text);
		}
		const skill = (await skills(this.service.client.cwd)).find(s => s.name === invocation.name);
		return skill ? skillPrompt(skill.name, invocation.args) : text;
	}

	private async postCommands(): Promise<void> {
		const [team, skillList] = await Promise.all([teamCommands(this.service.client.cwd), skills(this.service.client.cwd)]);
		// Team commands, then skills whose names they do not take.
		const teamNames = new Set(team.map(c => c.name));
		const local: SlashCommand[] = [...team, ...skillList.filter(s => !teamNames.has(s.name)).map(s => ({ name: s.name, description: s.description, source: 'skill' as const }))];
		const commands = mergeCommands(this.service.client.commands, local);
		this.post({ type: 'commands', commands: this.options.savedSessions && !commands.some(c => c.name === 'resume') ? [...commands, resumeCommand()] : commands });
	}

	/** The saved sessions this chat may reopen: not its own, nor one another chat has open. */
	private async savedSessions(): Promise<CliSession[]> {
		const exclude = new Set(this.options.savedSessions?.inUse());
		const state = this.service.client.state;
		if (state.kind === 'ready') {
			exclude.add(state.savedSessionId);
		}
		return listCliSessions(this.service.client.cwd, { exclude }).catch(() => []);
	}

	/** Offers the newest saved sessions in an empty chat. Read after the view is up, so it never holds the chat back. */
	private async postSessions(): Promise<void> {
		if (!this.options.savedSessions || !this.webview || this.transcript.items.length) {
			return;
		}
		const sessions = await this.savedSessions();
		const now = Date.now();
		this.post({ type: 'sessions', total: sessions.length, sessions: sessions.slice(0, shownSessions).map(s => ({ id: s.id, title: s.title, detail: sessionDetail(s, now) })) });
	}

	/** Every saved session for the folder, in a quick pick; the one picked opens here. */
	async pickSession(): Promise<void> {
		if (!this.options.savedSessions || this.busy) {
			return;
		}
		const now = Date.now();
		const picks = this.savedSessions().then(sessions => sessions.map(s => ({ label: s.title, description: sessionDetail(s, now), session: s })));
		const pick = await vscode.window.showQuickPick(picks, {
			title: vscode.l10n.t("Restore a Gemini CLI Session"),
			placeHolder: vscode.l10n.t("Sessions saved for {0}, newest first", path.basename(this.service.client.cwd)),
			matchOnDescription: true,
		});
		if (pick) {
			await this.restoreSession(pick.session.id, pick.session.title);
		}
	}

	/**
	 * Reopens saved session `id` here: the agent picks it up where it left
	 * off and replays it into the chat. A conversation already here is
	 * replaced, after asking; it stays saved by the CLI.
	 */
	async restoreSession(id: string, title?: string): Promise<void> {
		if (this.busy) {
			return;
		}
		title ??= (await this.savedSessions()).find(s => s.id === id)?.title ?? id;
		if (this.transcript.items.length) {
			const restore = vscode.l10n.t("Restore");
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t("Restore \"{0}\" in this chat?", title),
				{ modal: true, detail: vscode.l10n.t("The conversation here is replaced. The Gemini CLI keeps it, so you can restore it again later.") },
				restore);
			if (answer !== restore) {
				return;
			}
		}
		this.setBusy(true);
		let restored = false;
		try {
			await this.service.ensureReady();
			this.transcript.clear();
			this.diffs.clear();
			this.completedToolCalls.clear();
			this.checkpoints.clear();
			this.lastPrompt = undefined;
			this.retryItemId = undefined;
			this.undoNote = undefined;
			this.transcript.addNotice(vscode.l10n.t("Restored \"{0}\" from the Gemini CLI.", title));
			this.replaying = true;
			// So the switch does not read as the agent losing the session.
			this.lastSessionId = id;
			restored = await this.service.client.loadSession(id);
			if (restored) {
				this.onDidRestoreSessionEmitter.fire(title);
			}
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		} finally {
			this.setBusy(false);
		}
		if (!restored) {
			this.replaying = false;
			this.transcript.clear();
			this.transcript.addNotice(vscode.l10n.t("The agent could not reopen \"{0}\", so this chat starts afresh.", title), 'error');
		}
	}

	/** A message of a reopened session as it replays: the CLI's own context and commands are left out. */
	private applyReplayed(event: ChatEvent): void {
		if (event.kind === 'text' && event.role === 'user') {
			const text = event.text.trim();
			if (isPrompt(text)) {
				this.transcript.addReplayedPrompt(text);
			}
			return;
		}
		this.transcript.apply(event);
	}

	/** Adds context to the composer (Add File / Add Selection to Chat), showing the chat first. */
	async addAttachments(attachments: readonly Attachment[]): Promise<void> {
		if (!attachments.length) {
			return;
		}
		if (this.webview) {
			this.post({ type: 'attach', attachments });
		} else {
			this.pendingAttachments.push(...attachments);
		}
		// Focus the chat, so the user can type about what they just added.
		await this.options.reveal(false);
	}

	/** Lets the user pick files from anywhere to attach. */
	private async pickFiles(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: vscode.l10n.t("Attach"),
			title: vscode.l10n.t("Attach Files to Chat"),
		});
		if (uris?.length) {
			await this.addAttachments(await attachmentsForFiles(uris));
		}
	}

	/** Shows an information line in the conversation. */
	addNotice(text: string): void {
		this.transcript.addNotice(text);
	}

	/** Opens the usage popover, or closes it if open; the chat comes into view first. */
	async showUsage(): Promise<void> {
		if (!this.webview) {
			this.usageRequested = true;
		}
		await this.options.reveal(false);
		if (this.webview && !this.usageRequested) {
			this.post({ type: 'toggleUsage' });
		}
	}

	/** Clears the conversation and, when the agent runs, starts a fresh session so it forgets it too. */
	async newChat(): Promise<void> {
		if (this.busy) {
			return;
		}
		this.transcript.clear();
		this.diffs.clear();
		this.completedToolCalls.clear();
		this.checkpoints.clear();
		this.lastPrompt = undefined;
		this.retryItemId = undefined;
		this.undoNote = undefined;
		this.replaying = false;
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

	dispose(): void {
		this.enhancing?.abort.abort();
		clearTimeout(this.followTimer);
		this.detach();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private onMessage(message: FromWebview): void {
		switch (message.type) {
			case 'ready':
				if (message.protocol !== chatProtocolVersion) {
					void vscode.window.showWarningMessage(vscode.l10n.t("The Gemini chat view's script is out of date. Rebuild it with \"npm run gulp compile-extension-media\" (or keep \"npm run watch\" running) and reload the window."));
				}
				this.postReset();
				this.post({ type: 'capabilities', image: this.service.client.promptCapabilities.image });
				this.post({ type: 'composerHeight', height: preferredComposerHeight() });
				this.post({ type: 'follow', on: this.following });
				this.postFollowed();
				if (this.pendingAttachments.length) {
					this.post({ type: 'attach', attachments: this.pendingAttachments });
					this.pendingAttachments = [];
				}
				if (this.usageRequested) {
					this.usageRequested = false;
					this.post({ type: 'toggleUsage' });
				}
				this.postGit();
				// The agent was started with the view (see attach); this retries one that has since stopped.
				this.service.ensureReady().catch(() => undefined);
				// After starting the agent: finding the theme's file scans every extension the first time.
				setTimeout(() => void this.postTokenColors(), 0);
				break;
			case 'prompt':
				void this.send(message.text, message.attachments ?? []);
				break;
			case 'composerHeight':
				rememberComposerHeight(message.height);
				break;
			case 'setFollow':
				this.setFollowing(message.on);
				break;
			case 'showFollowed':
				if (this.followed) {
					void vscode.window.showTextDocument(this.followed, { preview: true, viewColumn: this.options.editorColumn?.() });
				}
				break;
			case 'closeFollowed':
				void this.closeFollowed();
				break;
			case 'pickFiles':
				void this.pickFiles();
				break;
			case 'attachUris': {
				const uris = message.uris.map(uri => vscode.Uri.parse(uri)).filter(uri => uri.scheme === 'file');
				void attachmentsForFiles(uris).then(attachments => this.addAttachments(attachments));
				break;
			}
			case 'searchFiles':
				void this.fileIndex.search(message.query, 30).then(
					files => this.post({ type: 'files', requestId: message.requestId, files }),
					() => this.post({ type: 'files', requestId: message.requestId, files: [] }),
				);
				break;
			case 'listCommands':
				void this.postCommands();
				break;
			case 'stop':
				void this.service.cancel();
				break;
			case 'command':
				if (statusCommands.includes(message.command)) {
					void vscode.commands.executeCommand(message.command);
				}
				break;
			case 'permission':
				this.service.permissions.select(message.id, message.optionId);
				break;
			case 'openDiff':
				void this.openDiff(message.itemId, message.path, false);
				break;
			case 'openLocation':
				void this.openLocation(message.path, message.line);
				break;
			case 'openPath':
				void this.openPath(message.path, message.line);
				break;
			case 'setMode':
				void this.changeSetting(() => this.service.client.setMode(message.id).catch(err => this.offerFolderTrust(err, message.id)));
				break;
			case 'setModel':
				void this.changeSetting(() => this.service.client.setModel(message.id)).then(() => {
					if (this.service.client.settings.model?.currentId === message.id) {
						rememberModel(message.id);
					}
				});
				break;
			case 'pickBranch': {
				const folder = this.options.git?.folder();
				const ownBranch = this.options.git?.ownBranch;
				if (ownBranch) {
					void vscode.window.showInformationMessage(vscode.l10n.t("This agent works on its own branch, {0}. Use Merge Back to bring its work into your branch.", ownBranch));
				} else if (folder) {
					void pickBranch(folder).finally(() => this.postGit());
				}
				break;
			}
			case 'createBranchAndCommit':
				void this.commit();
				break;
			case 'workspaceMenu':
				void this.workspaceMenu();
				break;
			case 'restoreSession':
				if (typeof message.id === 'string') {
					void this.restoreSession(message.id);
				}
				break;
			case 'pickSession':
				void this.pickSession();
				break;
			case 'undoTurn':
				void this.undoTurn(message.itemId);
				break;
			case 'retry':
				if (this.lastPrompt && message.itemId === this.retryItemId) {
					void this.send(this.lastPrompt.text, this.lastPrompt.attachments);
				}
				break;
			case 'prepareEnhance':
				// Only once the agent runs: a rewrite is no reason to start it.
				this.options.enhancer.prepare();
				break;
			case 'enhancePrompt':
				void this.enhance(message.requestId, message.text, message.attachments);
				break;
			case 'readQuota':
				void this.postQuota();
				break;
			case 'cancelEnhance':
				if (this.enhancing?.requestId === message.requestId) {
					this.enhancing.abort.abort();
				}
				break;
		}
	}

	/** Opens the conversation as a Markdown document, titled `title`. */
	openAsMarkdown(title: string): Promise<void> {
		return openChatAsMarkdown(title, this.transcript.items, this.options.editorColumn?.());
	}

	/** Turns Follow the agent on or off in this chat; new chats start the same way. */
	toggleFollowing(): void {
		this.setFollowing(!this.following);
	}

	private setFollowing(on: boolean): void {
		this.following = on;
		if (!on) {
			clearTimeout(this.followTimer);
			this.followTimer = undefined;
			this.followTarget = undefined;
		}
		this.post({ type: 'follow', on });
		void vscode.workspace.getConfiguration('gemini').update('chat.followAgent', on, vscode.ConfigurationTarget.Global);
	}

	private scheduleFollow(target: FollowTarget | undefined): void {
		if (!target) {
			return;
		}
		this.followTarget = target;
		this.followTimer ??= setTimeout(() => {
			this.followTimer = undefined;
			const next = this.followTarget;
			this.followTarget = undefined;
			if (next && this.following) {
				void this.showFollowed(next);
			}
		}, followIntervalMs);
	}

	/**
	 * Shows a file the agent is on, leaving focus in the chat. Folders, missing
	 * files, files outside the agent's folder and files that may hold secrets
	 * are skipped.
	 */
	private async showFollowed(target: FollowTarget): Promise<void> {
		const root = path.resolve(this.service.client.cwd);
		const file = path.resolve(root, target.path);
		if (!isInside(root, file) || secretPathReason(path.relative(root, file)) || !await isFile(file)) {
			return;
		}
		const position = new vscode.Position(Math.max((target.line ?? 1) - 1, 0), 0);
		const uri = vscode.Uri.file(file);
		try {
			await vscode.window.showTextDocument(uri, {
				selection: new vscode.Range(position, position), preview: true, preserveFocus: true, viewColumn: this.options.editorColumn?.(),
			});
		} catch {
			// A file that cannot be shown, such as a binary one, is skipped.
			return;
		}
		this.followed = uri;
		this.postFollowed();
	}

	/** The chat names the followed file, with a close button, while its tab is open. */
	private postFollowed(): void {
		const uri = this.followed;
		this.post({ type: 'followed', file: uri && { name: path.basename(uri.fsPath), path: vscode.workspace.asRelativePath(uri) } });
	}

	private async closeFollowed(): Promise<void> {
		const uri = this.followed;
		if (uri) {
			await vscode.window.tabGroups.close(followedTabs(uri));
		}
	}

	/** The Enhance Prompt command: enhances what the composer holds, showing the chat first. */
	async requestEnhance(): Promise<void> {
		await this.options.reveal(false);
		this.post({ type: 'enhanceRequested' });
	}

	/** Rewrites the composer's draft as a precise prompt and sends it back for the user to review. */
	private async enhance(requestId: number, draft: string, attachments: readonly Attachment[]): Promise<void> {
		const enhancer = this.options.enhancer;
		if (!draft.trim()) {
			return;
		}
		this.enhancing?.abort.abort();
		const abort = new AbortController();
		this.enhancing = { requestId, abort };
		try {
			// The rewrite waits for the agent process itself, not for this chat's session.
			const text = await enhancer.enhance(await this.enhanceInput(draft, attachments), abort.signal);
			this.post({ type: 'enhanced', requestId, text });
		} catch (err) {
			if (!(err instanceof EnhanceCancelledError)) {
				this.post({ type: 'enhanceFailed', requestId, message: errorMessage(err) });
			}
		} finally {
			if (this.enhancing?.abort === abort) {
				this.enhancing = undefined;
			}
		}
	}

	/** The draft with what a rewrite may use: attachment names, the chat so far, the folder, branch, open file and mode. */
	private async enhanceInput(draft: string, attachments: readonly Attachment[]): Promise<EnhancePromptInput> {
		const client = this.service.client;
		const folder = this.options.git?.folder() ?? client.cwd;
		const branch = await readGitHead(folder).catch(() => undefined);
		const document = vscode.window.activeTextEditor?.document;
		const relative = document?.uri.scheme === 'file' ? path.relative(client.cwd, document.uri.fsPath) : undefined;
		const activeFile = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `${relative.split(path.sep).join('/')} (${document!.languageId})` : undefined;
		const mode = client.settings.mode;
		return {
			draft,
			attachments: attachments.map(attachmentLabel),
			history: enhanceHistory(this.transcript.items),
			folder: path.basename(client.cwd),
			branch,
			activeFile,
			mode: mode?.available.find(choice => choice.id === mode.currentId)?.name,
		};
	}

	/** Commits the files the agent changed on a new branch, as the composer's Commit button does. */
	async commit(): Promise<void> {
		const folder = this.options.git?.folder();
		const commit = this.options.git?.commit;
		const files = commit?.files() ?? [];
		if (!folder || !commit || !files.length || this.busy) {
			return;
		}
		const suggestion = commit.suggestion();
		if (await createBranchAndCommit({ folder, files, suggestedBranch: suggestion.branch, suggestedMessage: suggestion.message })) {
			commit.committed();
		}
		this.postGit();
	}

	/** Sends the branch and whether there is anything to commit; the branch is read from `.git/HEAD`, which is cheap. */
	private postGit(): void {
		const git = this.options.git;
		const folder = git?.folder();
		if (!git || !this.webview) {
			return;
		}
		const canCommit = !this.busy && !!git.commit?.files().length;
		const ws = this.options.workspace?.();
		const workspace = ws && { name: path.basename(ws.folder) || ws.folder, path: tildify(ws.cwd), worktree: ws.worktree };
		void (folder ? readGitHead(folder).catch(() => undefined) : Promise.resolve(undefined))
			.then(branch => this.post({ type: 'git', git: { branch, canCommit, ...(workspace ? { workspace } : {}) } }));
	}

	/** What the workspace pill offers, in a quick pick. */
	private async workspaceMenu(): Promise<void> {
		const workspace = this.options.workspace?.();
		if (!workspace) {
			return;
		}
		const items: (vscode.QuickPickItem & { run(): Thenable<unknown> })[] = [
			{ label: `$(copy) ${vscode.l10n.t("Copy Path")}`, description: tildify(workspace.cwd), run: () => vscode.env.clipboard.writeText(workspace.cwd) },
			{ label: `$(folder-opened) ${vscode.l10n.t("Reveal in Finder")}`, run: () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(workspace.cwd)) },
			{ label: `$(list-tree) ${vscode.l10n.t("Show Agents")}`, run: () => vscode.commands.executeCommand('gemini.agents.focus') },
		];
		const pick = await vscode.window.showQuickPick(items, { title: path.basename(workspace.folder) || workspace.folder });
		await pick?.run();
	}

	private async changeSetting(change: () => Promise<void>): Promise<void> {
		try {
			await change();
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		}
		// Resync the pickers: the change may have failed or been ignored.
		this.post({ type: 'settings', settings: this.service.client.settings });
	}

	/**
	 * When the CLI refused a mode because it does not trust the folder, asks
	 * the user to trust it, as the CLI's own terminal does, and switches to the
	 * mode once the agent restarts. Rethrows anything else.
	 */
	private async offerFolderTrust(err: unknown, modeId: string): Promise<void> {
		if (!(err instanceof AgentError) || err.info.kind !== 'untrusted-folder') {
			throw err;
		}
		const folder = this.service.client.cwd;
		const modeName = this.service.client.settings.mode?.available.find(choice => choice.id === modeId)?.name ?? modeId;
		const trust = vscode.l10n.t("Trust Folder");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Trust {0} for the Gemini agent?", path.basename(folder) || folder),
			{
				modal: true,
				detail: vscode.l10n.t("{0} mode needs a trusted folder. Trusting it also lets the Gemini CLI load this folder's own Gemini settings and MCP servers, which can run programs. The Gemini CLI remembers the choice for this folder, including in the terminal.", modeName),
			},
			trust);
		if (choice !== trust) {
			return;
		}
		this.service.client.setModeOnNextSession(modeId);
		const waits = this.service.trustFolder(folder);
		this.transcript.addNotice(waits
			? vscode.l10n.t("Folder trusted. The agent restarts in {0} mode once no agent is working.", modeName)
			: vscode.l10n.t("Folder trusted. Restarting the agent in {0} mode.", modeName), 'info');
	}

	private addSessionLostNotice(): void {
		this.transcript.addNotice(vscode.l10n.t("The agent could not continue the earlier session, so it does not remember the messages above."));
	}

	/** Brings the chat into view so the request can be answered, and shows the first proposed edit. */
	private async revealForPermission(permission: PendingPermission): Promise<void> {
		await this.options.reveal(true);
		const firstDiff = permission.request.toolCall.content?.find(c => c.type === 'diff');
		if (firstDiff) {
			await this.openDiff(permission.id, firstDiff.path, true);
		}
	}

	private rememberDiffs(itemId: string, diffs: readonly acp.Diff[]): void {
		if (diffs.length) {
			// Re-inserting keeps the most recent edits when old ones are dropped.
			this.diffs.delete(itemId);
			this.diffs.set(itemId, diffs);
			dropOldest(this.diffs);
		}
	}

	private async openDiff(itemId: string, filePath: string, preserveFocus: boolean): Promise<void> {
		const diff = this.diffs.get(itemId)?.find(d => d.path === filePath);
		if (diff) {
			await this.diffPreview.show(diff, { preserveFocus, viewColumn: this.options.editorColumn?.() });
			return;
		}
		// Proposed edits are kept in memory only, so a restored or old chat has
		// none: show the file as it is now instead.
		void vscode.window.showInformationMessage(vscode.l10n.t("The proposed change is no longer available, so the file is shown as it is now."));
		await this.openLocation(filePath, undefined);
	}

	/** Opens a file the reply names: by its path from the agent's folder, else by its name anywhere in the workspace. */
	private async openPath(name: string, line: number | undefined): Promise<void> {
		if (typeof name !== 'string' || !name || name.length > 500) {
			return;
		}
		const folder = this.options.git?.folder() ?? this.service.client.cwd;
		const direct = path.resolve(folder, name);
		if (await isFile(direct)) {
			return this.openLocation(direct, line);
		}
		const pattern = `**/${name.replace(/^(\.\.?\/)+/, '').replace(/[[\]{}*?!]/g, '?')}`;
		const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), '**/{node_modules,.git}/**', 20);
		if (matches.length === 1) {
			return this.openLocation(matches[0].fsPath, line);
		}
		if (!matches.length) {
			void vscode.window.setStatusBarMessage(vscode.l10n.t("No file named {0} in {1}", name, path.basename(folder)), 4000);
			return;
		}
		const pick = await vscode.window.showQuickPick(matches.map(uri => ({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), uri })), { placeHolder: vscode.l10n.t("Which {0}?", name) });
		if (pick) {
			return this.openLocation(pick.uri.fsPath, line);
		}
	}

	private async openLocation(filePath: string, line: number | undefined): Promise<void> {
		const position = new vscode.Position(Math.max((line ?? 1) - 1, 0), 0);
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(filePath), { selection: new vscode.Range(position, position), preview: true, viewColumn: this.options.editorColumn?.() });
		} catch (err) {
			void vscode.window.showErrorMessage(errorMessage(err));
		}
	}

	private setBusy(busy: boolean): void {
		if (busy && !this.busy) {
			this.turnStartedAt = this.lastPromptAt() ?? Date.now();
		}
		this.busy = busy;
		if (this.options.busyContextKey) {
			void vscode.commands.executeCommand('setContext', this.options.busyContextKey, busy);
		}
		this.post({ type: 'busy', busy });
		this.fireActivity();
		// A turn may have switched branches or changed files.
		this.postGit();
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
		if (!this.busy) {
			void this.postSessions();
		}
		void this.postContext();
	}

	/** How full this session's context window is, from the counts the CLI saved; none until the agent has answered. */
	private async postContext(): Promise<void> {
		const state = this.service.client.state;
		const tokens = state.kind === 'ready' && this.transcript.items.length ? await readSessionTokens(this.service.client.cwd, state.savedSessionId).catch(() => undefined) : undefined;
		this.post({ type: 'context', context: tokens && { used: tokens.context, limit: contextWindow, cached: tokens.cached, ...(tokens.model ? { model: tokens.model } : {}) } });
	}

	/** Today's quota for the usage popover: what is known now, then a fresh read if that was not fresh. */
	private async postQuota(): Promise<void> {
		const meter = this.options.usage?.();
		const current = meter?.reading ?? { kind: 'off' as const };
		if (!meter || current.kind === 'off') {
			this.post({ type: 'quota', quota: { kind: 'off' } });
			return;
		}
		this.post({ type: 'quota', quota: current.kind === 'ok' ? { ...current, checking: true } : { kind: 'checking' } });
		this.post({ type: 'quota', quota: await meter.refresh() });
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

	private getHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
		const nonce = createNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
		// Loaded by the view when it first shows code.
		const highlighter = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'highlight.js'));
		const strings: ChatStrings = {
			placeholder: vscode.l10n.t("Ask Gemini anything about this workspace"),
			placeholderFollowUp: vscode.l10n.t("Ask a follow-up"),
			send: process.platform === 'darwin' ? vscode.l10n.t("Send (Return)") : vscode.l10n.t("Send (Enter)"),
			stop: vscode.l10n.t("Stop (Esc)"),
			replyFinished: vscode.l10n.t("Reply finished"),
			welcomeTitle: vscode.l10n.t("What are we building?"),
			welcome: vscode.l10n.t("Ask Gemini to explain, change or create code in this workspace. It asks before it edits files."),
			hintMention: vscode.l10n.t("to add files as context"),
			hintNewLine: vscode.l10n.t("for a new line"),
			hintCommands: vscode.l10n.t("for commands"),
			scrollToBottom: vscode.l10n.t("Jump to latest"),
			latest: vscode.l10n.t("Latest"),
			thinking: vscode.l10n.t("Thinking"),
			activityWorking: vscode.l10n.t("Working"),
			activityWaiting: vscode.l10n.t("Waiting on you"),
			activityWriting: vscode.l10n.t("Writing the reply"),
			activityDone: vscode.l10n.t("Done in {0}"),
			activityStopHint: vscode.l10n.t("Esc to stop"),
			thought: vscode.l10n.t("Thought"),
			thoughtFor: vscode.l10n.t("Thought for {0}s"),
			plan: vscode.l10n.t("Plan"),
			unknownUpdate: vscode.l10n.t("Update not shown in this version: {0}"),
			terminal: vscode.l10n.t("Terminal output"),
			openDiff: vscode.l10n.t("Open diff"),
			copy: vscode.l10n.t("Copy"),
			copied: vscode.l10n.t("Copied"),
			mode: vscode.l10n.t("Mode"),
			model: vscode.l10n.t("Model"),
			permissionAnswered: vscode.l10n.t("You chose: {0}"),
			permissionCancelled: vscode.l10n.t("Not answered; the request was cancelled."),
			permissionHint: vscode.l10n.t("Esc rejects"),
			workedFor: vscode.l10n.t("Worked for {0}"),
			copyReply: vscode.l10n.t("Copy reply"),
			copyMessage: vscode.l10n.t("Copy message"),
			undoTurn: vscode.l10n.t("Undo"),
			undoTurnTooltip: vscode.l10n.t("Put back the files this reply changed"),
			undoTurnFiles: vscode.l10n.t("Put back the {0} files this reply changed"),
			turnUndone: vscode.l10n.t("Changes undone"),
			retry: vscode.l10n.t("Retry"),
			retryTooltip: vscode.l10n.t("Send this message again"),
			switchBranch: vscode.l10n.t("Branch {0}: switch or create a branch"),
			createBranchAndCommit: vscode.l10n.t("Create a branch and commit these changes"),
			commit: vscode.l10n.t("Commit\u2026"),
			enhance: vscode.l10n.t("Enhance prompt"),
			enhanceShort: vscode.l10n.t("Enhance"),
			previewMarkdown: vscode.l10n.t("Preview ({0})"),
			previewLabel: vscode.l10n.t("Preview"),
			writeLabel: vscode.l10n.t("Write"),
			followAgent: vscode.l10n.t("Follow the agent: open each file it reads or edits"),
			promptOutline: process.platform === 'darwin' ? vscode.l10n.t("Your prompts (⌥⌘↑ and ⌥⌘↓ to jump between them)") : vscode.l10n.t("Your prompts (Ctrl+Alt+Up and Ctrl+Alt+Down to jump between them)"),
			previewEmpty: vscode.l10n.t("Nothing to preview yet."),
			enhanceTooltip: vscode.l10n.t("Rewrite this as a clearer, more precise prompt ({0})"),
			enhancing: vscode.l10n.t("Enhancing the prompt"),
			enhanced: vscode.l10n.t("Prompt enhanced. Review it, then send."),
			stillEnhancing: vscode.l10n.t("Still working\u2026"),
			enhanceWaiting: vscode.l10n.t("Gemini is busy or rate-limited and is retrying\u2026"),
			cancel: vscode.l10n.t("Cancel"),
			revert: vscode.l10n.t("Revert"),
			revertTooltip: vscode.l10n.t("Put back what you wrote"),
			workspaceTooltip: vscode.l10n.t("Workspace {0}"),
			worktree: vscode.l10n.t("worktree"),
			restoreTitle: vscode.l10n.t("Restore a session"),
			restoreHint: vscode.l10n.t("Saved by the Gemini CLI for this folder"),
			restore: vscode.l10n.t("Restore"),
			showAllSessions: vscode.l10n.t("Show all {0} sessions\u2026"),
			commandFromApp: vscode.l10n.t("GeminiCode"),
			usage: vscode.l10n.t("Usage and quota"),
			usageThisChat: vscode.l10n.t("This chat"),
			usageTurns: vscode.l10n.t("{0} replies"),
			usageOneTurn: vscode.l10n.t("1 reply"),
			usageInput: vscode.l10n.t("Input"),
			usageOutput: vscode.l10n.t("Output"),
			usageModel: vscode.l10n.t("Model"),
			usageTotal: vscode.l10n.t("Total"),
			usageInputNote: vscode.l10n.t("Input counts the conversation again for each model call, as the CLI's /stats does."),
			usageNoTurns: vscode.l10n.t("No replies yet."),
			usageNoCounts: vscode.l10n.t("No token counts for these replies. Gemini reports them for new replies."),
			usageSomeCounted: vscode.l10n.t("Counts for {0} of {1} replies."),
			usageQuota: vscode.l10n.t("Today's quota"),
			usageUsed: vscode.l10n.t("{0}% used"),
			usageResetsHours: vscode.l10n.t("resets in {0}h"),
			usageResetsMinutes: vscode.l10n.t("resets in {0}m"),
			usageChecking: vscode.l10n.t("Checking\u2026"),
			usageCheckedJustNow: vscode.l10n.t("Checked just now"),
			usageCheckedMinutes: vscode.l10n.t("Checked {0} min ago"),
			usageQuotaOff: vscode.l10n.t("Turned off in Settings (Gemini \u203a Usage Meter)."),
			usageQuotaNone: vscode.l10n.t("Shown when you sign in with Google. API keys have no daily quota to read."),
			usageQuotaFailed: vscode.l10n.t("Couldn't read the quota. Try again in a moment."),
			plusMenu: vscode.l10n.t("Add files, context, modes and more"),
			menuSearch: vscode.l10n.t("Search modes, files, commands\u2026"),
			menuFiles: vscode.l10n.t("Files"),
			menuFilesDetail: vscode.l10n.t("Attach files or images"),
			menuContext: vscode.l10n.t("Context"),
			menuContextDetail: vscode.l10n.t("Add workspace files (@)"),
			menuFollow: vscode.l10n.t("Follow the agent"),
			menuFollowDetail: vscode.l10n.t("Open each file it reads or edits"),
			followAgentOn: vscode.l10n.t("Following the agent: each file it reads or edits opens. Click to stop."),
			menuUsageDetail: vscode.l10n.t("Context {0}%"),
			menuCommands: vscode.l10n.t("Skills and commands"),
			back: vscode.l10n.t("Back"),
			modeChip: vscode.l10n.t("Mode: {0}. Click to change it."),
			modeChipReset: vscode.l10n.t("Back to {0}"),
			usageRing: vscode.l10n.t("Context {0}% used. Click for usage and quota."),
			followedFile: vscode.l10n.t("{0}, the file the agent is on. Click to show it."),
			closeFollowed: vscode.l10n.t("Close {0}"),
			usageContext: vscode.l10n.t("Context window"),
			usageThisChatScope: vscode.l10n.t("this chat"),
			usageAccount: vscode.l10n.t("your account"),
			usageContextNone: vscode.l10n.t("Shown after Gemini's first reply in this chat."),
			usageContextOf: vscode.l10n.t("of {0} tokens"),
			usageContextNote: vscode.l10n.t("Gemini summarises older messages at {0}%."),
			usageCached: vscode.l10n.t("Cached"),
			usageCachedNote: vscode.l10n.t("Cached: input served from Gemini's cache, from the CLI's session file."),
			usageDetails: vscode.l10n.t("Details by model"),
			usageHideDetails: vscode.l10n.t("Hide details"),
			usageAllModels: vscode.l10n.t("All {0} models"),
			usageFewerModels: vscode.l10n.t("Fewer models"),
			noFiles: vscode.l10n.t("No matching files"),
			noCommands: vscode.l10n.t("No matching commands"),
			commandFromCli: vscode.l10n.t("Gemini CLI"),
			commandFromTeam: vscode.l10n.t("Team"),
			commandFromSkill: vscode.l10n.t("Skill"),
			remove: vscode.l10n.t("Remove"),
			fileTooLarge: vscode.l10n.t("{0} is too large to send."),
			attachFiles: vscode.l10n.t("Attach files. You can also drop files here; hold Shift when dragging from the Explorer."),
			dropFiles: vscode.l10n.t("Drop files to attach"),
			calloutNote: vscode.l10n.t("Note"),
			calloutTip: vscode.l10n.t("Tip"),
			calloutImportant: vscode.l10n.t("Important"),
			calloutWarning: vscode.l10n.t("Warning"),
			calloutCaution: vscode.l10n.t("Caution"),
			openFile: vscode.l10n.t("Open file"),
			cannotAttach: vscode.l10n.t("{0} can't be attached: only text files, images and PDFs can be dropped here. Use the attach button to add other files."),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>Gemini</title>
</head>
<body data-accent="${solidAccent() ? 'solid' : 'gradient'}" data-font-size="${chatFontSize()}">
	<main id="transcript" class="transcript"></main>
	<nav id="outline" class="prompt-outline" hidden></nav>
	<div id="announce" class="announce" aria-live="polite"></div>
	<div id="dock" class="dock">
		<button type="button" id="scroll-down" class="scroll-down" hidden><i class="codicon codicon-arrow-down" aria-hidden="true"></i><i class="codicon codicon-chevron-down" aria-hidden="true"></i><span class="scroll-down-label"></span></button>
		<div id="activity" class="activity" hidden><svg class="activity-spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.4 3.4 2.9 6 6.5 6.5-3.6.4-6.1 3-6.5 6.5-.4-3.5-2.9-6.1-6.5-6.5C5.1 7.5 7.6 4.9 8 1.5z"/></svg><span class="activity-label"></span><span class="activity-clock"></span><span class="activity-detail"></span><span class="activity-hint"></span></div>
		<div id="status" class="status" role="status"></div>
		<form id="composer" class="composer">
			<div id="resize" class="composer-resize"></div>
			<div class="drop-overlay" aria-hidden="true"><i class="codicon codicon-cloud-upload"></i><span id="drop-label"></span></div>
			<div id="picker" class="picker" role="listbox" hidden></div>
			<div id="usage-popover" class="usage-popover" role="dialog" hidden></div>
			<div id="attachments" class="attachments" hidden></div>
			<div class="composer-tabs" role="tablist"><button type="button" id="tab-write" class="composer-tab" role="tab" aria-selected="true" aria-controls="input"></button><button type="button" id="tab-preview" class="composer-tab" role="tab" aria-selected="false" aria-controls="preview"></button></div>
			<div id="preview" class="composer-preview markdown" role="tabpanel" tabindex="0" hidden></div>
			<div class="input-wrap">
				<textarea id="input" rows="1"></textarea>
				<div class="input-mirror" aria-hidden="true"></div>
				<span id="enhance-float" class="enhance-float" hidden><button type="button" id="revert" class="enhance-chip" hidden><i class="codicon codicon-discard" aria-hidden="true"></i><span></span></button><button type="button" id="enhance" class="enhance-chip"><svg class="enhance-icon" viewBox="0 0 16 16" aria-hidden="true"><defs><linearGradient id="enhance-spark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8df7"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#e05fa8"/></linearGradient></defs><path d="M6.5 3.5C6.88 7 9 9.12 12.5 9.5C9 9.88 6.88 12 6.5 15.5C6.12 12 4 9.88 0.5 9.5C4 9.12 6.12 7 6.5 3.5Z"/><path d="M12.75 0.5C12.92 2.1 13.9 3.08 15.5 3.25C13.9 3.42 12.92 4.4 12.75 6C12.58 4.4 11.6 3.42 10 3.25C11.6 3.08 12.58 2.1 12.75 0.5Z"/></svg><i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i><span></span></button></span>
			</div>
			<div id="enhance-row" class="enhance-row" hidden>
				<span id="enhance-note" class="enhance-note" role="status" hidden></span>
			</div>
			<div class="composer-bar">
				<button type="button" id="plus" class="plus-button" aria-haspopup="menu" aria-expanded="false" aria-controls="plus-menu"><i class="codicon codicon-add" aria-hidden="true"></i></button>
				<span id="mode-chip" class="mode-chip" hidden><button type="button" class="mode-chip-label"><i class="codicon" aria-hidden="true"></i><span></span></button><button type="button" class="mode-chip-reset"><i class="codicon codicon-close" aria-hidden="true"></i></button></span>
				<span class="spacer"></span>
				<span class="pill-wrap model-wrap" hidden><select id="model" class="pill model"></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></span>
				<button type="submit" id="send" class="round-button"><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>
				<button type="button" id="stop" class="round-button stop" hidden><i class="codicon codicon-debug-stop" aria-hidden="true"></i></button>
			</div>
			<div id="plus-menu" class="plus-menu" role="menu" hidden></div>
		</form>
		<div class="composer-foot">
			<button type="button" id="branch" class="foot-button branch" hidden><i class="codicon codicon-git-branch" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
			<button type="button" id="workspace" class="foot-button workspace" hidden><i class="codicon codicon-folder" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
			<button type="button" id="commit" class="foot-button commit" hidden><i class="codicon codicon-git-commit" aria-hidden="true"></i><span></span></button>
			<span id="followed" class="foot-followed" hidden><button type="button" class="foot-button followed-name"><i class="codicon codicon-eye" aria-hidden="true"></i><span></span></button><button type="button" class="followed-close"><i class="codicon codicon-close" aria-hidden="true"></i></button></span>
			<span class="spacer"></span>
			<button type="button" id="usage-ring" class="foot-button usage-ring" aria-expanded="false" aria-controls="usage-popover"><svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="ring-track" cx="8" cy="8" r="6"/><circle class="ring-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 8 8)"/></svg><span></span></button>
		</div>
	</div>
	<script nonce="${nonce}" type="module" src="${script}" data-highlighter="${highlighter}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
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
	});
	const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
	await vscode.window.showTextDocument(document, { preview: false, viewColumn: column });
}

/** At most one file is shown this often while following the agent, so a burst of reads does not flicker the editor. */
const followIntervalMs = 250;

/** How many saved sessions an empty chat lists before "Show all". */
const shownSessions = 3;

function resumeCommand(): SlashCommand {
	return { name: 'resume', description: vscode.l10n.t("Restore a saved Gemini CLI session for this folder"), source: 'app' };
}

/** "3 prompts · 2h" */
function sessionDetail(session: CliSession, now: number): string {
	const prompts = session.messages === 1 ? vscode.l10n.t("1 prompt") : vscode.l10n.t("{0} prompts", session.messages);
	return `${prompts} \u00b7 ${relativeTime(session.updatedAt, now)}`;
}

/** The most proposed edits kept for opening their diffs later. */
const maxRememberedDiffs = 200;

/** Drops the oldest entries of a set or map beyond {@link maxRememberedDiffs}. */
function dropOldest<K>(collection: Set<K> | Map<K, unknown>): void {
	for (const key of collection.keys()) {
		if (collection.size <= maxRememberedDiffs) {
			return;
		}
		collection.delete(key);
	}
}

function diffsOf(content: readonly acp.ToolCallContent[] | null | undefined): acp.Diff[] {
	return (content ?? []).flatMap(c => c.type === 'diff' ? [c] : []);
}

/** Whether Send shows a solid accent picked on the Make It Yours page instead of the Gemini gradient. */
function solidAccent(): boolean {
	const accent = vscode.workspace.getConfiguration('gemini').get<string>('appearance.accent', 'theme');
	return accent !== 'theme' && accent !== 'gradient';
}

/** The editor tabs showing `uri`. */
function followedTabs(uri: vscode.Uri): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await vscode.workspace.fs.stat(vscode.Uri.file(filePath))).type === vscode.FileType.File;
	} catch {
		return false;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { Attachment } from '../acp/attachments';
import { isValidAttachment } from '../acp/attachmentValidation';
import { ChatTranscript, toolCallItemId, TranscriptItem } from '../acp/chatTranscript';
import { Checkpoints } from '../acp/checkpoints';
import { PendingPermission, PermissionBroker } from '../acp/permissions';
import { buildPromptContent } from '../acp/promptContent';
import { expandTeamCommand, mergeCommands, parseInvocation } from '../acp/slashCommands';
import { AgentStatus } from '../acp/status';
import { TextDeltas } from '../acp/textDeltas';
import { UpdateBatcher } from '../acp/updateBatcher';
import type { AgentClient } from '../acp/agentClient';
import { AgentError, errorMessage } from '../acp/errors';
import { readGitHead } from '../acp/gitHead';
import { ChatStrings, chatProtocolVersion, FromWebview, statusCommands, ToWebview } from './chatProtocol';
import { stopReasonNotice, toViewStatus } from './chatStatus';
import { DiffPreview } from './diffPreview';
import { attachmentsForFiles } from './addToChat';
import { createBranchAndCommit, pickBranch } from './gitActions';
import { preferredComposerHeight, rememberComposerHeight, rememberModel } from './modelPreference';
import { teamCommands } from './teamCommands';
import { createNonce, escapeAttribute } from './webviewHtml';
import type { FileMatch } from './workspaceFiles';
import { deleteFile, replaceFileText, WorkspaceFileSystem } from './workspaceFileSystem';

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
}

/** What the Agents pane shows about a chat. */
export interface ChatActivity {
	readonly busy: boolean;
	readonly needsPermission: boolean;
	/** What the agent asks permission for, or the step it is on: a tool call's title. */
	readonly step?: string;
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
	/** The step last reported, so tool call updates report only a new one. */
	private lastStep: string | undefined;
	private lastSessionId: string | undefined;
	/** Proposed edits by transcript item id (tool calls and permission requests), so their diffs can be opened later. */
	private readonly diffs = new Map<string, readonly acp.Diff[]>();

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

	private readonly onDidChangeActivityEmitter = new vscode.EventEmitter<ChatActivity>();
	readonly onDidChangeActivity = this.onDidChangeActivityEmitter.event;

	private readonly onDidEditFilesEmitter = new vscode.EventEmitter<readonly acp.Diff[]>();
	/** The edits of each tool call that completed, once per tool call. */
	readonly onDidEditFiles = this.onDidEditFilesEmitter.event;
	private readonly completedToolCalls = new Set<string>();

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
			this.transcript.onDidReset(() => this.postReset()),
			service.client.onDidReceiveEvent(event => {
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
					if (event.kind === 'toolCall' && this.activity.step !== this.lastStep) {
						this.fireActivity();
					}
				}
			}),
			service.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.post({ type: 'capabilities', image: service.client.promptCapabilities.image });
					if (this.lastSessionId && state.sessionId !== this.lastSessionId && this.transcript.items.length) {
						this.addSessionLostNotice();
					}
					this.lastSessionId = state.sessionId;
				}
			}),
			service.onDidChangeStatus(status => this.post({ type: 'status', status: toViewStatus(status) })),
			// The branch may have changed outside the editor.
			vscode.window.onDidChangeWindowState(state => state.focused && this.webview && this.postGit()),
			service.client.onDidChangeSettings(settings => this.post({ type: 'settings', settings })),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('gemini.appearance.accent') && this.post({ type: 'accent', solid: solidAccent() })),
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
		return { busy: this.busy, needsPermission: !!permission, ...(step ? { step } : {}) };
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
		if (state.kind === 'ready' && sessionId && state.sessionId !== sessionId) {
			this.addSessionLostNotice();
		}
		this.lastSessionId = state.kind === 'ready' ? state.sessionId : sessionId;
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
			const stopReason = await this.service.client.prompt(content);
			this.undoNote = undefined;
			const notice = stopReasonNotice(stopReason);
			if (notice) {
				this.transcript.addNotice(notice, stopReason === 'refusal' ? 'error' : 'info');
			}
			this.endTurn(Date.now() - started);
			ended = true;
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		} finally {
			if (!ended && this.checkpoints.running) {
				// The turn failed after changing files; they can still be undone.
				this.endTurn(Date.now() - started);
			}
			this.setBusy(false);
		}
	}

	/** Adds the turn's end, offering Retry and, when it changed files, Undo. */
	private endTurn(durationMs: number): void {
		const id = this.transcript.addTurnEnd(durationMs);
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
	 * one, else `text` itself. The agent's own commands go as typed, and win
	 * over a team command with the same name.
	 */
	private async expandCommand(text: string): Promise<string> {
		const invocation = parseInvocation(text);
		if (!invocation || this.service.client.commands.some(c => c.name === invocation.name)) {
			return text;
		}
		const command = (await teamCommands(this.service.client.cwd)).find(c => c.name === invocation.name);
		return command ? expandTeamCommand(command, text) : text;
	}

	private async postCommands(): Promise<void> {
		const team = await teamCommands(this.service.client.cwd);
		this.post({ type: 'commands', commands: mergeCommands(this.service.client.commands, team) });
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
		await this.options.reveal(true);
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
				if (this.pendingAttachments.length) {
					this.post({ type: 'attach', attachments: this.pendingAttachments });
					this.pendingAttachments = [];
				}
				this.postGit();
				// The agent was started with the view (see attach); this retries one that has since stopped.
				this.service.ensureReady().catch(() => undefined);
				break;
			case 'prompt':
				void this.send(message.text, message.attachments ?? []);
				break;
			case 'composerHeight':
				rememberComposerHeight(message.height);
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
				if (folder) {
					void pickBranch(folder).finally(() => this.postGit());
				}
				break;
			}
			case 'createBranchAndCommit':
				void this.commit();
				break;
			case 'undoTurn':
				void this.undoTurn(message.itemId);
				break;
			case 'retry':
				if (this.lastPrompt && message.itemId === this.retryItemId) {
					void this.send(this.lastPrompt.text, this.lastPrompt.attachments);
				}
				break;
		}
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
		void (folder ? readGitHead(folder).catch(() => undefined) : Promise.resolve(undefined))
			.then(branch => this.post({ type: 'git', git: { branch, canCommit } }));
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

	private async openLocation(filePath: string, line: number | undefined): Promise<void> {
		const position = new vscode.Position(Math.max((line ?? 1) - 1, 0), 0);
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(filePath), { selection: new vscode.Range(position, position), preview: true, viewColumn: this.options.editorColumn?.() });
		} catch (err) {
			void vscode.window.showErrorMessage(errorMessage(err));
		}
	}

	private setBusy(busy: boolean): void {
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
	}

	private post(message: ToWebview): void {
		if (message.type !== 'items') {
			// Keep the order: item updates first, then whatever follows them.
			this.items.flush();
		}
		void this.webview?.postMessage(message);
	}

	private getHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
		const nonce = createNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
		const strings: ChatStrings = {
			placeholder: vscode.l10n.t("Ask Gemini anything about this workspace"),
			placeholderFollowUp: vscode.l10n.t("Ask a follow-up"),
			send: vscode.l10n.t("Send (Enter)"),
			stop: vscode.l10n.t("Stop"),
			welcomeTitle: vscode.l10n.t("What are we building?"),
			welcome: vscode.l10n.t("Ask Gemini to explain, change or create code in this workspace. It asks before it edits files."),
			hintMention: vscode.l10n.t("to add files as context"),
			hintNewLine: vscode.l10n.t("for a new line"),
			hintCommands: vscode.l10n.t("for commands"),
			scrollToBottom: vscode.l10n.t("Jump to latest"),
			thinking: vscode.l10n.t("Thinking"),
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
			undoTurn: vscode.l10n.t("Undo"),
			undoTurnTooltip: vscode.l10n.t("Put back the files this reply changed"),
			undoTurnFiles: vscode.l10n.t("Put back the {0} files this reply changed"),
			turnUndone: vscode.l10n.t("Changes undone"),
			retry: vscode.l10n.t("Retry"),
			retryTooltip: vscode.l10n.t("Send this message again"),
			switchBranch: vscode.l10n.t("Branch {0}: switch or create a branch"),
			createBranchAndCommit: vscode.l10n.t("Create Branch & Commit"),
			addContext: vscode.l10n.t("Add context (@)"),
			noFiles: vscode.l10n.t("No matching files"),
			noCommands: vscode.l10n.t("No matching commands"),
			commandFromCli: vscode.l10n.t("Gemini CLI"),
			commandFromTeam: vscode.l10n.t("Team"),
			remove: vscode.l10n.t("Remove"),
			fileTooLarge: vscode.l10n.t("{0} is too large to send."),
			attachFiles: vscode.l10n.t("Attach files. You can also drop files here; hold Shift when dragging from the Explorer."),
			dropFiles: vscode.l10n.t("Drop files to attach"),
			cannotAttach: vscode.l10n.t("{0} can't be attached: only text files, images and PDFs can be dropped here. Use the attach button to add other files."),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>Gemini</title>
</head>
<body data-accent="${solidAccent() ? 'solid' : 'gradient'}">
	<main id="transcript" class="transcript" aria-live="polite"></main>
	<div id="status" class="status" role="status"></div>
	<form id="composer" class="composer">
		<div id="resize" class="composer-resize"></div>
		<button type="button" id="scroll-down" class="scroll-down" hidden><i class="codicon codicon-arrow-down" aria-hidden="true"></i></button>
		<div class="drop-overlay" aria-hidden="true"><i class="codicon codicon-cloud-upload"></i><span id="drop-label"></span></div>
		<div id="picker" class="picker" role="listbox" hidden></div>
		<div id="attachments" class="attachments" hidden></div>
		<textarea id="input" rows="1"></textarea>
		<div class="composer-bar">
			<button type="button" id="attach" class="icon-button"><svg class="paperclip" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5 4.9 9.1a1.8 1.8 0 0 0 2.5 2.5l6-6a3 3 0 0 0-4.2-4.2L3.1 7.5a4.2 4.2 0 0 0 6 6l4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
			<button type="button" id="mention" class="icon-button"><i class="codicon codicon-mention" aria-hidden="true"></i></button>
			<span class="pill-wrap" hidden><select id="mode" class="pill"></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></span>
			<span class="pill-wrap" hidden><select id="model" class="pill"></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></span>
			<span class="spacer"></span>
			<button type="button" id="commit" class="pill commit" hidden><i class="codicon codicon-git-commit" aria-hidden="true"></i><span></span></button>
			<button type="button" id="branch" class="pill branch" hidden><i class="codicon codicon-git-branch" aria-hidden="true"></i><span></span></button>
			<button type="submit" id="send" class="round-button"><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>
			<button type="button" id="stop" class="round-button stop" hidden><i class="codicon codicon-debug-stop" aria-hidden="true"></i></button>
		</div>
	</form>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { Attachment, maxImageBase64Length, supportedImageTypes } from '../acp/attachments';
import { ChatTranscript, toolCallItemId, TranscriptItem } from '../acp/chatTranscript';
import { PendingPermission, PermissionBroker } from '../acp/permissions';
import { buildPromptContent } from '../acp/promptContent';
import { AgentStatus } from '../acp/status';
import { UpdateBatcher } from '../acp/updateBatcher';
import type { AgentClient } from '../acp/agentClient';
import { readGitHead } from '../acp/gitHead';
import { ChatStrings, chatProtocolVersion, FromWebview, statusCommands, ToWebview, ViewStatus } from './chatProtocol';
import { DiffPreview } from './diffPreview';
import { createBranchAndCommit, pickBranch } from './gitActions';
import { rememberModel } from './modelPreference';
import type { FileMatch } from './workspaceFiles';

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
}

/**
 * One chat (plan Phase 1, item 9, and Phase 2B agent-tabs): sends prompts,
 * streams agent messages and thoughts, shows tool-call cards and stops a
 * turn, in whichever webview it is attached to. The transcript lives here,
 * so it survives the webview being hidden, moved or closed.
 */
export class ChatController implements vscode.Disposable {

	private readonly transcript = new ChatTranscript();
	/** Streams item changes to the webview at most about 30 times a second. */
	private readonly items = new UpdateBatcher<TranscriptItem>(items => this.post({ type: 'items', items }));
	private readonly disposables: vscode.Disposable[] = [];
	private webview: vscode.Webview | undefined;
	private webviewListener: vscode.Disposable | undefined;
	private busy = false;
	private lastSessionId: string | undefined;
	/** Proposed edits by transcript item id (tool calls and permission requests), so their diffs can be opened later. */
	private readonly diffs = new Map<string, readonly acp.Diff[]>();

	/** Attachments from the Add to Chat commands that arrived before the view was ready. */
	private pendingAttachments: Attachment[] = [];

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
		this.disposables.push(
			this.onDidChangeActivityEmitter,
			this.onDidEditFilesEmitter,
			this.onDidSendPromptEmitter,
			service.permissions.onDidChange(event => {
				if (event.kind === 'requested') {
					this.diffs.set(event.permission.id, diffsOf(event.permission.request.toolCall.content));
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
						this.diffs.set(toolCallItemId(event.call.id), diffs);
						if (event.call.status === 'completed' && diffs.length && !this.completedToolCalls.has(event.call.id)) {
							this.completedToolCalls.add(event.call.id);
							this.onDidEditFilesEmitter.fire(diffs);
						}
					}
					this.transcript.apply(event);
				}
			}),
			service.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.post({ type: 'capabilities', image: service.client.promptCapabilities.image });
					if (this.lastSessionId && state.sessionId !== this.lastSessionId && this.transcript.items.length) {
						this.transcript.addNotice(vscode.l10n.t("The agent could not continue the earlier session, so it does not remember the messages above."));
					}
					this.lastSessionId = state.sessionId;
				}
			}),
			service.onDidChangeStatus(status => this.post({ type: 'status', status: toViewStatus(status) })),
			// The branch may have changed outside the editor.
			vscode.window.onDidChangeWindowState(state => state.focused && this.webview && this.postGit()),
			service.client.onDidChangeSettings(settings => this.post({ type: 'settings', settings })),
		);
		if (options.git?.commit) {
			const listener = options.git.commit.onDidChange(() => this.postGit());
			this.disposables.push(new vscode.Disposable(() => listener.dispose()));
		}
	}

	get activity(): ChatActivity {
		return { busy: this.busy, needsPermission: this.service.permissions.pendingPermissions.length > 0 };
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
			this.transcript.addNotice(vscode.l10n.t("The agent could not continue the earlier session, so it does not remember the messages above."));
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
		// Build the @-mention file list now, so the picker opens instantly.
		this.fileIndex.warm();
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
		this.transcript.addPrompt(text, attachments);
		this.onDidSendPromptEmitter.fire(text);
		this.setBusy(true);
		const started = Date.now();
		try {
			await this.service.ensureReady();
			// Built after the agent is ready, so it reflects what this agent accepts.
			const content = buildPromptContent(text, attachments, this.service.client.promptCapabilities);
			if (!content.length) {
				throw new Error(vscode.l10n.t("The agent cannot take images, so there was nothing to send."));
			}
			const stopReason = await this.service.client.prompt(content);
			const notice = stopReasonNotice(stopReason);
			if (notice) {
				this.transcript.addNotice(notice, stopReason === 'refusal' ? 'error' : 'info');
			}
			this.transcript.addTurnEnd(Date.now() - started);
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		} finally {
			this.setBusy(false);
		}
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
				if (this.pendingAttachments.length) {
					this.post({ type: 'attach', attachments: this.pendingAttachments });
					this.pendingAttachments = [];
				}
				this.postGit();
				// Start the agent with the view, so the mode and model pickers are there before the first prompt.
				// A failure shows in the view's status line.
				this.service.ensureReady().catch(() => undefined);
				break;
			case 'prompt':
				void this.send(message.text, message.attachments ?? []);
				break;
			case 'searchFiles':
				void this.fileIndex.search(message.query, 30).then(
					files => this.post({ type: 'files', requestId: message.requestId, files }),
					() => this.post({ type: 'files', requestId: message.requestId, files: [] }),
				);
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
				void this.changeSetting(() => this.service.client.setMode(message.id));
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
				void this.commitChanges();
				break;
		}
	}

	private async commitChanges(): Promise<void> {
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

	/** Brings the chat into view so the request can be answered, and shows the first proposed edit. */
	private async revealForPermission(permission: PendingPermission): Promise<void> {
		await this.options.reveal(true);
		const firstDiff = permission.request.toolCall.content?.find(c => c.type === 'diff');
		if (firstDiff) {
			await this.openDiff(permission.id, firstDiff.path, true);
		}
	}

	private async openDiff(itemId: string, filePath: string, preserveFocus: boolean): Promise<void> {
		const diff = this.diffs.get(itemId)?.find(d => d.path === filePath);
		if (diff) {
			await this.diffPreview.show(diff, { preserveFocus });
		}
	}

	private async openLocation(filePath: string, line: number | undefined): Promise<void> {
		const position = new vscode.Position(Math.max((line ?? 1) - 1, 0), 0);
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(filePath), { selection: new vscode.Range(position, position), preview: true });
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
		this.onDidChangeActivityEmitter.fire(this.activity);
	}

	private postReset(): void {
		// The reset carries every item, so pending updates are already in it.
		this.items.clear();
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
			welcome: vscode.l10n.t("Ask Gemini to explain, change or create code in this workspace. It asks before it edits files."),
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
			switchBranch: vscode.l10n.t("Branch {0}: switch or create a branch"),
			createBranchAndCommit: vscode.l10n.t("Create Branch & Commit"),
			addContext: vscode.l10n.t("Add context (@)"),
			noFiles: vscode.l10n.t("No matching files"),
			remove: vscode.l10n.t("Remove"),
			imageTooLarge: vscode.l10n.t("{0} is too large to send."),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>Gemini</title>
</head>
<body>
	<main id="transcript" class="transcript" aria-live="polite"></main>
	<div id="status" class="status" role="status"></div>
	<form id="composer" class="composer">
		<div id="resize" class="composer-resize"></div>
		<div id="picker" class="picker" role="listbox" hidden></div>
		<div id="attachments" class="attachments" hidden></div>
		<textarea id="input" rows="1"></textarea>
		<div class="composer-bar">
			<button type="button" id="mention" class="icon-button"><i class="codicon codicon-mention" aria-hidden="true"></i></button>
			<span class="pill-wrap" hidden><select id="mode" class="pill"></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></span>
			<span class="pill-wrap" hidden><select id="model" class="pill"></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></span>
			<span class="spacer"></span>
			<button type="button" id="commit" class="pill commit" hidden><i class="codicon codicon-git-commit" aria-hidden="true"></i><span></span></button>
			<button type="button" id="branch" class="pill branch" hidden><i class="codicon codicon-git-branch" aria-hidden="true"></i><span></span></button>
			<button type="submit" id="send" class="round-button"><i class="codicon codicon-arrow-up"></i></button>
			<button type="button" id="stop" class="round-button" hidden><i class="codicon codicon-debug-stop"></i></button>
		</div>
	</form>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

function toViewStatus(status: AgentStatus): ViewStatus {
	switch (status.phase) {
		case 'stopped': return { phase: status.phase, text: vscode.l10n.t("Gemini is not running."), actions: [{ label: vscode.l10n.t("Start Agent"), command: 'gemini.restartAgent' }] };
		case 'starting': return { phase: status.phase, text: vscode.l10n.t("Starting the Gemini agent...") };
		case 'restarting': return { phase: status.phase, text: vscode.l10n.t("The agent stopped unexpectedly. Restarting...") };
		case 'ready': return { phase: status.phase, text: '' };
		case 'error': {
			const retry = { label: vscode.l10n.t("Retry"), command: 'gemini.restartAgent' } as const;
			const kind = status.error?.kind;
			const fix = kind === 'auth-required' || kind === 'auth-failed'
				? { label: vscode.l10n.t("Sign In"), command: 'gemini.completeSetupInTerminal' } as const
				: kind === 'project-id-required' || kind === 'project-id-numeric'
					? { label: vscode.l10n.t("Set Project ID"), command: 'gemini.setProjectId' } as const
					: { label: vscode.l10n.t("Show Log"), command: 'gemini.showLog' } as const;
			return { phase: status.phase, text: status.error?.message ?? vscode.l10n.t("The agent needs attention."), actions: [fix, retry] };
		}
	}
}

/** Checks what the webview sent, since it builds attachments from pasted data. */
function isValidAttachment(attachment: Attachment): boolean {
	switch (attachment?.kind) {
		case 'file': return typeof attachment.path === 'string' && path.isAbsolute(attachment.path);
		case 'selection': return typeof attachment.path === 'string' && path.isAbsolute(attachment.path) && typeof attachment.text === 'string';
		case 'image': return supportedImageTypes.has(attachment.mimeType) && typeof attachment.data === 'string' && attachment.data.length <= maxImageBase64Length;
		default: return false;
	}
}

function diffsOf(content: readonly acp.ToolCallContent[] | null | undefined): acp.Diff[] {
	return (content ?? []).flatMap(c => c.type === 'diff' ? [c] : []);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function stopReasonNotice(stopReason: acp.StopReason): string | undefined {
	switch (stopReason) {
		case 'end_turn': return undefined;
		case 'cancelled': return vscode.l10n.t("Stopped.");
		case 'max_tokens': return vscode.l10n.t("The response reached the token limit.");
		case 'max_turn_requests': return vscode.l10n.t("The turn reached the request limit.");
		case 'refusal': return vscode.l10n.t("The agent declined to continue.");
		default: return vscode.l10n.t("The turn ended ({0}).", String(stopReason));
	}
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

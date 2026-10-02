/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { ChatTranscript, toolCallItemId } from '../acp/chatTranscript';
import { PendingPermission } from '../acp/permissions';
import { AgentStatus } from '../acp/status';
import { AgentService } from './agentService';
import { ChatStrings, chatProtocolVersion, FromWebview, statusCommands, ToWebview, ViewStatus } from './chatProtocol';
import { DiffPreview } from './diffPreview';

export const chatViewId = 'gemini.chat';

/**
 * The chat MVP (plan Phase 1, item 9): a webview view that sends text
 * prompts, streams agent messages and thoughts, shows tool-call cards and
 * stops a turn. The transcript lives here, so it survives the view being
 * hidden or moved.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {

	private readonly transcript = new ChatTranscript();
	private readonly disposables: vscode.Disposable[] = [];
	private view: vscode.WebviewView | undefined;
	private busy = false;
	private lastSessionId: string | undefined;
	/** Proposed edits by transcript item id (tool calls and permission requests), so their diffs can be opened later. */
	private readonly diffs = new Map<string, readonly acp.Diff[]>();

	constructor(private readonly extensionUri: vscode.Uri, private readonly service: AgentService, private readonly diffPreview: DiffPreview) {
		this.disposables.push(
			service.permissions.onDidChange(event => {
				if (event.kind === 'requested') {
					this.diffs.set(event.permission.id, diffsOf(event.permission.request.toolCall.content));
					this.transcript.addPermission(event.permission);
					void this.revealForPermission(event.permission);
				} else {
					this.transcript.resolvePermission(event.id, event.outcome);
				}
			}),
			this.transcript,
			this.transcript.onDidChangeItem(item => this.post({ type: 'item', item })),
			this.transcript.onDidReset(() => this.postReset()),
			service.client.onDidReceiveEvent(event => {
				// Only a turn's updates belong in the transcript.
				if (this.busy) {
					if (event.kind === 'toolCall') {
						this.diffs.set(toolCallItemId(event.call.id), diffsOf(event.call.content));
					}
					this.transcript.apply(event);
				}
			}),
			service.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					if (this.lastSessionId && state.sessionId !== this.lastSessionId && this.transcript.items.length) {
						this.transcript.addNotice(vscode.l10n.t("The agent restarted. This is a new session, so it does not remember the messages above."));
					}
					this.lastSessionId = state.sessionId;
				}
			}),
			service.onDidChangeStatus(status => this.post({ type: 'status', status: toViewStatus(status) })),
			service.client.onDidChangeSettings(settings => this.post({ type: 'settings', settings })),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
		view.webview.html = this.getHtml(view.webview, mediaUri);
		const listener = view.webview.onDidReceiveMessage((message: FromWebview) => this.onMessage(message));
		view.onDidDispose(() => {
			listener.dispose();
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}

	/** Sends a prompt as if typed in the view. */
	async send(text: string): Promise<void> {
		if (this.busy || !text.trim()) {
			return;
		}
		this.transcript.addPrompt(text);
		this.setBusy(true);
		try {
			await this.service.ensureReady();
			const stopReason = await this.service.client.prompt(text);
			const notice = stopReasonNotice(stopReason);
			if (notice) {
				this.transcript.addNotice(notice, stopReason === 'refusal' ? 'error' : 'info');
			}
		} catch (err) {
			this.transcript.addNotice(errorMessage(err), 'error');
		} finally {
			this.setBusy(false);
		}
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
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private onMessage(message: FromWebview): void {
		switch (message.type) {
			case 'ready':
				if (message.protocol !== chatProtocolVersion) {
					void vscode.window.showWarningMessage(vscode.l10n.t("The Gemini chat view's script is out of date. Rebuild it with \"npm run gulp compile-extension-media\" (or keep \"npm run watch\" running) and reload the window."));
				}
				this.postReset();
				// Start the agent with the view, so the mode and model pickers are there before the first prompt.
				// A failure shows in the view's status line.
				this.service.ensureReady().catch(() => undefined);
				break;
			case 'prompt':
				void this.send(message.text);
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
				void this.changeSetting(() => this.service.client.setModel(message.id));
				break;
		}
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
		if (this.view) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(`${chatViewId}.focus`);
		}
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
		void vscode.commands.executeCommand('setContext', 'gemini.chatBusy', busy);
		this.post({ type: 'busy', busy });
	}

	private postReset(): void {
		this.post({ type: 'reset', items: this.transcript.items, busy: this.busy, status: toViewStatus(this.service.status), settings: this.service.client.settings });
	}

	private post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
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
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>Gemini</title>
</head>
<body>
	<main id="transcript" class="transcript" aria-live="polite"></main>
	<div id="status" class="status" role="status"></div>
	<form id="composer" class="composer">
		<textarea id="input" rows="1"></textarea>
		<div class="composer-bar">
			<select id="mode" class="pill" hidden></select>
			<select id="model" class="pill" hidden></select>
			<span class="spacer"></span>
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

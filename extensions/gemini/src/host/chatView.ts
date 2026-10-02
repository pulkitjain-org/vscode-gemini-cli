/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { ChatTranscript } from '../acp/chatTranscript';
import { AgentStatus } from '../acp/status';
import { AgentService } from './agentService';
import { ChatStrings, FromWebview, ToWebview, ViewStatus } from './chatProtocol';

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

	constructor(private readonly extensionUri: vscode.Uri, private readonly service: AgentService) {
		this.disposables.push(
			this.transcript,
			this.transcript.onDidChangeItem(item => this.post({ type: 'item', item })),
			this.transcript.onDidReset(() => this.postReset()),
			service.client.onDidReceiveEvent(event => {
				// Only a turn's updates belong in the transcript.
				if (this.busy) {
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
			this.transcript.addNotice(err instanceof Error ? err.message : String(err), 'error');
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
				this.postReset();
				break;
			case 'prompt':
				void this.send(message.text);
				break;
			case 'stop':
				void this.service.client.cancel();
				break;
			case 'clear':
				if (!this.busy) {
					this.transcript.clear();
				}
				break;
		}
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.post({ type: 'busy', busy });
	}

	private postReset(): void {
		this.post({ type: 'reset', items: this.transcript.items, busy: this.busy, status: toViewStatus(this.service.status) });
	}

	private post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
		const nonce = createNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.css'));
		const strings: ChatStrings = {
			placeholder: vscode.l10n.t("Ask Gemini. Enter sends, Shift+Enter adds a line."),
			send: vscode.l10n.t("Send"),
			stop: vscode.l10n.t("Stop"),
			clear: vscode.l10n.t("Clear"),
			thinking: vscode.l10n.t("Thinking"),
			empty: vscode.l10n.t("Ask Gemini about this workspace."),
			plan: vscode.l10n.t("Plan"),
			unknownUpdate: vscode.l10n.t("Update not shown in this version: {0}"),
			terminal: vscode.l10n.t("Terminal output"),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${style}" rel="stylesheet">
	<title>Gemini</title>
</head>
<body>
	<div id="status" class="status" role="status"></div>
	<main id="transcript" class="transcript" aria-live="polite"></main>
	<form id="composer" class="composer">
		<textarea id="input" rows="3"></textarea>
		<div class="actions">
			<button type="button" id="clear" class="secondary"></button>
			<button type="button" id="stop" class="secondary" hidden></button>
			<button type="submit" id="send"></button>
		</div>
	</form>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

function toViewStatus(status: AgentStatus): ViewStatus {
	switch (status.phase) {
		case 'stopped': return { phase: status.phase, text: vscode.l10n.t("The agent starts when you send a message.") };
		case 'starting': return { phase: status.phase, text: vscode.l10n.t("Starting the Gemini agent...") };
		case 'restarting': return { phase: status.phase, text: vscode.l10n.t("The agent stopped unexpectedly. Restarting...") };
		case 'ready': return { phase: status.phase, text: '' };
		case 'error': return { phase: status.phase, text: status.error?.message ?? vscode.l10n.t("The agent needs attention.") };
	}
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

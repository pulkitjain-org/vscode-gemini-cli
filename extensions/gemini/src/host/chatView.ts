/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Attachment } from '../acp/attachments';
import { AgentService } from './agentService';
import { ChatController } from './chatController';
import { DiffPreview } from './diffPreview';
import { WorkspaceFileIndex } from './workspaceFiles';

export const chatViewId = 'gemini.chat';

/**
 * The sidebar chat: a quick chat about the open workspace, on the agent
 * service's own session. Agents from the Agents pane open in editor tabs.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {

	readonly controller: ChatController;
	private view: vscode.WebviewView | undefined;

	constructor(extensionUri: vscode.Uri, service: AgentService, diffPreview: DiffPreview, fileIndex: WorkspaceFileIndex) {
		this.controller = new ChatController(extensionUri, service, diffPreview, fileIndex, {
			reveal: preserveFocus => this.reveal(preserveFocus),
			busyContextKey: 'gemini.chatBusy',
			git: { folder: () => workspaceFolder() },
			workspace: () => {
				const folder = workspaceFolder();
				return folder ? { folder, cwd: folder, worktree: false } : undefined;
			},
		});
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const webview = view.webview;
		this.controller.attach(webview);
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
			}
			this.controller.detach(webview);
		});
	}

	send(text: string, attachments: readonly Attachment[] = []): Promise<void> {
		return this.controller.send(text, attachments);
	}

	attach(attachments: readonly Attachment[]): Promise<void> {
		return this.controller.addAttachments(attachments);
	}

	newChat(): Promise<void> {
		return this.controller.newChat();
	}

	dispose(): void {
		this.controller.dispose();
	}

	private async reveal(preserveFocus: boolean): Promise<void> {
		if (this.view) {
			this.view.show(preserveFocus);
		} else {
			await vscode.commands.executeCommand(`${chatViewId}.focus`);
		}
	}
}

function workspaceFolder(): string | undefined {
	return vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
}

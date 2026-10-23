/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the composer attaches: files picked or dropped, context from the Add
// to Chat commands (held until the view is ready), the @-mention picker's file
// list, and chips for the Jira tickets, GitLab items and Figma frames it names.

import * as vscode from 'vscode';
import type { Attachment } from '../../acp/attachments';
import { attachmentsForFiles } from '../addToChat';
import type { FromWebview, ToWebview } from '../chatProtocol';
import type { ChatControllerOptions, FileSearch } from './chatOptions';

export type AttachmentMessage = Extract<FromWebview, { readonly type: 'pickFiles' | 'attachUris' | 'searchFiles' | 'resolveToolRef' | 'openToolRef' | 'pickToolItem' }>;

export class ChatAttachments implements vscode.Disposable {

	/** Attachments from the Add to Chat commands that arrived before the view was ready. */
	private pending: Attachment[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly fileIndex: FileSearch,
		private readonly options: Pick<ChatControllerOptions, 'toolChips' | 'workspace' | 'reveal'>,
		/** Whether a webview shows the chat. */
		private readonly isAttached: () => boolean,
		/** Whether the view's script has said it is ready. */
		isViewReady: () => boolean,
		private readonly post: (message: ToWebview) => void,
	) {
		const toolChips = options.toolChips?.();
		if (toolChips) {
			this.disposables.push(toolChips.onDidChange(() => isViewReady() && void this.postToolRefs()));
		}
	}

	/** Adds context to the composer (Add File / Add Selection to Chat), showing the chat first. */
	async add(attachments: readonly Attachment[]): Promise<void> {
		if (!attachments.length) {
			return;
		}
		if (this.isAttached()) {
			this.post({ type: 'attach', attachments });
		} else {
			this.pending.push(...attachments);
		}
		// Focus the chat, so the user can type about what they just added.
		await this.options.reveal(false);
	}

	/** The view loaded: gives it what was added meanwhile. */
	postPending(): void {
		if (this.pending.length) {
			this.post({ type: 'attach', attachments: this.pending });
			this.pending = [];
		}
	}

	/** Tells the view which tools are connected, so it can turn tickets and links into chips. */
	async postToolRefs(): Promise<void> {
		const chips = this.options.toolChips?.();
		const context = chips ? await chips.context(this.options.workspace?.()?.cwd).catch(() => undefined) : undefined;
		this.post({ type: 'toolRefs', context: context ?? { connected: [] } });
	}

	onMessage(message: AttachmentMessage): void {
		switch (message.type) {
			case 'pickFiles':
				void this.pickFiles();
				break;
			case 'resolveToolRef': {
				const chips = this.options.toolChips?.();
				void chips?.resolve(message.ref).then(attachment => this.post({ type: 'toolRefResolved', attachment }));
				break;
			}
			case 'openToolRef':
				void this.options.toolChips?.()?.open(message.ref);
				break;
			case 'pickToolItem': {
				const chips = this.options.toolChips?.();
				void chips?.pick(message.tool).then(ref => {
					if (ref) {
						this.post({ type: 'attachToolRef', ref });
					}
				});
				break;
			}
			case 'attachUris': {
				const uris = message.uris.map(uri => vscode.Uri.parse(uri)).filter(uri => uri.scheme === 'file');
				void attachmentsForFiles(uris).then(attachments => this.add(attachments));
				break;
			}
			case 'searchFiles':
				void this.fileIndex.search(message.query, 30).then(
					files => this.post({ type: 'files', requestId: message.requestId, files }),
					() => this.post({ type: 'files', requestId: message.requestId, files: [] }),
				);
				break;
		}
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
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
			await this.add(await attachmentsForFiles(uris));
		}
	}
}

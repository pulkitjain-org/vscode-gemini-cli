/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The files a chat opens: a proposed edit's diff, a file and line a tool call
// or a reply names, and a turn's trace file. Proposed edits are kept in memory
// only, by transcript item id, so their diffs can be opened after the turn.

import * as os from 'node:os';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { dropOldest } from '../../acp/chatTurns';
import { errorMessage } from '../../acp/errors';
import { fileNamePattern } from '../../acp/folderFiles';
import { isTraceFile } from '../../acp/hostAllowlists';
import type { FromWebview } from '../chatProtocol';
import type { DiffPreview } from '../diffPreview';
import type { ChatControllerOptions } from './chatOptions';

export type FileLinkMessage = Extract<FromWebview, { readonly type: 'openDiff' | 'openLocation' | 'openPath' | 'openTrace' }>;

export class ChatFileLinks {

	/** Proposed edits by transcript item id (tool calls and permission requests), so their diffs can be opened later. */
	private readonly diffs = new Map<string, readonly acp.Diff[]>();

	constructor(
		private readonly diffPreview: DiffPreview,
		/** Where a file a reply names is looked for: the agent's folder. */
		private readonly folder: () => string,
		private readonly options: Pick<ChatControllerOptions, 'editorColumn'>,
	) { }

	onMessage(message: FileLinkMessage): void {
		switch (message.type) {
			case 'openDiff':
				void this.openDiff(message.itemId, message.path, false);
				break;
			case 'openLocation':
				void this.openLocation(message.path, message.line);
				break;
			case 'openPath':
				void this.openPath(message.path, message.line);
				break;
			case 'openTrace':
				// Only a trace GeminiCode wrote, never another file the page names.
				if (isTraceFile(message.file, os.homedir())) {
					void vscode.workspace.openTextDocument(message.file).then(doc => vscode.window.showTextDocument(doc, { preview: false }), () => undefined);
				}
				break;
		}
	}

	/** Keeps the proposed edits of transcript item `itemId`, to open their diffs later. */
	remember(itemId: string, diffs: readonly acp.Diff[]): void {
		if (diffs.length) {
			// Re-inserting keeps the most recent edits when old ones are dropped.
			this.diffs.delete(itemId);
			this.diffs.set(itemId, diffs);
			dropOldest(this.diffs);
		}
	}

	/** Forgets every proposed edit, as the conversation is cleared. */
	clear(): void {
		this.diffs.clear();
	}

	async openDiff(itemId: string, filePath: string, preserveFocus: boolean): Promise<void> {
		const diff = this.diffs.get(itemId)?.find(d => d.path === filePath);
		if (diff) {
			await this.diffPreview.show(diff, { preserveFocus, viewColumn: await this.options.editorColumn?.() });
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
		const folder = this.folder();
		const direct = path.resolve(folder, name);
		if (await isFile(direct)) {
			return this.openLocation(direct, line);
		}
		const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, fileNamePattern(name)), '**/{node_modules,.git}/**', 20);
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
			await vscode.window.showTextDocument(vscode.Uri.file(filePath), { selection: new vscode.Range(position, position), preview: true, viewColumn: await this.options.editorColumn?.() });
		} catch (err) {
			void vscode.window.showErrorMessage(errorMessage(err));
		}
	}
}

export async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await vscode.workspace.fs.stat(vscode.Uri.file(filePath))).type === vscode.FileType.File;
	} catch {
		return false;
	}
}

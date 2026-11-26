/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The files a chat opens: a proposed edit's diff, a file and line a tool call
// or a reply names, and a turn's trace file. Proposed edits are kept in memory
// only, by transcript item id, so their diffs can be opened after the turn:
// the latest 200, and no more than 20 MB of text before and after. A Markdown
// file the agent created opens in the rich Markdown editor instead, where the
// user edits it and comments for the agent: from its chip, from a reply's link,
// and by itself once the agent has written it. Plan mode's plan opens in Plan Review.

import * as os from 'node:os';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { BoundedStore, diffBytes, ToolOutputStore } from '../../acp/chatMemory';
import { maxRemembered } from '../../acp/chatTurns';
import { isInside } from '../../acp/fileAccess';
import { fileNamePattern, knownFileNamed } from '../../acp/folderFiles';
import { isTraceFile } from '../../acp/hostAllowlists';
import { background } from '../background';
import { traceFolders } from '../traceCommand';
import type { FromWebview } from '../chatProtocol';
import type { DiffPreview } from '../diffPreview';
import type { ChatControllerOptions } from './chatOptions';
import { showError } from '../errorNotice';

/** How much proposed edits' text a chat keeps, before and after, for their diffs: the oldest go first. */
const maxDiffBytes = 20 * 1024 * 1024;
/** How much of tools' long output a chat keeps whole, for Show All. */
const maxOutputBytes = 16 * 1024 * 1024;
/** How many Markdown files the agent created a chat remembers, to open in the rich Markdown editor. */
const maxCreated = 200;

export type FileLinkMessage = Extract<FromWebview, { readonly type: 'openDiff' | 'openLocation' | 'openPath' | 'openTrace' }>;

export class ChatFileLinks {

	/** Proposed edits by transcript item id (tool calls and permission requests), so their diffs can be opened later. */
	private readonly diffs = new BoundedStore<string, readonly acp.Diff[]>(maxDiffBytes, diffBytes, maxRemembered);
	/**
	 * Tools' full output, for a tool card that shows only the first and last
	 * lines of a long one to fetch on Show All: the transcript then keeps the
	 * trimmed text (`ToolOutputStore.put` returns it) and this the whole.
	 */
	readonly outputs = new ToolOutputStore(maxOutputBytes);
	/** The Markdown files the agent created in this chat, which open in the rich Markdown editor; the latest {@link maxCreated}. */
	private readonly createdMarkdown = new Set<string>();

	constructor(
		private readonly diffPreview: DiffPreview,
		/** Where a file a reply names is looked for: the agent's folder. */
		private readonly folder: () => string,
		private readonly options: Pick<ChatControllerOptions, 'editorColumn' | 'openMarkdown' | 'created'>,
		/** Opens a Markdown file in Plan Review when it is the chat's plan; false when it isn't. */
		private readonly openPlan?: (file: string) => boolean,
		/** Writes a plan the CLI deleted again, from the session's saved calls. */
		private readonly rebuildPlan?: (file: string) => Promise<void>,
		/** The session is in Plan mode, whose plan opens from Review Plan rather than by itself. */
		private readonly inPlanMode?: () => boolean,
		/** The plans this chat's turns wrote, oldest first, which live in the CLI's session folder rather than the agent's. */
		private readonly planFiles?: () => readonly string[],
	) { }

	onMessage(message: FileLinkMessage): void {
		switch (message.type) {
			case 'openDiff':
				void this.openDiff(message.itemId, message.path, false);
				break;
			case 'openLocation':
				background('Opening a file from the chat', this.openLocation(message.path, message.line));
				break;
			case 'openPath':
				background('Opening a file a reply names', this.openPath(message.path, message.line));
				break;
			case 'openTrace':
				// Only a trace GeminiCode wrote, never another file the page names.
				if (isTraceFile(message.file, [...traceFolders(), os.homedir()])) {
					void vscode.workspace.openTextDocument(message.file).then(doc => vscode.window.showTextDocument(doc, { preview: false }), () => undefined);
				}
				break;
		}
	}

	/** Keeps the proposed edits of transcript item `itemId`, to open their diffs later. */
	remember(itemId: string, diffs: readonly acp.Diff[]): void {
		if (diffs.length) {
			// Setting again keeps the most recent edits when old ones are dropped.
			this.diffs.set(itemId, diffs);
		}
		for (const diff of diffs) {
			if (isMarkdown(diff.path) && !diff.oldText) {
				this.createdMarkdown.delete(diff.path);
				this.createdMarkdown.add(diff.path);
				if (this.createdMarkdown.size > maxCreated) {
					this.createdMarkdown.delete(this.createdMarkdown.values().next().value!);
				}
			}
		}
	}

	/** Whether `file` is a Markdown file the agent created here, which the chat opens itself; Follow the agent leaves it alone. */
	opensItself(file: string): boolean {
		return !!this.options.openMarkdown && this.createdHere(file);
	}

	/** A Markdown file the agent created: seen in this chat's edits, or in its changes after a reload. */
	private createdHere(file: string): boolean {
		return isMarkdown(file) && (this.createdMarkdown.has(file) || !!this.options.created?.(file));
	}

	/**
	 * A turn's edits completed: a Markdown file the agent created opens in the
	 * rich Markdown editor beside the chat, in place of its proposed diff, with
	 * focus left in the chat. Not Plan mode's plan, which has Review Plan.
	 */
	async openWritten(diffs: readonly acp.Diff[]): Promise<void> {
		const created = diffs.filter(diff => isMarkdown(diff.path) && !diff.oldText).at(-1);
		if (!created || this.inPlanMode?.() || !await isFile(created.path)) {
			return;
		}
		await this.options.openMarkdown?.(created.path, true);
	}

	/** Forgets every proposed edit and tool output, as the conversation is cleared. */
	clear(): void {
		this.diffs.clear();
		this.outputs.clear();
		this.createdMarkdown.clear();
	}

	async openDiff(itemId: string, filePath: string, preserveFocus: boolean): Promise<void> {
		const diff = this.diffs.get(itemId)?.find(d => d.path === filePath);
		if (isMarkdown(filePath)) {
			await this.rebuildPlan?.(filePath);
		}
		// A Markdown file the agent wrote from scratch reads better rendered than as a diff of new lines, and can be edited and commented there; Plan mode's plan opens in Plan Review.
		if (isMarkdown(filePath) && (!diff || !diff.oldText) && await isFile(filePath) && (this.openPlan?.(filePath) || await this.openMarkdown(filePath, preserveFocus))) {
			return;
		}
		if (diff) {
			await this.diffPreview.show(diff, { preserveFocus, viewColumn: await this.options.editorColumn?.() });
			return;
		}
		// Proposed edits are kept in memory only, so a restored or old chat has
		// none: show the file as it is now instead.
		void vscode.window.showInformationMessage(vscode.l10n.t("The proposed change is no longer available, so the file is shown as it is now."));
		await this.openLocation(filePath, undefined);
	}

	/** Opens a Markdown file in the rich Markdown editor, else in the preview; false when neither opens. */
	private async openMarkdown(filePath: string, preserveFocus: boolean): Promise<boolean> {
		return await this.options.openMarkdown?.(filePath, preserveFocus) || this.openPreview(filePath, preserveFocus);
	}

	/** Opens `filePath` in the Markdown preview, beside the chat like its diffs; false when the preview can't open. */
	private async openPreview(filePath: string, preserveFocus: boolean): Promise<boolean> {
		try {
			await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), 'vscode.markdown.preview.editor', { viewColumn: await this.options.editorColumn?.(), preserveFocus, preview: true });
			return true;
		} catch {
			return false;
		}
	}

	/** Opens a file the reply names: by its path from the agent's folder, else by its name anywhere in the workspace. */
	private async openPath(name: string, line: number | undefined): Promise<void> {
		if (typeof name !== 'string' || !name || name.length > 500) {
			return;
		}
		const folder = this.folder();
		const direct = path.resolve(folder, name);
		// Only a path in the agent's folder opens directly: a name with `..` in it falls through to the search, which the folder scopes.
		if (isInside(folder, direct) && await isFile(direct)) {
			// A Markdown file the agent created opens where it was shown, unless the link names a line.
			if (line === undefined && this.createdHere(direct) && await this.openMarkdown(direct, false)) {
				return;
			}
			return this.openLocation(direct, line);
		}
		// A file the chat wrote outside the folder, such as Plan mode's plan, opens as its chip does.
		const known = knownFileNamed(name, [...this.planFiles?.() ?? [], ...this.createdMarkdown]);
		if (known) {
			if (isMarkdown(known)) {
				await this.rebuildPlan?.(known);
			}
			if (await isFile(known)) {
				if (line === undefined && isMarkdown(known) && (this.openPlan?.(known) || await this.openMarkdown(known, false))) {
					return;
				}
				return this.openLocation(known, line);
			}
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
		// The line comes from the page: only a finite number is a line.
		const row = typeof line === 'number' && Number.isFinite(line) ? Math.max(Math.floor(line) - 1, 0) : 0;
		try {
			const position = new vscode.Position(row, 0);
			await vscode.window.showTextDocument(vscode.Uri.file(filePath), { selection: new vscode.Range(position, position), preview: true, viewColumn: await this.options.editorColumn?.() });
		} catch {
			// The editor's own text names the whole URI; the file's name is what the user clicked.
			void showError(vscode.l10n.t("Could not open {0}.", path.basename(filePath)));
		}
	}
}

/** The extensions the Markdown preview opens. */
function isMarkdown(filePath: string): boolean {
	return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(filePath);
}

export async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await vscode.workspace.fs.stat(vscode.Uri.file(filePath))).type === vscode.FileType.File;
	} catch {
		return false;
	}
}

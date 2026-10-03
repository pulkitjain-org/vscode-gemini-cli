/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, EditedFile, formatCounts } from '../acp/agentChanges';

export const changesViewId = 'gemini.agentChanges';
/** Read-only documents holding a file's text from before an agent's first edit. */
const originalScheme = 'gemini-agent-original';

/** The agent whose changes the view shows. */
export interface ChangesSource {
	readonly agentId: string;
	readonly title: string;
	readonly folder: string;
	readonly changes: AgentChanges;
}

/**
 * The Changes view: the files the agent in front edited, each opening a diff
 * from before the agent's first edit to the file on disk, and all of them
 * together in the multi-diff editor. A native view in the secondary sidebar, so
 * it resizes like any other.
 */
export class ChangesView implements vscode.TreeDataProvider<EditedFile>, vscode.TextDocumentContentProvider, vscode.Disposable {

	private source: ChangesSource | undefined;
	private sourceListener: { dispose(): void } | undefined;
	private readonly tree: vscode.TreeView<EditedFile>;
	private readonly disposables: vscode.Disposable[] = [];

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	/** `lookup` finds an agent's changes by id, for documents opened from an earlier source. */
	constructor(private readonly lookup: (agentId: string) => AgentChanges | undefined) {
		this.tree = vscode.window.createTreeView(changesViewId, { treeDataProvider: this });
		this.disposables.push(
			this.tree,
			this.onDidChangeTreeDataEmitter,
			vscode.workspace.registerTextDocumentContentProvider(originalScheme, this),
			vscode.commands.registerCommand('gemini.changes.openFile', (file?: EditedFile) => file && this.openFile(file)),
			vscode.commands.registerCommand('gemini.changes.openAll', () => this.source && this.openAll(this.source)),
			vscode.commands.registerCommand('gemini.changes.clear', () => this.source?.changes.clear()),
		);
		this.update();
	}

	/** Shows `source`'s changes; `undefined` empties the view. */
	show(source: ChangesSource | undefined): void {
		if (source?.agentId === this.source?.agentId && source?.title === this.source?.title) {
			return;
		}
		this.sourceListener?.dispose();
		this.source = source;
		this.sourceListener = source?.changes.onDidChange(() => this.update());
		this.update();
	}

	/** Opens every file `source` changed in the multi-diff editor. */
	async openAll(source: ChangesSource): Promise<void> {
		const files = source.changes.files;
		if (!files.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t("{0} has not changed any files.", source.title));
			return;
		}
		const resources = files.map(file => {
			const uri = vscode.Uri.file(file.path);
			return [uri, file.created || file.original === undefined ? undefined : this.originalUri(source.agentId, file), uri];
		});
		await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t("Changes by {0}", source.title), resources);
	}

	// --- Tree

	getTreeItem(file: EditedFile): vscode.TreeItem {
		const item = new vscode.TreeItem(vscode.Uri.file(file.path));
		const folder = this.source?.folder;
		const relativeDir = folder ? path.relative(folder, path.dirname(file.path)) : path.dirname(file.path);
		const counts = formatCounts(file);
		item.description = relativeDir && !relativeDir.startsWith('..') ? `${counts}  ${relativeDir}` : counts;
		item.tooltip = file.created ? vscode.l10n.t("{0} (new file)", file.path) : file.path;
		item.command = { command: 'gemini.changes.openFile', title: vscode.l10n.t("Open Changes"), arguments: [file] };
		item.contextValue = 'file';
		return item;
	}

	getChildren(file?: EditedFile): EditedFile[] {
		return file || !this.source ? [] : [...this.source.changes.files];
	}

	// --- Originals

	provideTextDocumentContent(uri: vscode.Uri): string {
		const [, agentId] = uri.path.split('/');
		return this.lookup(agentId)?.file(uri.query)?.original ?? '';
	}

	dispose(): void {
		this.sourceListener?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async openFile(file: EditedFile): Promise<void> {
		const uri = vscode.Uri.file(file.path);
		const source = this.source;
		if (!source || file.original === undefined) {
			await vscode.commands.executeCommand('vscode.open', uri);
			return;
		}
		const name = path.basename(file.path);
		const title = file.created ? vscode.l10n.t("{0} (new, by {1})", name, source.title) : vscode.l10n.t("{0} (changes by {1})", name, source.title);
		await vscode.commands.executeCommand('vscode.diff', this.originalUri(source.agentId, file), uri, title, { preview: true });
	}

	private originalUri(agentId: string, file: EditedFile): vscode.Uri {
		// The file name stays last so the editor picks the right language.
		return vscode.Uri.from({ scheme: originalScheme, path: `/${agentId}/${path.basename(file.path)}`, query: file.path });
	}

	private update(): void {
		const totals = this.source?.changes.totals;
		this.tree.description = this.source?.title;
		this.tree.message = !this.source
			? vscode.l10n.t("Open an agent to see the files it changed.")
			: totals?.files ? undefined : vscode.l10n.t("{0} has not changed any files yet.", this.source.title);
		this.tree.badge = totals?.files ? { value: totals.files, tooltip: vscode.l10n.t("{0} files changed", totals.files) } : undefined;
		void vscode.commands.executeCommand('setContext', 'gemini.agentHasChanges', !!totals?.files);
		this.onDidChangeTreeDataEmitter.fire();
	}
}

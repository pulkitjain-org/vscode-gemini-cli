/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { diffLines, hunkLines, splitLines } from '../acp/lineDiff';
import { ChangesSource } from './changesView';
import { createNonce, escapeAttribute } from './webviewHtml';
import { ChangedFileView, ChangesPanelStrings, ChangesPanelView, FromChangesPanel, ToChangesPanel } from './panelProtocol';
import { deleteFile, replaceFileText } from './workspaceFileSystem';

export const changesPanelId = 'gemini.changesPanel';

/** How long after an edit the diffs are worked out again. */
const refreshDelayMs = 150;
/** Files past this many show without their diffs; the editor has them all. */
const maxDiffedFiles = 40;

/**
 * Agents mode's Changes panel, on the right: a live diff of what the agent in
 * front changed, with Keep and Undo on each change and file, and Keep All,
 * Undo All, Commit or Merge Back for the lot. Keep and Undo run the same
 * commands as the CodeLenses in the editor, so both stay in step. Diffs are
 * worked out only while the panel is visible.
 */
export class ChangesPanel implements vscode.WebviewViewProvider, vscode.Disposable {

	private view: vscode.WebviewView | undefined;
	private source: ChangesSource | undefined;
	private sourceListener: vscode.Disposable | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped on every refresh, so a slower earlier one doesn't overwrite a later one. */
	private generation = 0;
	/** Each file's last diff, so typing in one file re-diffs only that file. */
	private readonly diffs = new Map<string, { readonly original: string; readonly current: string; readonly hunks: NonNullable<ChangedFileView['hunks']> }>();
	/** The last view posted, to skip posting the same one again. */
	private lastView: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(changesPanelId, this),
			vscode.workspace.onDidChangeTextDocument(e => this.source?.changes.file(e.document.uri.fsPath) && this.schedule()),
		);
	}

	show(source: ChangesSource | undefined): void {
		this.sourceListener?.dispose();
		if (this.source !== source) {
			this.diffs.clear();
		}
		this.source = source;
		this.sourceListener = source?.changes.onDidChange(() => this.schedule());
		this.schedule(0);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		view.webview.onDidReceiveMessage((message: FromChangesPanel) => this.onMessage(message));
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.lastView = undefined;
				this.schedule(0);
			}
		});
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.sourceListener?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private schedule(delay = refreshDelayMs): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), delay);
	}

	private async refresh(): Promise<void> {
		const view = this.view;
		if (!view?.visible) {
			return;
		}
		const generation = ++this.generation;
		const panelView = await this.build(this.source);
		const json = JSON.stringify(panelView);
		// Not when a later refresh started, the view closed meanwhile (it throws once disposed), or nothing changed.
		if (generation === this.generation && this.view === view && json !== this.lastView) {
			this.lastView = json;
			void view.webview.postMessage({ type: 'view', view: panelView } satisfies ToChangesPanel);
			view.badge = panelView.totals.files ? { value: panelView.totals.files, tooltip: vscode.l10n.t("{0} files changed", panelView.totals.files) } : undefined;
			view.description = this.source?.title;
		}
	}

	private async build(source: ChangesSource | undefined): Promise<ChangesPanelView> {
		if (!source) {
			return { totals: { files: 0, added: 0, removed: 0 }, files: [] };
		}
		const files = await Promise.all(source.changes.files.map(async (file, i): Promise<ChangedFileView> => {
			const dir = path.relative(source.folder, path.dirname(file.path));
			const base = { path: file.path, name: path.basename(file.path), dir: dir.startsWith('..') ? path.dirname(file.path) : dir, created: file.created, added: file.added, removed: file.removed };
			if (file.original === undefined || i >= maxDiffedFiles) {
				return base;
			}
			const current = await currentText(file.path);
			if (current === undefined) {
				return base;
			}
			const cached = this.diffs.get(file.path);
			if (cached?.original === file.original && cached.current === current) {
				return { ...base, hunks: cached.hunks };
			}
			const original = splitLines(file.original);
			const modified = splitLines(current);
			const hunks = diffLines(original, modified).map((hunk, index) => ({ index, ...hunkLines(original, modified, hunk, 1) }));
			this.diffs.set(file.path, { original: file.original, current, hunks });
			return { ...base, hunks };
		}));
		for (const filePath of this.diffs.keys()) {
			if (!source.changes.file(filePath)) {
				this.diffs.delete(filePath);
			}
		}
		const busy = source.busy();
		return {
			agent: { title: source.title, busy, ...(source.branch ? { branch: source.branch } : {}), canCommit: !!source.commit && !busy && files.length > 0 },
			totals: source.changes.totals,
			files,
		};
	}

	private async onMessage(message: FromChangesPanel): Promise<void> {
		const source = this.source;
		switch (message.type) {
			case 'ready':
				this.lastView = undefined;
				this.schedule(0);
				return;
		}
		const filePath = message.type === 'keep' || message.type === 'undo' || message.type === 'keepFile' || message.type === 'undoFile' || message.type === 'openFile' ? message.path : undefined;
		// Only files the agent changed.
		if (filePath !== undefined && !source?.changes.file(filePath)) {
			return;
		}
		switch (message.type) {
			case 'keep':
				await vscode.commands.executeCommand('gemini.review.keepChange', vscode.Uri.file(message.path).toString(), message.index);
				return;
			case 'undo':
				await vscode.commands.executeCommand('gemini.review.undoChange', vscode.Uri.file(message.path).toString(), message.index);
				return;
			case 'keepFile':
				await vscode.commands.executeCommand('gemini.review.keepFile', vscode.Uri.file(message.path).toString());
				return;
			case 'undoFile':
				await vscode.commands.executeCommand('gemini.review.undoFile', vscode.Uri.file(message.path).toString());
				return;
			case 'openFile':
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path), { viewColumn: source?.editorColumn(), preview: true });
				return;
			case 'openAll':
				await vscode.commands.executeCommand('gemini.changes.openAll');
				return;
			case 'keepAll':
				return source && this.keepAll(source);
			case 'undoAll':
				return source && this.undoAll(source);
			case 'commit':
				return source?.commit?.();
			case 'mergeBack':
				return source?.mergeBack?.();
		}
	}

	private async keepAll(source: ChangesSource): Promise<void> {
		for (const file of source.changes.files) {
			const text = await currentText(file.path);
			if (text !== undefined) {
				source.changes.keep(file.path, text, text);
			}
		}
	}

	private async undoAll(source: ChangesSource): Promise<void> {
		const files = source.changes.files.filter(file => file.original !== undefined);
		if (!files.length) {
			return;
		}
		const undo = vscode.l10n.t("Undo All");
		const created = files.filter(file => file.created).length;
		const detail = created ? vscode.l10n.t("Files the agent created are deleted ({0}).", created) : undefined;
		const message = files.length === 1
			? vscode.l10n.t("Undo {0}'s changes to {1}?", source.title, path.basename(files[0].path))
			: vscode.l10n.t("Undo {0}'s changes to {1} files?", source.title, files.length);
		if (await vscode.window.showWarningMessage(message, { modal: true, detail }, undo) !== undo) {
			return;
		}
		for (const file of files) {
			try {
				const current = await currentText(file.path) ?? '';
				if (file.created) {
					await deleteFile(file.path);
				} else {
					await replaceFileText(file.path, file.original!, true);
				}
				source.changes.record([{ path: file.path, oldText: current, newText: file.created ? '' : file.original! }]);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not undo the changes to {0}: {1}", path.basename(file.path), errorMessage(err)));
			}
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: ChangesPanelStrings = {
			empty: vscode.l10n.t("No changes yet. Files the agent changes show here as it works."),
			noAgent: vscode.l10n.t("Open an agent to see what it changed."),
			keep: vscode.l10n.t("Keep"),
			undo: vscode.l10n.t("Undo"),
			keepAll: vscode.l10n.t("Keep All"),
			undoAll: vscode.l10n.t("Undo All"),
			keepFile: vscode.l10n.t("Keep this file's changes"),
			undoFile: vscode.l10n.t("Undo this file's changes"),
			openFile: vscode.l10n.t("Open the file"),
			openAll: vscode.l10n.t("Open all changes in the editor"),
			commit: vscode.l10n.t("Commit"),
			mergeBack: vscode.l10n.t("Merge Back"),
			newFile: vscode.l10n.t("new"),
			hiddenLines: vscode.l10n.t("{0} more changed lines; open the file to see them"),
			noDiff: vscode.l10n.t("The file is too large to show its changes here."),
			working: vscode.l10n.t("The agent is working; Commit is available once it finishes."),
			oneFile: vscode.l10n.t("1 file"),
			files: vscode.l10n.t("{0} files"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'changes.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>Changes</title>
</head>
<body class="changes-panel">
	<header id="bar" class="changes-bar"></header>
	<main id="files" class="changes-files"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

/**
 * The file's text: the open document's, unsaved edits included, else what is
 * on disk. Read from disk rather than opened as a document, which would make
 * language servers start on every changed file.
 */
async function currentText(filePath: string): Promise<string | undefined> {
	const open = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && document.uri.fsPath === filePath);
	if (open) {
		return open.getText();
	}
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch {
		return undefined;
	}
}

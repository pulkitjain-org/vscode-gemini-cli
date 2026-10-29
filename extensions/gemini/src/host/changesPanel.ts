/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { reviewBase } from '../acp/agentChanges';
import { errorMessage } from '../acp/errors';
import { diffLines, hunkLines, splitLines } from '../acp/lineDiff';
import { ChangesSource } from './changesView';
import { configSection } from './configuration';
import { undoForeignMessage } from './reviewController';
import { createNonce, escapeAttribute } from './webviewHtml';
import { ChangedFileView, ChangesPanelStrings, ChangesPanelView, FromChangesPanel, ToChangesPanel } from './panelProtocol';
import { deleteFile, replaceFileText } from './workspaceFileSystem';
import type { MrPanel } from './mrPanel';
import type { FromChangesTeam } from './teamFlowProtocol';
import { showError } from './errorNotice';

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
	private readonly diffs = new Map<string, { readonly original: string; readonly agentText?: string; readonly current: string; readonly hunks: NonNullable<ChangedFileView['hunks']> }>();
	/** Files whose text must be read again for the next refresh; every file when the agent's changes or the source changed. */
	private stale: Set<string> | 'all' = 'all';
	/** The last view posted, to skip posting the same one again. */
	private lastView: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	/** The team tools' part: Open Merge Request, Run Checks and the agent's merge request; set by activate. */
	private mrPanel: MrPanel | undefined;
	/** Agents whose current turn opened the panel already: a turn opens it at most once. */
	private readonly openedThisTurn = new Set<string>();

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider(changesPanelId, this),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (this.source?.changes.file(e.document.uri.fsPath)) {
					// Only this document is read again; the others' diffs still hold.
					if (this.stale !== 'all') {
						this.stale.add(e.document.uri.fsPath);
					}
					this.schedule();
				}
			}),
		);
	}

	set team(panel: MrPanel | undefined) {
		this.mrPanel = panel;
		if (panel) {
			this.disposables.push(panel.onDidChange(() => this.schedule(0)));
		}
	}

	show(source: ChangesSource | undefined): void {
		this.sourceListener?.dispose();
		// The same agent comes back as a new source object on every tab switch; its diffs still hold.
		if (this.source?.agentId !== source?.agentId || this.source?.changes !== source?.changes) {
			this.diffs.clear();
		}
		this.source = source;
		this.stale = 'all';
		this.sourceListener = source?.changes.onDidChange(() => {
			this.openForChanges(source!);
			this.stale = 'all';
			this.schedule();
		});
		this.schedule(0);
	}

	/** Agent `agentId` started or ended a turn: its next turn may open the panel again. */
	turnChanged(agentId: string): void {
		this.openedThisTurn.delete(agentId);
	}

	/**
	 * Opens the panel, closed when a window opens, the first time a turn of
	 * the agent in front changes something: closed during a turn, it stays
	 * closed until the next turn changes something.
	 */
	private openForChanges(source: ChangesSource): void {
		if (source.busy() && !this.openedThisTurn.has(source.agentId) && !this.view?.visible) {
			this.openedThisTurn.add(source.agentId);
			// The workbench opens it without taking focus from the chat, and only in Agents mode.
			void vscode.commands.executeCommand('_gemini.showChanges').then(undefined, () => undefined);
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		view.webview.onDidReceiveMessage((message: FromChangesPanel) => this.onMessage(message).catch(err => void showError(errorMessage(err))));
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.lastView = undefined;
				this.stale = 'all';
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
		const stale = this.stale;
		this.stale = new Set();
		const panelView = await this.build(this.source, stale);
		const json = JSON.stringify(panelView);
		// Not when a later refresh started, the view closed meanwhile (it throws once disposed), or nothing changed.
		if (generation === this.generation && this.view === view && json !== this.lastView) {
			this.lastView = json;
			void view.webview.postMessage({ type: 'view', view: panelView } satisfies ToChangesPanel);
			view.badge = panelView.totals.files ? { value: panelView.totals.files, tooltip: vscode.l10n.t("{0} files changed", panelView.totals.files) } : undefined;
			view.description = this.source?.title;
		}
	}

	private async build(source: ChangesSource | undefined, stale: Set<string> | 'all'): Promise<ChangesPanelView> {
		if (!source) {
			return { totals: { files: 0, added: 0, removed: 0 }, files: [] };
		}
		const files = await Promise.all(source.changes.files.map(async (file, i): Promise<ChangedFileView> => {
			const dir = path.relative(source.folder, path.dirname(file.path));
			const base = { path: file.path, name: path.basename(file.path), dir: dir.startsWith('..') ? path.dirname(file.path) : dir, created: file.created, added: file.added, removed: file.removed };
			if (file.original === undefined || i >= maxDiffedFiles) {
				return base;
			}
			const cached = this.diffs.get(file.path);
			if (cached && stale !== 'all' && !stale.has(file.path) && cached.original === file.original && cached.agentText === file.agentText) {
				// Nothing of this file changed since its last diff: a keystroke elsewhere reads only its own document.
				return { ...base, hunks: cached.hunks };
			}
			const current = await currentText(file.path);
			if (current === undefined) {
				return base;
			}
			if (cached?.original === file.original && cached.agentText === file.agentText && cached.current === current) {
				return { ...base, hunks: cached.hunks };
			}
			// Against the original with others' later edits in it, as in the editor, so only the agent's changes show and the indexes match.
			const original = splitLines(reviewBase(file, current)?.base ?? file.original);
			const modified = splitLines(current);
			const hunks = diffLines(original, modified).map((hunk, index, all) => ({ index, ...hunkLines(original, modified, hunk, 1, undefined, all[index + 1]) }));
			this.diffs.set(file.path, { original: file.original, agentText: file.agentText, current, hunks });
			return { ...base, hunks };
		}));
		for (const filePath of this.diffs.keys()) {
			if (!source.changes.file(filePath)) {
				this.diffs.delete(filePath);
			}
		}
		const busy = source.busy();
		const team = this.mrPanel?.view(source);
		return {
			agent: { title: source.title, busy, ...(source.branch ? { branch: source.branch } : {}), ...(source.trying ? { trying: true } : {}), canCommit: !!source.commit && !busy && files.length > 0 },
			totals: source.changes.totals,
			files,
			...team ? { team } : {},
		};
	}

	private async onMessage(message: FromChangesPanel): Promise<void> {
		const source = this.source;
		switch (message.type) {
			case 'ready':
				this.lastView = undefined;
				this.stale = 'all';
				this.schedule(0);
				return;
			case 'team':
				return source && this.mrPanel?.act(source, message as FromChangesTeam);
		}
		const filePath = message.type === 'keep' || message.type === 'undo' || message.type === 'keepFile' || message.type === 'undoFile' || message.type === 'openFile' ? message.path : undefined;
		// Only files the agent changed.
		if (filePath !== undefined && !source?.changes.file(filePath)) {
			return;
		}
		switch (message.type) {
			case 'keep':
				await vscode.commands.executeCommand('gemini.review.keepChange', vscode.Uri.file(message.path).toString(), message.index, source?.agentId);
				return;
			case 'undo':
				await vscode.commands.executeCommand('gemini.review.undoChange', vscode.Uri.file(message.path).toString(), message.index, source?.agentId);
				return;
			case 'keepFile':
				await vscode.commands.executeCommand('gemini.review.keepFile', vscode.Uri.file(message.path).toString(), source?.agentId);
				return;
			case 'undoFile':
				await vscode.commands.executeCommand('gemini.review.undoFile', vscode.Uri.file(message.path).toString(), source?.agentId);
				return;
			case 'openFile':
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path), { viewColumn: await source?.editorColumn(), preview: true });
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
			case 'keepTried':
				return source?.keep?.();
			case 'takeBack':
				return source?.takeBack?.();
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
		const texts = await Promise.all(files.map(file => currentText(file.path)));
		const undo = vscode.l10n.t("Undo All");
		const created = files.filter(file => file.created).length;
		// Edits made after the agent's go too: say so, naming the files.
		const foreign = files.filter((file, i) => !file.created && reviewBase(file, texts[i] ?? '')?.foreign).map(file => path.basename(file.path));
		const detail = [
			created ? vscode.l10n.t("Files the agent created are deleted ({0}).", created) : undefined,
			foreign.length === 1 ? undoForeignMessage(foreign[0], source.title)
				: foreign.length ? vscode.l10n.t("{0} have edits that aren't from {1}. Undo All restores them as they were before {1}, losing those edits too.", foreign.join(', '), source.title) : undefined,
		].filter(Boolean).join('\n') || undefined;
		const message = files.length === 1
			? vscode.l10n.t("Undo {0}'s changes to {1}?", source.title, path.basename(files[0].path))
			: vscode.l10n.t("Undo {0}'s changes to {1} files?", source.title, files.length);
		if (await vscode.window.showWarningMessage(message, { modal: true, detail }, undo) !== undo) {
			return;
		}
		for (const file of files) {
			try {
				const next = file.created ? '' : file.original!;
				if (file.created) {
					await deleteFile(file.path);
				} else {
					await replaceFileText(file.path, next, true);
				}
				source.changes.keep(file.path, next, next);
			} catch (err) {
				void showError(vscode.l10n.t("Could not undo the changes to {0}: {1}", path.basename(file.path), errorMessage(err)));
			}
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const mergeCommits = vscode.workspace.getConfiguration(configSection).get<string>('agents.mergeBack') === 'commit';
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
			...mergeCommits ? {
				mergeBack: vscode.l10n.t("Merge Back"),
				mergeBackTip: vscode.l10n.t("Commit the agent's work on its branch and merge the branch into yours."),
			} : {
				mergeBack: vscode.l10n.t("Try in Workspace"),
				mergeBackTip: vscode.l10n.t("Copy the agent's changes into your workspace as unstaged files, so your local server and tests use them. They update each time the agent finishes a turn. Take Back removes them."),
			},
			keepChanges: vscode.l10n.t("Keep Changes"),
			keepChangesTip: vscode.l10n.t("Make these changes yours. Nothing is staged or committed; commit them when you're ready."),
			takeBack: vscode.l10n.t("Take Back"),
			takeBackTip: vscode.l10n.t("Remove the agent's changes from your workspace. Edits you made yourself stay."),
			newFile: vscode.l10n.t("new"),
			hiddenLines: vscode.l10n.t("{0} more changed lines; open the file to see them"),
			noDiff: vscode.l10n.t("The file is too large to show its changes here."),
			working: vscode.l10n.t("The agent is working; Commit is available once it finishes."),
			oneFile: vscode.l10n.t("1 file"),
			files: vscode.l10n.t("{0} files"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'changes.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const teamStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'teamFlow.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		const glassStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'glass.css'));
		// The themed tooltips' look.
		const menuStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'menu.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${menuStyle}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<link href="${teamStyle}" rel="stylesheet">
	<link href="${glassStyle}" rel="stylesheet">
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

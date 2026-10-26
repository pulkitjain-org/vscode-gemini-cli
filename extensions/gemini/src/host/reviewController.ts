/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, EditedFile, othersChanging, reviewBase, reviewOrder } from '../acp/agentChanges';
import { acceptHunk, diffLines, Hunk, revertHunk, splitLines } from '../acp/lineDiff';
import { errorMessage } from '../acp/errors';
import { recordPilot } from '../acp/pilotLog';
import { deleteFile, replaceFileText } from './workspaceFileSystem';

/** An agent whose changes can be reviewed in the editor. */
export interface ReviewSource {
	/** The agent's id, for agents; inline edits have none. */
	readonly id?: string;
	readonly title: string;
	readonly changes: AgentChanges;
	/** Whether undoing a change saves the file, as agents' edits are saved. Inline edits leave saving to the user. */
	readonly saves?: boolean;
}

/** A file an agent changed, with its changes against the text now. */
interface FileReview {
	readonly source: ReviewSource;
	readonly file: EditedFile & { readonly original: string };
	/** The original with edits made after the agent's: the hunks are against it, so they are only the agent's. */
	readonly base: string;
	/** The file has edits that aren't the agent's, which Undo All would lose too. */
	readonly foreign: boolean;
	readonly version: number;
	readonly hunks: readonly Hunk[];
}

/** How long after typing the changes are worked out again. */
const refreshDelayMs = 150;

/**
 * Review in the editor: an agent's changes show in the real file, each with
 * Keep and Undo above it, and a line at the top of the file to keep or undo
 * them all and step to the next file. Editor title buttons step through the
 * changes. Only files an agent changed are diffed, and only while visible.
 */
export class ReviewController implements vscode.CodeLensProvider, vscode.HoverProvider, vscode.Disposable {

	private readonly added = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	/** Where lines were removed: a rule above the line that follows them. */
	private readonly removedAbove = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderStyle: 'solid',
		borderWidth: '2px 0 0 0',
		borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	/** Lines removed at the end of the file: a rule below the last line. */
	private readonly removedBelow = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderStyle: 'solid',
		borderWidth: '0 0 2px 0',
		borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
	});

	private readonly reviews = new Map<string, FileReview>();
	private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active = false;
	private readonly extraSources: ReviewSource[] = [];

	constructor(private readonly sources: () => Iterable<ReviewSource>) {
		const selector: vscode.DocumentSelector = { scheme: 'file' };
		this.disposables.push(
			this.added,
			this.removedAbove,
			this.removedBelow,
			this.onDidChangeCodeLensesEmitter,
			vscode.languages.registerCodeLensProvider(selector, this),
			vscode.languages.registerHoverProvider(selector, this),
			vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
			vscode.workspace.onDidChangeTextDocument(e => this.reviews.has(e.document.uri.fsPath) && this.refreshSoon()),
			// The Changes panel names its agent (`sourceId`), as the file may have another agent's changes too.
			vscode.commands.registerCommand('gemini.review.keepChange', (uri: string, index: number, sourceId?: string) => this.keepChange(uri, index, sourceId)),
			vscode.commands.registerCommand('gemini.review.undoChange', (uri: string, index: number, sourceId?: string) => this.undoChange(uri, index, sourceId)),
			vscode.commands.registerCommand('gemini.review.keepFile', (uri?: unknown, sourceId?: string) => this.keepFile(fileOf(uri), sourceId)),
			vscode.commands.registerCommand('gemini.review.undoFile', (uri?: unknown, sourceId?: string) => this.undoFile(fileOf(uri), sourceId)),
			vscode.commands.registerCommand('gemini.review.nextChange', () => this.step(1)),
			vscode.commands.registerCommand('gemini.review.previousChange', () => this.step(-1)),
			vscode.commands.registerCommand('gemini.review.nextFile', (uri?: unknown) => this.nextFile(fileOf(uri))),
		);
		this.refresh();
	}

	/** Reviews `source`'s changes too, such as inline edits, until disposed. */
	addSource(source: ReviewSource): vscode.Disposable {
		this.extraSources.push(source);
		const listener = source.changes.onDidChange(() => this.refreshSoon());
		return new vscode.Disposable(() => {
			listener.dispose();
			this.extraSources.splice(this.extraSources.indexOf(source), 1);
			this.refresh();
		});
	}

	/**
	 * The other sources with changes still to review in `filePath`, besides
	 * agent `agentId`'s: for warning on an agent's edit card that another live
	 * agent in the same folder is changing the file too.
	 */
	othersChanging(filePath: string, agentId: string): readonly ReviewSource[] {
		const sources = [...this.sources()];
		const self = sources.find(source => source.id === agentId);
		return self ? othersChanging(filePath, sources, self.changes).filter(source => source.id !== undefined) : [];
	}

	/** Works out the changes again, for example after an agent edited or the user kept some. */
	refresh(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.reviews.clear();
		for (const editor of vscode.window.visibleTextEditors) {
			const review = this.review(editor.document);
			if (review) {
				this.reviews.set(editor.document.uri.fsPath, review);
			}
		}
		for (const editor of vscode.window.visibleTextEditors) {
			this.decorate(editor);
		}
		this.onDidChangeCodeLensesEmitter.fire();
		this.updateContext();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const review = this.current(document);
		if (!review) {
			return [];
		}
		const uri = document.uri.toString();
		const top = new vscode.Range(0, 0, 0, 0);
		const files = review.source.changes.files.filter(f => f.original !== undefined);
		const lenses = [
			new vscode.CodeLens(top, {
				title: review.hunks.length === 1 ? vscode.l10n.t("$(sparkle) 1 change by Gemini") : vscode.l10n.t("$(sparkle) {0} changes by Gemini", review.hunks.length),
				command: 'gemini.review.nextChange',
				tooltip: vscode.l10n.t("From {0}. Click to go to the next change.", review.source.title),
			}),
			new vscode.CodeLens(top, { title: vscode.l10n.t("$(check-all) Keep All"), command: 'gemini.review.keepFile', arguments: [uri] }),
			new vscode.CodeLens(top, { title: vscode.l10n.t("$(discard) Undo All"), command: 'gemini.review.undoFile', arguments: [uri] }),
		];
		if (files.length > 1) {
			const index = files.findIndex(f => f.path === review.file.path);
			lenses.push(new vscode.CodeLens(top, {
				title: vscode.l10n.t("Next File ({0} of {1}) $(arrow-right)", index + 1, files.length),
				command: 'gemini.review.nextFile',
				arguments: [uri],
			}));
		}
		review.hunks.forEach((hunk, index) => {
			const range = new vscode.Range(lensLine(document, hunk), 0, lensLine(document, hunk), 0);
			lenses.push(
				new vscode.CodeLens(range, { title: vscode.l10n.t("$(check) Keep"), command: 'gemini.review.keepChange', arguments: [uri, index] }),
				new vscode.CodeLens(range, { title: vscode.l10n.t("$(discard) Undo"), command: 'gemini.review.undoChange', arguments: [uri, index] }),
			);
		});
		return lenses;
	}

	/** Shows the lines a change removed. */
	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const review = this.current(document);
		const hunk = review?.hunks.find(h => h.originalEnd > h.originalStart && position.line >= Math.min(h.modifiedStart, document.lineCount - 1) && position.line <= Math.max(h.modifiedStart, h.modifiedEnd - 1));
		if (!review || !hunk) {
			return undefined;
		}
		const removed = splitLines(review.base).slice(hunk.originalStart, hunk.originalEnd).join('\n');
		const markdown = new vscode.MarkdownString(vscode.l10n.t("**Removed by {0}**", review.source.title));
		markdown.appendCodeblock(removed.length > 20_000 ? `${removed.slice(0, 20_000)}\n…` : removed, document.languageId);
		return new vscode.Hover(markdown);
	}

	dispose(): void {
		clearTimeout(this.timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Refreshes once a burst of edits (typing, or an agent's tool calls) has settled. */
	refreshSoon(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.refresh(), refreshDelayMs);
	}

	/**
	 * The file's changes, if an agent changed it and its original text is
	 * known. When several agents changed it, the one whose text it has (else
	 * the latest) is reviewed first, or `sourceId` when given.
	 */
	private review(document: vscode.TextDocument, sourceId?: string): FileReview | undefined {
		if (document.uri.scheme !== 'file') {
			return undefined;
		}
		const text = document.getText();
		const candidates = [...this.extraSources, ...this.sources()].flatMap(source => {
			const file = source.changes.file(document.uri.fsPath);
			return file?.original !== undefined && (sourceId === undefined || source.id === sourceId) ? [{ source, file: { ...file, original: file.original } }] : [];
		});
		const lines = splitLines(text);
		for (const candidate of reviewOrder(candidates, text)) {
			const base = reviewBase(candidate.file, text);
			const hunks = base ? diffLines(splitLines(base.base), lines) : [];
			if (base && hunks.length) {
				return { ...candidate, base: base.base, foreign: base.foreign, version: document.version, hunks };
			}
		}
		return undefined;
	}

	/** The review for `document` as it is now; of `sourceId`'s changes, when given. */
	private current(document: vscode.TextDocument, sourceId?: string): FileReview | undefined {
		if (sourceId !== undefined) {
			const review = this.reviews.get(document.uri.fsPath);
			return review?.source.id === sourceId && review.version === document.version ? review : this.review(document, sourceId);
		}
		const review = this.reviews.get(document.uri.fsPath);
		if (review && review.version === document.version) {
			return review;
		}
		const fresh = this.review(document);
		if (fresh) {
			this.reviews.set(document.uri.fsPath, fresh);
		} else {
			this.reviews.delete(document.uri.fsPath);
		}
		return fresh;
	}

	private decorate(editor: vscode.TextEditor): void {
		const review = this.reviews.get(editor.document.uri.fsPath);
		const added: vscode.Range[] = [];
		const above: vscode.Range[] = [];
		const below: vscode.Range[] = [];
		const lastLine = editor.document.lineCount - 1;
		for (const hunk of review?.hunks ?? []) {
			if (hunk.modifiedEnd > hunk.modifiedStart) {
				added.push(new vscode.Range(hunk.modifiedStart, 0, Math.min(hunk.modifiedEnd - 1, lastLine), 0));
			} else if (hunk.modifiedStart <= lastLine) {
				above.push(new vscode.Range(hunk.modifiedStart, 0, hunk.modifiedStart, 0));
			} else {
				below.push(new vscode.Range(lastLine, 0, lastLine, 0));
			}
		}
		editor.setDecorations(this.added, added);
		editor.setDecorations(this.removedAbove, above);
		editor.setDecorations(this.removedBelow, below);
	}

	private updateContext(): void {
		const document = vscode.window.activeTextEditor?.document;
		const active = !!document && !!this.reviews.get(document.uri.fsPath)?.hunks.length;
		if (active !== this.active) {
			this.active = active;
			void vscode.commands.executeCommand('setContext', 'gemini.review.active', active);
		}
	}

	private async documentFor(uri: string | undefined): Promise<vscode.TextDocument | undefined> {
		const target = uri ? vscode.Uri.parse(uri) : vscode.window.activeTextEditor?.document.uri;
		return target?.scheme === 'file' ? vscode.workspace.openTextDocument(target) : undefined;
	}

	private async keepChange(uri: string, index: number, sourceId?: string): Promise<void> {
		const document = await this.documentFor(uri);
		const review = document && this.current(document, sourceId);
		const hunk = review?.hunks[index];
		if (!document || !review || !hunk) {
			return;
		}
		const text = document.getText();
		const original = acceptHunk(splitLines(review.base), splitLines(text), hunk).join('\n');
		review.source.changes.keep(review.file.path, original, text);
	}

	private async undoChange(uri: string, index: number, sourceId?: string): Promise<void> {
		const document = await this.documentFor(uri);
		const review = document && this.current(document, sourceId);
		const hunk = review?.hunks[index];
		if (!document || !review || !hunk) {
			return;
		}
		if (review.file.created && review.hunks.length === 1 && !review.foreign) {
			return this.undoFile(document.uri.toString(), sourceId);
		}
		recordPilot({ kind: 'undo', scope: 'change' });
		const reverted = revertHunk(splitLines(review.base), splitLines(document.getText()), hunk).join('\n');
		// The edits that aren't the agent's stay, in the file and in its new baseline.
		await this.write(review, reverted, review.base);
	}

	private async keepFile(uri: string | undefined, sourceId?: string): Promise<void> {
		const document = await this.documentFor(uri);
		const review = document && this.current(document, sourceId);
		if (document && review) {
			const text = document.getText();
			review.source.changes.keep(review.file.path, text, text);
		}
	}

	private async undoFile(uri: string | undefined, sourceId?: string): Promise<void> {
		const document = await this.documentFor(uri);
		const review = document && this.current(document, sourceId);
		if (!document || !review) {
			return;
		}
		const name = path.basename(review.file.path);
		if (review.file.created) {
			const remove = vscode.l10n.t("Delete File");
			const choice = await vscode.window.showWarningMessage(vscode.l10n.t("{0} was created by {1}. Delete it?", name, review.source.title), { modal: true }, remove);
			if (choice !== remove) {
				return;
			}
		} else if (review.foreign) {
			const undo = vscode.l10n.t("Undo All");
			if (await vscode.window.showWarningMessage(undoForeignMessage(name, review.source.title), { modal: true }, undo) !== undo) {
				return;
			}
		}
		recordPilot({ kind: 'undo', scope: 'file' });
		const next = review.file.created ? undefined : review.file.original;
		await this.write(review, next, next ?? '');
	}

	/** Writes `next` (or deletes the file), then makes `base` the agent's change list's baseline for the file. */
	private async write(review: FileReview, next: string | undefined, base: string): Promise<void> {
		try {
			if (next === undefined) {
				await deleteFile(review.file.path);
			} else {
				await replaceFileText(review.file.path, next, review.source.saves !== false);
			}
			review.source.changes.keep(review.file.path, base, next ?? '');
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not undo the change: {0}", errorMessage(err)));
		}
	}

	/** Moves the cursor to the next or previous change, going on to the agent's next file at either end. */
	private async step(direction: 1 | -1): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const review = editor && this.current(editor.document);
		if (!editor || !review) {
			return;
		}
		const line = editor.selection.active.line;
		const starts = review.hunks.map(h => lensLine(editor.document, h));
		const target = direction === 1 ? starts.find(s => s > line) : [...starts].reverse().find(s => s < line);
		if (target !== undefined) {
			reveal(editor, target);
			return;
		}
		await this.nextFile(editor.document.uri.toString(), direction);
	}

	/** Opens the next file the same agent changed, at its first (or, going back, last) change. */
	private async nextFile(uri: string | undefined, direction: 1 | -1 = 1): Promise<void> {
		const document = await this.documentFor(uri);
		const review = document && this.current(document);
		if (!document || !review) {
			return;
		}
		const files = review.source.changes.files.filter(f => f.original !== undefined);
		const index = files.findIndex(f => f.path === review.file.path);
		const next = files[(index + direction + files.length) % files.length];
		if (!next || next.path === review.file.path) {
			const editor = vscode.window.activeTextEditor;
			if (editor?.document === document) {
				reveal(editor, lensLine(document, direction === 1 ? review.hunks[0] : review.hunks[review.hunks.length - 1]));
			}
			return;
		}
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(next.path), { preview: true });
		const nextReview = this.current(editor.document);
		if (nextReview) {
			reveal(editor, lensLine(editor.document, direction === 1 ? nextReview.hunks[0] : nextReview.hunks[nextReview.hunks.length - 1]));
		}
	}
}

/** The line a change's Keep and Undo sit above: its first line, or the line after removed ones. */
function lensLine(document: vscode.TextDocument, hunk: Hunk): number {
	return Math.min(hunk.modifiedStart, document.lineCount - 1);
}

function reveal(editor: vscode.TextEditor, line: number): void {
	const position = new vscode.Position(line, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Undo All's question when the file has edits that aren't from `source`. */
export function undoForeignMessage(file: string, source: string): string {
	return vscode.l10n.t("{0} has edits that aren't from {1}. Undo All restores the file as it was before {1}, losing them too.", file, source);
}

/** A command's URI argument: a string from a code lens, or a Uri from an editor title button. */
function fileOf(uri: unknown): string | undefined {
	return typeof uri === 'string' ? uri : uri instanceof vscode.Uri ? uri.toString() : undefined;
}

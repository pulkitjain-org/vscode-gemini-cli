/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Marked lines in the editor (DEBUG_MODE.md, Marked lines): inserted through
// a WorkspaceEdit and saved, as the agent's own writes are, so the editor's
// undo and the disk agree; removed the same way only when the region is
// still what was inserted (regions.ts), and otherwise only after the user
// says Remove Anyway. Each region gets a tint and a CodeLens, and each
// debugger point a faded note of whose it is and how often it was hit.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { findRegion, recordRegion, type RegionRecord, regionDiff, removeRegion } from '../../acp/debug/regions';
import { refusesInstrumentation } from '../../acp/debug/templates';

/** What the editor shows for one Debug mode. */
export interface EditorSource {
	readonly agent: string;
	readonly nonce: string;
	readonly regions: readonly RegionRecord[];
	/** Hits and hypothesis by point id. */
	describe(point: string): { readonly hypothesis: string; readonly hits: number } | undefined;
	/** The debugger points, by absolute file and one-based line. */
	readonly debuggerPoints: readonly { readonly id: string; readonly file: string; readonly line: number }[];
}

export type InsertResult = { readonly ok: true; readonly record: RegionRecord } | { readonly ok: false; readonly error: string };

export type RemoveOutcome = { readonly state: 'same' | 'missing' | 'removed' } | { readonly state: 'changed'; readonly diff: string };

const refreshDelayMs = 1000;

export class DebugEditor implements vscode.Disposable {

	private readonly regionTint = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('gemini.debugRegion'),
		borderWidth: '0 0 0 2px',
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor('editorInfo.foreground'),
	});
	private readonly pointNote = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' },
	});
	private readonly lensesChanged = new vscode.EventEmitter<void>();
	private lenses: vscode.Disposable | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly sources: () => readonly EditorSource[], private readonly labels: { lens(point: string, hypothesis: string, hits: number): string; remove: string; note(point: string, hypothesis: string, hits: number): string }) {
		this.disposables.push(
			this.regionTint,
			this.pointNote,
			this.lensesChanged,
			vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
		);
	}

	/**
	 * Inserts `lines(indent)` before `line` (one-based) of `file`, with the
	 * line's own indentation, and saves. A file with unsaved changes, one that
	 * is generated or minified, and a blank line are refused.
	 */
	async insert(file: string, line: number, nonce: string, point: string, lines: (indent: string) => readonly string[]): Promise<InsertResult> {
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		} catch {
			return { ok: false, error: `${path.basename(file)} could not be opened.` };
		}
		if (document.isDirty) {
			return { ok: false, error: `${path.basename(file)} has unsaved changes, so Debug mode does not edit it under the user's hands: choose another point, or use a logpoint.` };
		}
		const refused = refusesInstrumentation(file, document.getText(new vscode.Range(0, 0, Math.min(document.lineCount, 40), 0)));
		if (refused) {
			return { ok: false, error: `No marked line here: ${refused}. Debugger points are still allowed.` };
		}
		if (line < 1 || line > document.lineCount) {
			return { ok: false, error: `${path.basename(file)} has ${document.lineCount} lines.` };
		}
		const target = document.lineAt(line - 1);
		if (target.isEmptyOrWhitespace) {
			return { ok: false, error: `Line ${line} of ${path.basename(file)} has no code: choose a line with a statement.` };
		}
		const indent = /^\s*/.exec(target.text)?.[0] ?? '';
		const region = lines(indent);
		const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(line - 1, 0), region.map(text => `${text}${eol}`).join(''));
		if (!await vscode.workspace.applyEdit(edit)) {
			return { ok: false, error: `The edit to ${path.basename(file)} did not apply.` };
		}
		await document.save();
		this.changed();
		return { ok: true, record: recordRegion(file, nonce, point, region, line) };
	}

	/**
	 * Removes the region when its text, apart from whitespace, is what was
	 * inserted, or always with `force`; a changed one is left with its diff.
	 */
	async remove(record: RegionRecord, force = false): Promise<RemoveOutcome> {
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(vscode.Uri.file(record.file));
		} catch {
			return { state: 'missing' };
		}
		const text = document.getText();
		const result = removeRegion(text, record, force);
		if (result.state === 'missing') {
			return { state: 'missing' };
		}
		if (result.content === undefined) {
			return { state: 'changed', diff: regionDiff(record, result.current ?? '') };
		}
		const found = findRegion(text, record.nonce, record.point);
		if (!found) {
			return { state: 'missing' };
		}
		const wasDirty = document.isDirty;
		const end = found.end + 1 < document.lineCount ? new vscode.Position(found.end + 1, 0) : document.lineAt(found.end).range.end;
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(new vscode.Position(found.start, 0), end));
		if (!await vscode.workspace.applyEdit(edit)) {
			return { state: 'changed', diff: regionDiff(record, found.text) };
		}
		// A file the user had unsaved changes in keeps them unsaved: saving would write theirs too.
		if (!wasDirty) {
			await document.save();
		}
		this.changed();
		return { state: result.state === 'same' ? 'same' : 'removed' };
	}

	/** Opens the file at the region, or at `line`. */
	async reveal(file: string, line: number): Promise<void> {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		const position = new vscode.Position(Math.max(0, line - 1), 0);
		await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
	}

	/** Draws the tints and notes again, at most once a second. */
	refresh(): void {
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			this.draw();
		}, refreshDelayMs);
	}

	/** Something changed now: draw at once. */
	changed(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.draw();
	}

	private draw(): void {
		const sources = this.sources();
		const anyRegion = sources.some(source => source.regions.length);
		if (anyRegion && !this.lenses) {
			this.lenses = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
				onDidChangeCodeLenses: this.lensesChanged.event,
				provideCodeLenses: document => this.lensesFor(document),
			});
		} else if (!anyRegion && this.lenses) {
			this.lenses.dispose();
			this.lenses = undefined;
		}
		this.lensesChanged.fire();
		for (const editor of vscode.window.visibleTextEditors) {
			const file = editor.document.uri.fsPath;
			const tints: vscode.Range[] = [];
			const notes: vscode.DecorationOptions[] = [];
			const text = sources.some(source => source.regions.some(region => region.file === file)) ? editor.document.getText() : '';
			for (const source of sources) {
				for (const region of source.regions.filter(r => r.file === file)) {
					const found = findRegion(text, region.nonce, region.point);
					if (found) {
						tints.push(new vscode.Range(found.start, 0, found.end, 0));
					}
				}
				for (const point of source.debuggerPoints.filter(p => p.file === file && p.line <= editor.document.lineCount)) {
					const about = source.describe(point.id);
					const line = editor.document.lineAt(point.line - 1);
					notes.push({ range: new vscode.Range(line.range.end, line.range.end), renderOptions: { after: { contentText: this.labels.note(point.id, about?.hypothesis ?? '', about?.hits ?? 0) } } });
				}
			}
			editor.setDecorations(this.regionTint, tints);
			editor.setDecorations(this.pointNote, notes);
		}
	}

	private lensesFor(document: vscode.TextDocument): vscode.CodeLens[] {
		const file = document.uri.fsPath;
		const lenses: vscode.CodeLens[] = [];
		let text: string | undefined;
		for (const source of this.sources()) {
			for (const region of source.regions.filter(r => r.file === file)) {
				text ??= document.getText();
				const found = findRegion(text, region.nonce, region.point);
				if (!found) {
					continue;
				}
				const about = source.describe(region.point);
				const range = new vscode.Range(found.start, 0, found.start, 0);
				lenses.push(
					new vscode.CodeLens(range, { title: this.labels.lens(region.point, about?.hypothesis ?? '', about?.hits ?? 0), command: 'gemini.debug.showEvidence', arguments: [source.agent, `${region.point}`] }),
					new vscode.CodeLens(range, { title: this.labels.remove, command: 'gemini.debug.action', arguments: [source.agent, 'removePoint', region.point] }),
				);
			}
		}
		return lenses;
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.lenses?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

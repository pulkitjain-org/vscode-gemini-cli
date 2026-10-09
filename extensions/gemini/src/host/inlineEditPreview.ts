/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Inline edit's rewrite as it arrives: its whole lines go into the file just
// above the lines being rewritten, marked as added, with those lines marked
// as removed, so the edit shows in place within a second instead of after
// the whole answer. Once the answer is in (or fails), the lines go again and
// the caller applies the clean rewrite. Every edit, the final one included,
// is one undo step. If anything else changes the file meanwhile, the preview
// stops and leaves the file to the user.

import * as vscode from 'vscode';

const added = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
});

const removed = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
	opacity: '0.6',
});

export class InlineEditPreview {

	/** The text shown above the original lines; whole lines, each ending with a newline. */
	private shown = '';
	/** The text to show next, once the edit before it is done. */
	private wanted = '';
	private running: Promise<void> | undefined;
	/** The document's version after this preview's last edit. */
	private version: number;
	private started = false;
	private finished = false;
	/** Something else changed the file, so the preview no longer knows where its lines are. */
	disturbed = false;

	/** Previews a rewrite of `lineCount` lines from line `start` in `editor`. */
	constructor(private readonly editor: vscode.TextEditor, private readonly start: number, private readonly lineCount: number) {
		this.version = editor.document.version;
	}

	/** Shows `lines` (whole lines, each ending with a newline) as the rewrite so far. */
	show(lines: string): void {
		if (this.finished || lines === this.wanted) {
			return;
		}
		this.wanted = lines;
		this.running ??= this.update();
	}

	/** Takes the preview's lines out again; resolves with whether the file is as it was before. */
	async finish(): Promise<boolean> {
		this.finished = true;
		this.wanted = '';
		await (this.running ??= this.update());
		this.editor.setDecorations(added, []);
		this.editor.setDecorations(removed, []);
		if (this.disturbed && this.shown) {
			// Edited elsewhere: the preview's lines still go if they are where they were.
			const range = new vscode.Range(this.start, 0, this.start + count(this.shown), 0);
			if (!this.editor.document.isClosed && this.editor.document.getText(range) === this.shown) {
				await this.editor.edit(edit => edit.delete(range), { undoStopBefore: false, undoStopAfter: true });
			}
		}
		return !this.disturbed;
	}

	/** Whether the preview made an edit, so the caller's edit continues its undo step. */
	get edited(): boolean {
		return this.started;
	}

	private async update(): Promise<void> {
		try {
			while (this.wanted !== this.shown && !this.disturbed) {
				const next = this.wanted;
				const document = this.editor.document;
				if (document.version !== this.version || document.isClosed) {
					this.disturbed = true;
					break;
				}
				const lines = count(this.shown);
				const ok = await this.editor.edit(edit => edit.replace(new vscode.Range(this.start, 0, this.start + lines, 0), next),
					{ undoStopBefore: !this.started, undoStopAfter: false });
				if (!ok) {
					this.disturbed = true;
					break;
				}
				this.started = true;
				this.shown = next;
				this.version = document.version;
				this.decorate();
			}
		} finally {
			this.running = undefined;
		}
	}

	private decorate(): void {
		const lines = count(this.shown);
		this.editor.setDecorations(added, lines ? [new vscode.Range(this.start, 0, this.start + lines - 1, 0)] : []);
		this.editor.setDecorations(removed, lines && this.lineCount ? [new vscode.Range(this.start + lines, 0, this.start + lines + this.lineCount - 1, 0)] : []);
		if (lines) {
			this.editor.revealRange(new vscode.Range(this.start + lines - 1, 0, this.start + lines - 1, 0), vscode.TextEditorRevealType.Default);
		}
	}
}

function count(lines: string): number {
	return lines.split('\n').length - 1;
}

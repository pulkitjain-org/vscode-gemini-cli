/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The files one agent changed, from the diffs its completed tool calls report.
// Each file keeps the text from before the agent's first edit, so a diff
// against the file on disk shows everything the agent did to it; the line
// counts follow the agent's latest edit.

import * as path from 'node:path';
import { countChangedLines } from './chatTranscript';
import { Emitter } from './events';

export interface EditedFile {
	readonly path: string;
	/** The file did not exist before the agent's first edit. */
	readonly created: boolean;
	/** The text before the agent's first edit; unset when it was too large to keep. */
	readonly original?: string;
	readonly added: number;
	readonly removed: number;
}

export interface ChangeTotals {
	readonly files: number;
	readonly added: number;
	readonly removed: number;
}

/** What a completed tool call reports for one file, as in ACP's `diff` content. */
export interface CompletedEdit {
	readonly path: string;
	readonly oldText?: string | null;
	readonly newText: string;
}

/** Line counts such as "+12 -3" (with a minus sign), as in Source Control. */
export function formatCounts(counts: { readonly added: number; readonly removed: number }): string {
	return `+${counts.added} \u2212${counts.removed}`;
}

/** Originals larger than this are not kept; the file still counts, but its diff cannot be shown. */
const maxOriginalLength = 1_000_000;

export class AgentChanges {

	private readonly onDidChangeEmitter = new Emitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly byPath = new Map<string, EditedFile>();

	constructor(private readonly cwd: string) { }

	/** The changed files, by path. */
	get files(): readonly EditedFile[] {
		return [...this.byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
	}

	get totals(): ChangeTotals {
		let added = 0;
		let removed = 0;
		for (const file of this.byPath.values()) {
			added += file.added;
			removed += file.removed;
		}
		return { files: this.byPath.size, added, removed };
	}

	file(filePath: string): EditedFile | undefined {
		return this.byPath.get(filePath);
	}

	/** Adds a completed tool call's edits. */
	record(edits: readonly CompletedEdit[]): void {
		if (!edits.length) {
			return;
		}
		for (const edit of edits) {
			const filePath = path.resolve(this.cwd, edit.path);
			const first = this.byPath.get(filePath);
			const created = first ? first.created : !edit.oldText;
			const original = first ? first.original : edit.oldText ?? '';
			const { added, removed } = original === undefined
				? countChangedLines(edit.oldText ?? '', edit.newText)
				: countChangedLines(original, edit.newText);
			if (created ? first && !edit.newText : original === edit.newText) {
				// Made and then deleted, or changed back: nothing changed.
				this.byPath.delete(filePath);
				continue;
			}
			this.byPath.set(filePath, {
				path: filePath,
				created,
				...(original !== undefined && original.length <= maxOriginalLength ? { original } : {}),
				added,
				removed,
			});
		}
		this.onDidChangeEmitter.fire();
	}

	/**
	 * The user kept some of the agent's changes to a file: `original` is the
	 * new baseline and `current` the file now. Forgets the file once nothing
	 * differs.
	 */
	keep(filePath: string, original: string, current: string): void {
		const file = this.byPath.get(filePath);
		if (!file) {
			return;
		}
		if (original === current) {
			this.byPath.delete(filePath);
		} else {
			this.byPath.set(filePath, { path: filePath, created: file.created && !original, original, ...countChangedLines(original, current) });
		}
		this.onDidChangeEmitter.fire();
	}

	/** Shows changes saved in an earlier window, unless edits were recorded since. */
	restore(files: readonly EditedFile[]): void {
		if (this.byPath.size) {
			return;
		}
		for (const file of files.filter(isEditedFile)) {
			this.byPath.set(file.path, file);
		}
		if (this.byPath.size) {
			this.onDidChangeEmitter.fire();
		}
	}

	/** Forgets every change, for example after the user committed or reverted them. */
	clear(): void {
		if (this.byPath.size) {
			this.byPath.clear();
			this.onDidChangeEmitter.fire();
		}
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}

function isEditedFile(value: unknown): value is EditedFile {
	const f = value as EditedFile;
	return typeof f?.path === 'string' && path.isAbsolute(f.path) && typeof f.created === 'boolean'
		&& typeof f.added === 'number' && typeof f.removed === 'number'
		&& (f.original === undefined || typeof f.original === 'string');
}

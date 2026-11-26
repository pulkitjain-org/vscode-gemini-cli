/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The files one agent changed, from the diffs its completed tool calls report.
// Each file keeps the text from before the agent's first edit, so a diff
// against the file on disk shows everything the agent did to it; the line
// counts follow the agent's latest edit. What the agent last wrote is kept
// too, so edits made after it (by the user, or another agent) are not shown
// as the agent's. Files in the CLI's own folder (`~/.gemini/tmp`: Plan mode's
// plans, its task tracker) are the CLI's notes, not changes to the work, so
// they are left out: a thread that only planned has nothing to try or review.

import * as path from 'node:path';
import { countChangedLines } from './chatTranscript';
import { Emitter } from './events';
import { rebaseOriginal } from './lineDiff';

export interface EditedFile {
	readonly path: string;
	/** The file did not exist before the agent's first edit. */
	readonly created: boolean;
	/** The text before the agent's first edit; unset when it was too large to keep. */
	readonly original?: string;
	readonly added: number;
	readonly removed: number;
	/** What the agent last wrote to the file; unset when too large to keep, or saved by an older version. */
	readonly agentText?: string;
	/** When the agent last edited the file, in ms since the epoch. */
	readonly editedAt?: number;
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
/** All of one agent's kept texts (originals and what it last wrote) stay under this; past it the largest files lose their texts, and keep their counts. */
const maxTotalTextLength = 8_000_000;

export class AgentChanges {

	private readonly onDidChangeEmitter = new Emitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly byPath = new Map<string, EditedFile>();

	constructor(
		private readonly cwd: string,
		/** The CLI's own folder, whose files never count as changes. */
		private readonly cliFolder?: string,
	) { }

	/** The folder the agent works in; relative paths in edits are against it. */
	get folder(): string {
		return this.cwd;
	}

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
		const editedAt = Date.now();
		for (const edit of edits) {
			const filePath = path.resolve(this.cwd, edit.path);
			if (this.isCliFile(filePath)) {
				continue;
			}
			const first = this.byPath.get(filePath);
			const created = first ? first.created : !edit.oldText;
			let original = first ? first.original : edit.oldText ?? '';
			if (original !== undefined && first?.agentText !== undefined && typeof edit.oldText === 'string' && edit.oldText !== first.agentText) {
				// The file changed since the agent last wrote it: those edits are not the agent's.
				original = rebaseOriginal(original, first.agentText, edit.oldText).base;
			}
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
				...(edit.newText.length <= maxOriginalLength ? { agentText: edit.newText } : {}),
				editedAt,
			});
		}
		this.trimTexts();
		this.onDidChangeEmitter.fire();
	}

	/** Keeps the texts of all files together under `maxTotalTextLength`: the largest lose theirs first, and stay counted. */
	private trimTexts(): void {
		let total = 0;
		for (const file of this.byPath.values()) {
			total += (file.original?.length ?? 0) + (file.agentText?.length ?? 0);
		}
		if (total <= maxTotalTextLength) {
			return;
		}
		const largestFirst = [...this.byPath.values()].filter(file => file.original !== undefined || file.agentText !== undefined)
			.sort((a, b) => ((b.original?.length ?? 0) + (b.agentText?.length ?? 0)) - ((a.original?.length ?? 0) + (a.agentText?.length ?? 0)));
		for (const file of largestFirst) {
			if (total <= maxTotalTextLength) {
				break;
			}
			total -= (file.original?.length ?? 0) + (file.agentText?.length ?? 0);
			const { original: _original, agentText: _agentText, ...counted } = file;
			this.byPath.set(file.path, counted);
		}
	}

	/**
	 * The user kept some of the agent's changes to a file, or undid some:
	 * `original` is the new baseline and `current` the file now, which is
	 * what is left of the agent's changes. Forgets the file once nothing
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
			this.byPath.set(filePath, {
				path: filePath,
				created: file.created && !original,
				original,
				...countChangedLines(original, current),
				...(current.length <= maxOriginalLength ? { agentText: current } : {}),
				...(file.editedAt !== undefined ? { editedAt: file.editedAt } : {}),
			});
		}
		this.onDidChangeEmitter.fire();
	}

	/** Forgets `filePaths`, such as files whose changes were committed. */
	settle(filePaths: Iterable<string>): void {
		let changed = false;
		for (const filePath of filePaths) {
			changed = this.byPath.delete(filePath) || changed;
		}
		if (changed) {
			this.onDidChangeEmitter.fire();
		}
	}

	/** Shows changes saved in an earlier window, unless edits were recorded since. */
	restore(files: readonly EditedFile[]): void {
		if (this.byPath.size) {
			return;
		}
		for (const file of files.filter(isEditedFile)) {
			if (!this.isCliFile(file.path)) {
				this.byPath.set(file.path, file);
			}
		}
		this.trimTexts();
		// Also when everything saved was the CLI's, so the totals saved with the agent go too.
		if (files.length) {
			this.onDidChangeEmitter.fire();
		}
	}

	/** Forgets every change, or every one inside `folder`, for example after the user committed or reverted them. */
	clear(folder?: string): void {
		const before = this.byPath.size;
		if (folder === undefined) {
			this.byPath.clear();
		} else {
			for (const file of [...this.byPath.keys()]) {
				if (file === folder || file.startsWith(folder + path.sep)) {
					this.byPath.delete(file);
				}
			}
		}
		if (this.byPath.size !== before) {
			this.onDidChangeEmitter.fire();
		}
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	private isCliFile(filePath: string): boolean {
		return !!this.cliFolder && filePath.startsWith(this.cliFolder + path.sep);
	}
}

function isEditedFile(value: unknown): value is EditedFile {
	const f = value as EditedFile;
	return typeof f?.path === 'string' && path.isAbsolute(f.path) && typeof f.created === 'boolean'
		&& typeof f.added === 'number' && typeof f.removed === 'number'
		&& (f.original === undefined || typeof f.original === 'string')
		&& (f.agentText === undefined || typeof f.agentText === 'string')
		&& (f.editedAt === undefined || typeof f.editedAt === 'number');
}

/**
 * The text to diff the file against so that only the agent's changes show,
 * and whether the file has edits made after the agent's (`foreign`); undefined
 * when the original text was not kept.
 */
export function reviewBase(file: EditedFile, current: string): { readonly base: string; readonly foreign: boolean } | undefined {
	if (file.original === undefined) {
		return undefined;
	}
	return file.agentText === undefined ? { base: file.original, foreign: false } : rebaseOriginal(file.original, file.agentText, current);
}

/**
 * The agents that changed one file, in the order their changes are reviewed:
 * first the one whose text the file has now, then the latest to edit it. The
 * others' changes wait until those are kept or undone.
 */
export function reviewOrder<T extends { readonly file: EditedFile }>(candidates: readonly T[], current: string): T[] {
	const rank = (c: T) => c.file.agentText === current ? Number.MAX_SAFE_INTEGER : c.file.editedAt ?? 0;
	return [...candidates].sort((a, b) => rank(b) - rank(a));
}

/** The sources other than `self` with changes still to review in `filePath`, such as another agent working in the same folder. */
export function othersChanging<T extends { readonly changes: AgentChanges }>(filePath: string, sources: Iterable<T>, self: AgentChanges): T[] {
	return [...sources].filter(source => source.changes !== self && !!source.changes.file(filePath));
}

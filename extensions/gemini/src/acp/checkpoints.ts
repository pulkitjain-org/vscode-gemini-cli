/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checkpoints: for each of a chat's turns, the text every file had before
// the agent first edited it in that turn, so the turn can be undone, or the
// chat rewound to before it. Capped in turns and size; an agent's are saved
// with it (`toStored`, `restore`), so they outlast a window reload.

import * as path from 'node:path';
import type { CompletedEdit } from './agentChanges';

/** A file to put back: its text before the turn, or undefined when the turn created it. */
export interface FileRestore {
	readonly path: string;
	readonly text: string | undefined;
	/** What the agent last wrote to the file; if the file differs, someone changed it since. */
	readonly agentText: string;
}

export interface UndoPlan {
	readonly restores: readonly FileRestore[];
	/** How many turns after the one being undone also changed files; their changes go too. */
	readonly laterTurns: number;
}

interface Turn {
	id: string;
	/** Path to its text before the turn; undefined when the turn created it. */
	readonly before: Map<string, string | undefined>;
	bytes: number;
	/** False when the turn's files were too large to keep. */
	undoable: boolean;
}

export interface CheckpointLimits {
	/** Turns kept per chat; the oldest go first. */
	readonly maxTurns: number;
	/** Text kept per turn; a turn past it cannot be undone. */
	readonly maxTurnBytes: number;
	/** Text kept for all turns; the oldest go first past it. */
	readonly maxTotalBytes: number;
}

const defaultLimits: CheckpointLimits = { maxTurns: 100, maxTurnBytes: 1_000_000, maxTotalBytes: 20_000_000 };

/** The checkpoints as saved: the turns oldest first, and what the agent last wrote to each file. */
export interface StoredCheckpoints {
	readonly turns: readonly {
		readonly id: string;
		/** Path and its text before the turn; null when the turn created it. */
		readonly before: readonly (readonly [string, string | null])[];
		readonly undoable: boolean;
	}[];
	readonly agentText: readonly (readonly [string, string])[];
}

export class Checkpoints {

	private readonly turns: Turn[] = [];
	private current: Turn | undefined;
	/** What the agent last wrote to each file it edited in a kept turn. */
	private readonly agentText = new Map<string, string>();

	constructor(private readonly cwd: string, private readonly limits: CheckpointLimits = defaultLimits) { }

	/** How many files the running turn changed so far. */
	get running(): number {
		return this.current?.before.size ?? 0;
	}

	/** Starts keeping the files the next edits change. */
	beginTurn(): void {
		this.current = { id: '', before: new Map(), bytes: 0, undoable: true };
	}

	/** Adds a completed tool call's edits to the turn that is running. */
	record(edits: readonly CompletedEdit[]): void {
		const turn = this.current;
		if (!turn) {
			return;
		}
		for (const edit of edits) {
			const filePath = path.resolve(this.cwd, edit.path);
			if (!turn.before.has(filePath)) {
				// As in AgentChanges, no old text means the edit made the file.
				const before = edit.oldText ? edit.oldText : undefined;
				// A turn that can't be undone keeps only which files it changed, not their text.
				turn.before.set(filePath, turn.undoable ? before : undefined);
				turn.bytes += before?.length ?? 0;
				if (turn.undoable && turn.bytes > this.limits.maxTurnBytes) {
					turn.undoable = false;
					for (const file of turn.before.keys()) {
						turn.before.set(file, undefined);
					}
				}
			}
			this.agentText.set(filePath, edit.newText);
		}
	}

	/**
	 * Ends the running turn as `id` (its turnEnd item). Returns the ids of
	 * turns that can no longer be undone because older turns were dropped,
	 * and whether this one can be.
	 */
	endTurn(id: string): { readonly undoable: boolean; readonly dropped: readonly string[] } {
		const turn = this.current;
		this.current = undefined;
		if (!turn?.before.size) {
			return { undoable: false, dropped: [] };
		}
		turn.id = id;
		this.turns.push(turn);
		// Undo goes back through every later turn, so nothing before a turn that can't be undone can be either.
		const keep = turn.undoable ? this.limits.maxTurns : 1;
		const dropped = this.turns.splice(0, Math.max(0, this.turns.length - keep)).map(t => t.id);
		let total = this.turns.reduce((sum, t) => sum + t.bytes, 0);
		while (this.turns.length > 1 && total > this.limits.maxTotalBytes) {
			const oldest = this.turns.shift()!;
			total -= oldest.bytes;
			dropped.push(oldest.id);
		}
		this.forgetUnusedFiles();
		return { undoable: turn.undoable, dropped };
	}

	/** Whether turn `id` can be undone now. */
	canUndo(id: string): boolean {
		const index = this.turns.findIndex(t => t.id === id);
		return index !== -1 && this.turns.slice(index).every(t => t.undoable);
	}

	/** The number of files turn `id` changed, if it is kept. */
	fileCount(id: string): number {
		return this.turns.find(t => t.id === id)?.before.size ?? 0;
	}

	/**
	 * What undoing turn `id` puts back: every file it or a later turn changed,
	 * as it was before the earliest of those turns.
	 */
	plan(id: string): UndoPlan | undefined {
		const index = this.turns.findIndex(t => t.id === id);
		if (index === -1 || !this.canUndo(id) || this.current) {
			return undefined;
		}
		const restores = new Map<string, FileRestore>();
		for (const turn of this.turns.slice(index)) {
			for (const [filePath, text] of turn.before) {
				if (!restores.has(filePath)) {
					restores.set(filePath, { path: filePath, text, agentText: this.agentText.get(filePath) ?? '' });
				}
			}
		}
		return { restores: [...restores.values()], laterTurns: this.turns.length - index - 1 };
	}

	/** Forgets turn `id` and the turns after it, once they were undone; returns their ids. */
	undone(id: string): string[] {
		const index = this.turns.findIndex(t => t.id === id);
		if (index === -1) {
			return [];
		}
		const removed = this.turns.splice(index);
		const restored = new Set<string>();
		for (const turn of removed) {
			for (const [filePath, text] of turn.before) {
				if (!restored.has(filePath)) {
					// The file is back to what an earlier turn left, if one did.
					restored.add(filePath);
					this.agentText.set(filePath, text ?? '');
				}
			}
		}
		this.forgetUnusedFiles();
		return removed.map(t => t.id);
	}

	/** The ids of the turns kept, oldest first. */
	get turnIds(): readonly string[] {
		return this.turns.map(t => t.id);
	}

	/** The kept turns, to save with the agent. */
	toStored(): StoredCheckpoints {
		return {
			turns: this.turns.map(t => ({ id: t.id, before: [...t.before].map(([file, text]) => [file, text ?? null] as const), undoable: t.undoable })),
			agentText: [...this.agentText],
		};
	}

	/** Takes back saved turns, for an agent from an earlier window; anything malformed is left out. */
	restore(stored: StoredCheckpoints | undefined): void {
		this.clear();
		if (!stored || !Array.isArray(stored.turns) || !Array.isArray(stored.agentText)) {
			return;
		}
		for (const turn of stored.turns) {
			if (typeof turn?.id !== 'string' || !Array.isArray(turn.before)) {
				continue;
			}
			const before = new Map<string, string | undefined>();
			let bytes = 0;
			for (const entry of turn.before) {
				if (Array.isArray(entry) && typeof entry[0] === 'string' && (typeof entry[1] === 'string' || entry[1] === null)) {
					before.set(entry[0], entry[1] ?? undefined);
					bytes += entry[1]?.length ?? 0;
				}
			}
			this.turns.push({ id: turn.id, before, bytes, undoable: turn.undoable === true });
		}
		for (const entry of stored.agentText) {
			if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
				this.agentText.set(entry[0], entry[1]);
			}
		}
		this.forgetUnusedFiles();
	}

	/** Forgets every turn, for example when the conversation is cleared. */
	clear(): void {
		this.turns.length = 0;
		this.current = undefined;
		this.agentText.clear();
	}

	private forgetUnusedFiles(): void {
		for (const filePath of this.agentText.keys()) {
			if (!this.turns.some(t => t.before.has(filePath))) {
				this.agentText.delete(filePath);
			}
		}
	}
}

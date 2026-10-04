/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checkpoints: for each of a chat's recent turns, the text every file had
// before the agent first edited it in that turn, so the turn can be undone.
// Kept in memory only, for the last few turns, and capped in size.

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
}

const defaultLimits: CheckpointLimits = { maxTurns: 20, maxTurnBytes: 1_000_000 };

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
				turn.before.set(filePath, before);
				turn.bytes += before?.length ?? 0;
				if (turn.bytes > this.limits.maxTurnBytes) {
					turn.undoable = false;
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
		const dropped = this.turns.splice(0, Math.max(0, this.turns.length - this.limits.maxTurns)).map(t => t.id);
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

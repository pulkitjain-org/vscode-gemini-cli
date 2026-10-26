/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Plan Review keeps for a plan file between sessions: one JSON file per
// plan under the extension's global storage, read when its review opens (not
// at startup, as global state would be) and read again before each change,
// so two windows reviewing the same plan don't overwrite each other. State
// untouched for a month is pruned, unless it holds comments not sent yet on
// a plan that is still there. A plan that is gone keeps its state until
// then: a rebuilt plan prefers Plan Review's copy (sessionReplay.ts).

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PlanComment } from './planReview';

/** What is kept for one plan file. */
export interface PlanReviewState {
	readonly comments: readonly PlanComment[];
	/** Sections the user edited since the last send. */
	readonly edited: readonly string[];
	/** The plan when the review was last sent, for what the revision changed. */
	readonly before?: string;
	readonly revising?: boolean;
	/** While revising: what to put back if the comments never reach the agent. */
	readonly unsend?: {
		/** The `sentAt` of the comments sent. */
		readonly sentAt: number;
		readonly edited: readonly string[];
		readonly before?: string;
		readonly changed?: readonly string[];
	};
	readonly changed?: readonly string[];
	/** The plan as the page last saw it, once the user edited it there: a rebuilt plan prefers it (sessionReplay.ts). */
	readonly plan?: string;
	/** When `plan` was last seen, in ms since the epoch. */
	readonly planAt?: number;
}

interface StoredState extends PlanReviewState {
	readonly file: string;
	readonly updatedAt: number;
}

export const emptyPlanReview: PlanReviewState = { comments: [], edited: [] };

/** How long state for a plan nobody reviews is kept. */
export const keepPlanReviewMs = 30 * 24 * 60 * 60 * 1000;

/** The global state key earlier versions kept a plan's review under. */
export const legacyPlanReviewKey = 'gemini.planReview:';

export class PlanReviewStore {

	constructor(private readonly folder: string) { }

	private path(file: string): string {
		return path.join(this.folder, `${createHash('sha1').update(file).digest('hex')}.json`);
	}

	/** The state kept for plan `file`; empty when there is none. */
	async read(file: string): Promise<PlanReviewState> {
		const stored = await readStored(this.path(file));
		if (stored?.file !== file) {
			return emptyPlanReview;
		}
		const { file: _file, updatedAt: _updatedAt, ...state } = stored;
		return state;
	}

	/** Keeps `state` for `file`, or forgets the file when there is nothing worth keeping. */
	async write(file: string, state: PlanReviewState, now = Date.now()): Promise<void> {
		const target = this.path(file);
		if (!state.comments.length && !state.edited.length && !state.revising && state.before === undefined && state.plan === undefined) {
			await fs.rm(target, { force: true });
			return;
		}
		await fs.mkdir(this.folder, { recursive: true });
		// Written aside and renamed, so another window never reads half a file.
		const temp = `${target}.${process.pid}.${now.toString(36)}.tmp`;
		const stored: StoredState = { ...state, file, updatedAt: now };
		await fs.writeFile(temp, JSON.stringify(stored), 'utf8');
		await fs.rename(temp, target);
	}

	/** Re-reads `file`'s state, changes it with `change`, and keeps the result; resolves with it. */
	async update(file: string, change: (state: PlanReviewState) => Partial<PlanReviewState>, now = Date.now()): Promise<PlanReviewState> {
		const current = await this.read(file);
		const next = { ...current, ...change(current) };
		await this.write(file, next, now);
		return next;
	}

	/**
	 * Forgets state last changed more than `maxAgeMs` ago, except comments
	 * not sent yet on a plan that is still there, and files that aren't a
	 * plan's state; resolves with how many went.
	 */
	async prune(now = Date.now(), maxAgeMs = keepPlanReviewMs): Promise<number> {
		const names = await fs.readdir(this.folder).catch(() => [] as string[]);
		let removed = 0;
		for (const name of names) {
			const entry = path.join(this.folder, name);
			const stored = name.endsWith('.json') ? await readStored(entry) : undefined;
			// A temporary file a moment old may be another window's write in progress.
			const stale = stored
				? now - stored.updatedAt > maxAgeMs && !(stored.comments.some(comment => !comment.sentAt) && await exists(stored.file))
				: name.endsWith('.tmp') ? now - await mtime(entry) > 60_000 : true;
			if (stale) {
				await fs.rm(entry, { force: true, recursive: true });
				removed++;
			}
		}
		return removed;
	}
}

/**
 * The plan Plan Review last saw for `file`, with when, if the user edited it
 * there; for a plan rebuilt after the CLI deleted it. `folder` is the store's.
 */
export async function keptPlan(folder: string, file: string): Promise<{ readonly text: string; readonly at: number } | undefined> {
	const state = await new PlanReviewStore(folder).read(file);
	return state.plan !== undefined ? { text: state.plan, at: state.planAt ?? 0 } : undefined;
}

async function readStored(file: string): Promise<StoredState | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<StoredState>;
		return typeof value.file === 'string' && typeof value.updatedAt === 'number' && Array.isArray(value.comments) && Array.isArray(value.edited) ? value as StoredState : undefined;
	} catch {
		return undefined;
	}
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(() => true, () => false);
}

async function mtime(file: string): Promise<number> {
	return fs.stat(file).then(stat => stat.mtimeMs, () => 0);
}

/**
 * `state` with its revision undone, as when the comments sent never reached
 * the agent: they are unsent again, with the edits and marks from before.
 */
export function unsentReview(state: PlanReviewState): Partial<PlanReviewState> {
	const { unsend } = state;
	// Kept by an earlier version without `unsend`: the comments sent last.
	const sentAt = unsend?.sentAt ?? Math.max(0, ...state.comments.map(each => each.sentAt ?? 0));
	return {
		comments: state.comments.map(each => each.sentAt === sentAt ? withoutSentAt(each) : each),
		edited: [...new Set([...unsend?.edited ?? [], ...state.edited])],
		before: unsend?.before,
		changed: unsend?.changed ?? [],
		revising: false,
		unsend: undefined,
	};
}

function withoutSentAt(comment: PlanComment): PlanComment {
	const { sentAt: _sentAt, ...rest } = comment;
	return rest;
}

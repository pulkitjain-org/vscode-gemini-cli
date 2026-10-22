/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The merge request reviews in progress (src/host/teamFlows.ts): one file per
// review, written as the draft changes, so closing the Review page or
// quitting the app loses nothing. Home, the reviewer's chat and the Command
// Palette reopen a review from here. A review goes when it is posted or
// discarded, or after two weeks untouched.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DiffRefs } from './gitlab';
import type { ReviewDraft } from './reviewDraft';
import type { AgentWorktree } from './worktrees';

export interface SavedReview {
	readonly project: string;
	readonly iid: number;
	readonly title: string;
	readonly url: string;
	readonly author: string;
	readonly source: string;
	readonly target: string;
	/** The clone the diffs read commits from, and its remote. */
	readonly repository: string;
	readonly remote: string;
	/** The reviewer agent's checkout, kept for Ask Gemini Again. */
	readonly worktree?: AgentWorktree;
	readonly agentId?: string;
	/** The version the diffs show and comments are posted against. */
	readonly refs?: DiffRefs;
	readonly summary: string;
	readonly state: 'reviewing' | 'ready' | 'unparsed';
	readonly draft: ReviewDraft;
	/** Bumped each time Gemini's findings are read, for new ids. */
	readonly rev: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** How long an untouched review is kept. */
export const reviewKeepMs = 14 * 24 * 60 * 60 * 1000;

export class ReviewStore {

	constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) { }

	async get(project: string, iid: number): Promise<SavedReview | undefined> {
		try {
			const review = JSON.parse(await fs.readFile(this.file(project, iid), 'utf8')) as SavedReview;
			return review.project === project && review.iid === iid ? review : undefined;
		} catch {
			return undefined;
		}
	}

	/** Writes the review, stamped with the time. */
	async save(review: Omit<SavedReview, 'createdAt' | 'updatedAt'> & { readonly createdAt?: string }): Promise<SavedReview> {
		const now = this.now().toISOString();
		const saved: SavedReview = { ...review, createdAt: review.createdAt ?? now, updatedAt: now };
		await fs.mkdir(this.dir, { recursive: true });
		// Written beside it and renamed over it, so a quit mid-write leaves the last good draft.
		const file = this.file(review.project, review.iid);
		await fs.writeFile(`${file}.tmp`, JSON.stringify(saved, null, '\t'));
		await fs.rename(`${file}.tmp`, file);
		return saved;
	}

	async remove(project: string, iid: number): Promise<void> {
		await fs.rm(this.file(project, iid), { force: true });
	}

	/** The reviews in progress, the last changed first; those untouched for two weeks are removed. */
	async list(): Promise<SavedReview[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch {
			return [];
		}
		const cutoff = this.now().getTime() - reviewKeepMs;
		const reviews: SavedReview[] = [];
		for (const name of names.filter(n => n.endsWith('.json'))) {
			const file = path.join(this.dir, name);
			try {
				const review = JSON.parse(await fs.readFile(file, 'utf8')) as SavedReview;
				if (Date.parse(review.updatedAt) < cutoff) {
					await fs.rm(file, { force: true });
				} else if (review.project && review.iid) {
					reviews.push(review);
				}
			} catch {
				// An unreadable review is of no use.
				await fs.rm(file, { force: true });
			}
		}
		return reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	private file(project: string, iid: number): string {
		return path.join(this.dir, `${project.replace(/[^\w.-]+/g, '_')}-${iid}.json`);
	}
}

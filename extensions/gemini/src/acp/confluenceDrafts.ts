/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Confluence pages an agent drafted, waiting for the user's review: one file
// per draft, written as the user edits it, so closing the Review Page or
// quitting loses nothing. Nothing reaches Confluence until the user
// publishes; a draft goes when it is published or discarded, or after two
// weeks untouched.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AdfDocument } from './confluence';
import type { DraftReview } from './draftReview';
import { quarantine, writeJsonAtomic } from './fsUtil';

/** Where a draft goes: a new page in a space, or a new version of a page. */
export type DraftTarget =
	| { readonly kind: 'new'; readonly spaceId: string; readonly spaceKey: string; readonly spaceName?: string; readonly parentId?: string; readonly parentTitle?: string }
	| { readonly kind: 'edit'; readonly pageId: string; readonly url: string; readonly baseVersion: number; readonly baseTitle: string; readonly base: AdfDocument; readonly spaceKey?: string };

export interface ConfluenceDraft {
	readonly id: string;
	/** The Confluence site's address. */
	readonly site: string;
	readonly target: DraftTarget;
	readonly title: string;
	/** What the agent wrote, as Markdown; the Review Page makes the editor's document from it. */
	readonly markdown: string;
	/** The user's edit once saved, which replaces `markdown`. */
	readonly saved?: AdfDocument;
	/** The user's decisions on the draft's changes, and the places left to pick after the page changed. */
	readonly review?: DraftReview;
	readonly agent?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** How long an untouched draft is kept. */
export const draftKeepMs = 14 * 24 * 60 * 60 * 1000;

export class DraftStore {

	constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) { }

	async get(id: string): Promise<ConfluenceDraft | undefined> {
		if (!/^[\w-]+$/.test(id)) {
			return undefined;
		}
		try {
			const draft = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as ConfluenceDraft;
			return draft.id === id ? draft : undefined;
		} catch {
			return undefined;
		}
	}

	/** Writes the draft, stamped with the time. */
	async save(draft: Omit<ConfluenceDraft, 'updatedAt'>): Promise<ConfluenceDraft> {
		const stamped: ConfluenceDraft = { ...draft, updatedAt: this.now().toISOString() };
		await fs.mkdir(this.dir, { recursive: true });
		await writeJsonAtomic(this.file(draft.id), stamped);
		return stamped;
	}

	async remove(id: string): Promise<void> {
		if (/^[\w-]+$/.test(id)) {
			await fs.rm(this.file(id), { force: true });
		}
	}

	/** Every draft kept, newest first; ones untouched for two weeks are removed, and unreadable ones set aside. */
	async list(): Promise<ConfluenceDraft[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch {
			return [];
		}
		const drafts: ConfluenceDraft[] = [];
		for (const name of names.filter(n => n.endsWith('.json'))) {
			const file = path.join(this.dir, name);
			try {
				const draft = JSON.parse(await fs.readFile(file, 'utf8')) as ConfluenceDraft;
				if (this.now().getTime() - Date.parse(draft.updatedAt) > draftKeepMs) {
					await fs.rm(file, { force: true });
					continue;
				}
				drafts.push(draft);
			} catch {
				await quarantine(file).catch(() => undefined);
			}
		}
		return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	private file(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}
}

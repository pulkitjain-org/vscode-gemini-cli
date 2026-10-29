/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The documentation sources the user added, and the folders each is
// attached to: one JSON file beside the sources' stores
// (~/.geminicode/index/docs/sources.json), shared by every window. Writes go
// to a temporary file renamed into place, so a reader never sees half a file.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DocsRefresh, DocsScope } from './docsProtocol';

export interface DocsSource {
	readonly id: string;
	readonly url: string;
	readonly scope: DocsScope;
	readonly maxPages: number;
	/** Unset follows `gemini.docs.refresh`. */
	readonly refresh?: DocsRefresh;
	/** The site's name, from its pages. */
	readonly title?: string;
	readonly addedAt: number;
	readonly fetchedAt?: number;
	/** The last fetch's problem, until a fetch works. */
	readonly error?: string;
	/** Fetches that failed in a row, and when the last did, for retrying later and later. */
	readonly failures?: number;
	readonly failedAt?: number;
	readonly pages?: number;
	/** Folders whose agents can search it. */
	readonly folders: readonly string[];
}

const dayMs = 24 * 60 * 60 * 1000;
/** The first retry of a source whose fetch failed; each failure after doubles it, up to a day. */
const firstRetryMs = 15 * 60 * 1000;

/** A source's id: the same address and scope are one source, whoever adds them. */
export function sourceId(url: string, scope: DocsScope): string {
	return createHash('sha1').update(`${scope} ${normalizedUrl(url)}`).digest('hex').slice(0, 16);
}

/** An address as sources compare it: no fragment, no trailing slash on a path. */
export function normalizedUrl(url: string): string {
	const parsed = new URL(url);
	parsed.hash = '';
	if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
		parsed.pathname = parsed.pathname.replace(/\/+$/, '');
	}
	return parsed.href;
}

/** Whether a source is due to be fetched again. */
export function isDue(source: DocsSource, fallback: DocsRefresh, now: number): boolean {
	const refresh = source.refresh ?? fallback;
	if (source.fetchedAt === undefined) {
		return true;
	}
	if (refresh === 'manual') {
		return false;
	}
	return now - source.fetchedAt >= (refresh === 'weekly' ? 7 * dayMs : dayMs);
}

/**
 * Whether a source whose last fetch failed is due another try: 15 minutes
 * after the first failure, then 30, an hour and so on, at most a day apart.
 * A source refreshed only by hand is tried again only until it first works.
 */
export function retryDue(source: DocsSource, fallback: DocsRefresh, now: number): boolean {
	if ((source.refresh ?? fallback) === 'manual' && source.fetchedAt !== undefined) {
		return false;
	}
	const failures = Math.max(1, source.failures ?? 1);
	const wait = Math.min(firstRetryMs * 2 ** Math.min(failures - 1, 16), dayMs);
	return now - (source.failedAt ?? source.fetchedAt ?? source.addedAt) >= wait;
}

/** A readable name for a source before its pages give one: the host and the path's last part. */
export function provisionalTitle(url: string): string {
	const parsed = new URL(url);
	const last = parsed.pathname.split('/').filter(Boolean).pop();
	return last ? `${parsed.hostname} \u203a ${last}` : parsed.hostname;
}

export class DocsRegistry {

	private cache: { readonly sources: readonly DocsSource[]; readonly mtime: number } | undefined;
	private writing: Promise<unknown> = Promise.resolve();

	constructor(readonly file: string) { }

	/** The sources, read again only when the file changed (another window wrote it). */
	async load(): Promise<readonly DocsSource[]> {
		const stat = await fs.stat(this.file).catch(() => undefined);
		if (!stat) {
			this.cache = { sources: [], mtime: 0 };
			return [];
		}
		if (this.cache?.mtime === stat.mtimeMs) {
			return this.cache.sources;
		}
		let sources: DocsSource[] = [];
		try {
			const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as { sources?: unknown };
			sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isSource) : [];
		} catch {
			// A damaged file reads as empty; the next change writes a good one.
		}
		this.cache = { sources, mtime: stat.mtimeMs };
		return sources;
	}

	/** The sources as last read, without touching the disk. */
	get cached(): readonly DocsSource[] {
		return this.cache?.sources ?? [];
	}

	/** Changes the list, one change at a time. */
	update(change: (sources: readonly DocsSource[]) => readonly DocsSource[]): Promise<readonly DocsSource[]> {
		const next = this.writing.then(async () => {
			const sources = change(await this.load());
			await fs.mkdir(path.dirname(this.file), { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			await fs.writeFile(temporary, JSON.stringify({ version: 1, sources }, undefined, '\t'));
			await fs.rename(temporary, this.file);
			const stat = await fs.stat(this.file);
			this.cache = { sources, mtime: stat.mtimeMs };
			return sources;
		});
		this.writing = next.catch(() => undefined);
		return next;
	}
}

function isSource(value: unknown): value is DocsSource {
	const source = value as Partial<DocsSource> | null;
	return !!source && typeof source.id === 'string' && /^[\w-]+$/.test(source.id) && typeof source.url === 'string'
		&& (source.scope === 'page' || source.scope === 'prefix' || source.scope === 'site') && typeof source.maxPages === 'number'
		&& Array.isArray(source.folders) && source.folders.every(f => typeof f === 'string');
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Documentation sources in the indexer process: each source (a URL the user
// added) is its own SQLite file under <base>/docs, stored once however many
// workspaces attach it. Pages arrive from the extension host, which fetches
// them; here they become Markdown, are cut into sections by heading, and
// are searched like code, with headings weighted above body text.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { queryTerms } from '../index/query';
import type { DocsPage } from '../index/indexerProtocol';
import type { DocsHit, DocsSearchResult, DocsSourceInput, DocsSourceStatus } from './docsProtocol';
import { htmlToMarkdown } from './htmlToMarkdown';

const schema = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pages(url TEXT PRIMARY KEY, title TEXT NOT NULL, hash TEXT NOT NULL, run INTEGER NOT NULL, etag TEXT, last_modified TEXT);
CREATE TABLE IF NOT EXISTS sections(id INTEGER PRIMARY KEY, url TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sections_url ON sections(url);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(text, heading, title, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
`;

const maxSectionChars = 2_500;
const defaultLimit = 6;
const maxLimit = 15;
/** Sources kept open at once. */
const maxOpen = 16;

export interface Section {
	readonly heading: string;
	readonly text: string;
}

type Sqlite = typeof import('node:sqlite');

export class DocsLibrary {

	private readonly open = new Map<string, { db: DatabaseSync; statements: Map<string, StatementSync> }>();

	constructor(private readonly baseDir: string) { }

	async ingest({ source, pages, unchanged, complete }: { source: DocsSourceInput; pages: readonly DocsPage[]; unchanged: readonly string[]; complete: boolean }): Promise<DocsSourceStatus> {
		const db = await this.db(source.id);
		const run = (sql: string, ...args: (string | number | bigint | null)[]) => this.statement(source.id, sql).run(...args);
		db.exec('BEGIN');
		try {
			for (const page of pages) {
				const converted = page.type === 'html' ? htmlToMarkdown(page.body, page.url) : { title: titleOfMarkdown(page.body) ?? page.url, markdown: page.body };
				const hash = createHash('sha1').update(converted.markdown).digest('hex');
				const existing = this.statement(source.id, 'SELECT hash FROM pages WHERE url = ?').get(page.url) as { hash: string } | undefined;
				run('INSERT OR REPLACE INTO pages(url, title, hash, run, etag, last_modified) VALUES (?, ?, ?, ?, ?, ?)', page.url, converted.title || page.url, hash, source.run, page.etag ?? null, page.lastModified ?? null);
				if (existing?.hash === hash) {
					continue;
				}
				this.removeSections(source.id, page.url);
				for (const section of sectionsOf(converted.markdown)) {
					const id = run('INSERT INTO sections(url, heading, text) VALUES (?, ?, ?)', page.url, section.heading, section.text).lastInsertRowid;
					run('INSERT INTO sections_fts(rowid, text, heading, title) VALUES (?, ?, ?, ?)', id, section.text, section.heading, converted.title);
				}
				if (!this.meta(source.id, 'title') && converted.title) {
					run('INSERT OR REPLACE INTO meta(key, value) VALUES (\'title\', ?)', siteTitle(converted.title));
				}
			}
			for (const url of unchanged) {
				run('UPDATE pages SET run = ? WHERE url = ?', source.run, url);
			}
			if (complete) {
				for (const row of this.statement(source.id, 'SELECT url FROM pages WHERE run != ?').all(source.run) as { url: string }[]) {
					this.removeSections(source.id, row.url);
					run('DELETE FROM pages WHERE url = ?', row.url);
				}
				run('INSERT OR REPLACE INTO meta(key, value) VALUES (\'fetched_at\', ?)', String(Date.now()));
				run('INSERT OR REPLACE INTO meta(key, value) VALUES (\'url\', ?)', source.url);
			}
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
		return await this.statusOf(source.id);
	}

	async status({ ids }: { ids: readonly string[] }): Promise<DocsSourceStatus[]> {
		return Promise.all(ids.map(id => this.statusOf(id)));
	}

	async validators({ id }: { id: string }): Promise<Record<string, { etag?: string; lastModified?: string }>> {
		await this.db(id);
		const validators: Record<string, { etag?: string; lastModified?: string }> = {};
		for (const row of this.statement(id, 'SELECT url, etag, last_modified AS lastModified FROM pages').all() as { url: string; etag: string | null; lastModified: string | null }[]) {
			validators[row.url] = { etag: row.etag ?? undefined, lastModified: row.lastModified ?? undefined };
		}
		return validators;
	}

	async remove({ id }: { id: string }): Promise<void> {
		this.close(id);
		for (const suffix of ['', '-wal', '-shm']) {
			await fs.rm(this.file(id) + suffix, { force: true });
		}
	}

	async search({ ids, query, limit }: { ids: readonly string[]; query: string; limit?: number }): Promise<DocsSearchResult> {
		const max = Math.min(Math.max(1, Math.floor(limit ?? defaultLimit)), maxLimit);
		const { groups, words } = queryTerms(query);
		if (!groups.length || !ids.length) {
			return { hits: [], total: 0, terms: words };
		}
		const scored: { score: number; hit: DocsHit }[] = [];
		for (const id of ids) {
			await this.db(id);
			let any = false;
			for (const expression of groups.length > 1 ? [groups.join(' AND '), groups.join(' OR ')] : [groups[0]]) {
				let rows: { url: string; heading: string; text: string; title: string; score: number }[];
				try {
					rows = this.statement(id, `SELECT s.url AS url, s.heading AS heading, s.text AS text, p.title AS title, bm25(sections_fts, 1.0, 4.0, 2.0) AS score
						FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid JOIN pages p ON p.url = s.url
						WHERE sections_fts MATCH ? ORDER BY score LIMIT ?`).all(expression, max * 2) as typeof rows;
				} catch {
					rows = [];
				}
				for (const row of rows) {
					if (!scored.some(s => s.hit.url === row.url && s.hit.heading === row.heading)) {
						// An any-word match ranks below every all-words match.
						scored.push({ score: row.score + (any ? 1000 : 0), hit: { source: id, url: row.url, title: row.title, heading: row.heading, text: row.text } });
					}
				}
				if (rows.length >= max) {
					break;
				}
				any = true;
			}
		}
		scored.sort((a, b) => a.score - b.score);
		return { hits: scored.slice(0, max).map(s => s.hit), total: scored.length, terms: words };
	}

	dispose(): void {
		for (const id of [...this.open.keys()]) {
			this.close(id);
		}
	}

	private async statusOf(id: string): Promise<DocsSourceStatus> {
		await this.db(id);
		const count = (sql: string) => (this.statement(id, sql).get() as { n: number }).n;
		let bytes = 0;
		for (const suffix of ['', '-wal']) {
			bytes += (await fs.stat(this.file(id) + suffix).catch(() => undefined))?.size ?? 0;
		}
		const fetchedAt = this.meta(id, 'fetched_at');
		return { id, pages: count('SELECT count(*) AS n FROM pages'), sections: count('SELECT count(*) AS n FROM sections'), bytes, title: this.meta(id, 'title'), fetchedAt: fetchedAt ? Number(fetchedAt) : undefined };
	}

	private removeSections(id: string, url: string): void {
		for (const row of this.statement(id, 'SELECT id FROM sections WHERE url = ?').all(url) as { id: number }[]) {
			this.statement(id, 'DELETE FROM sections_fts WHERE rowid = ?').run(row.id);
		}
		this.statement(id, 'DELETE FROM sections WHERE url = ?').run(url);
	}

	private meta(id: string, key: string): string | undefined {
		return (this.statement(id, 'SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
	}

	private file(id: string): string {
		if (!/^[\w-]+$/.test(id)) {
			throw new Error(`Not a docs source id: ${id}`);
		}
		return path.join(this.baseDir, 'docs', `${id}.db`);
	}

	/** Opens the source's file, once; statements need it open. */
	private async db(id: string): Promise<DatabaseSync> {
		let entry = this.open.get(id);
		if (!entry) {
			const file = this.file(id);
			await fs.mkdir(path.dirname(file), { recursive: true });
			entry = this.open.get(id);
			if (entry) {
				return entry.db;
			}
			if (this.open.size >= maxOpen) {
				this.close(this.open.keys().next().value!);
			}
			const { DatabaseSync } = require('node:sqlite') as Sqlite;
			let db: DatabaseSync;
			try {
				db = new DatabaseSync(file);
				db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000');
				db.exec(schema);
			} catch {
				// A damaged source is fetched again from scratch.
				for (const suffix of ['', '-wal', '-shm']) {
					await fs.rm(file + suffix, { force: true });
				}
				db = new DatabaseSync(file);
				db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000');
				db.exec(schema);
			}
			entry = { db, statements: new Map() };
			this.open.set(id, entry);
		}
		return entry.db;
	}

	private statement(id: string, sql: string): StatementSync {
		const entry = this.open.get(id);
		if (!entry) {
			throw new Error(`The docs source ${id} is not open.`);
		}
		let statement = entry.statements.get(sql);
		if (!statement) {
			statement = entry.db.prepare(sql);
			entry.statements.set(sql, statement);
		}
		return statement;
	}

	private close(id: string): void {
		const entry = this.open.get(id);
		if (entry) {
			entry.statements.clear();
			try {
				entry.db.close();
			} catch {
				// Already closed.
			}
			this.open.delete(id);
		}
	}
}

/** Markdown cut at its headings (to the third level), each section with the headings above it; long ones by paragraph. */
export function sectionsOf(markdown: string): Section[] {
	const sections: Section[] = [];
	const trail: string[] = [];
	let body: string[] = [];
	let fence = false;
	const flush = () => {
		const text = body.join('\n').trim();
		body = [];
		if (!text) {
			return;
		}
		const heading = trail.filter(Boolean).join(' \u203a ');
		let current = '';
		for (const paragraph of text.split(/\n\s*\n/)) {
			if (current && current.length + paragraph.length > maxSectionChars) {
				sections.push({ heading, text: current.trim() });
				current = '';
			}
			current += `${paragraph.slice(0, maxSectionChars * 2)}\n\n`;
		}
		if (current.trim()) {
			sections.push({ heading, text: current.trim() });
		}
	};
	for (const line of markdown.split('\n')) {
		if (/^\s*(?:```|~~~)/.test(line)) {
			fence = !fence;
		}
		const heading = !fence && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			flush();
			const level = heading[1].length;
			trail.length = level - 1;
			trail[level - 1] = heading[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
			continue;
		}
		body.push(line);
	}
	flush();
	return sections;
}

function titleOfMarkdown(markdown: string): string | undefined {
	return /^#\s+(.+)$/m.exec(markdown)?.[1].trim();
}

/** A page title's site part: "useEffect | React" → "React", also after a dash or a middle dot. */
function siteTitle(title: string): string {
	const parts = title.split(/\s+[|\u2013\u2014\u00b7-]\s+/);
	return (parts.length > 1 ? parts[parts.length - 1] : title).trim();
}

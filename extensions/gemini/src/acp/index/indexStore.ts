/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One folder's index: a SQLite file (node:sqlite, built into the app's Node,
// so no native module) in WAL mode, written in transactions so a crash leaves
// the last committed state. A file SQLite reports damaged, or one written
// with another schema, is moved aside and started again: a broken index never
// fails a prompt, it only costs a rebuild. Any other error opening it (the
// file is busy, the disk is full, too many open files) leaves the file alone
// and fails, to be tried again: a healthy index is never thrown away for a
// passing problem. Opening checks nothing more than the schema, since a full
// check reads the whole file (seconds for a large repository); damage found
// later is reported by `isCorruption`.
//
// Chunk text is stored compressed, about a third of its size for source
// code: the index of a 20,000-file repository (this one) went from 537 MB to
// about 310 MB. The full-text index keeps word positions, which cost a tenth
// of that but give BM25 the term counts that rank a definition above a mention.

import { promises as fs } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { identifierWords, splitIdentifier } from './identifiers';
import type { ParsedFile } from './parse';

/** Raise when the tables change; an index with another version is rebuilt. */
export const schemaVersion = 1;

/**
 * The bounds of every path under `prefix`, for `path >= ? AND path < ?`,
 * which the primary key answers in order; `LIKE 'prefix%'` scans the table.
 * The upper bound is the prefix followed by the largest code point.
 */
export function prefixRange(prefix: string): readonly [string, string] {
	return [prefix, `${prefix}\u{10FFFF}`];
}
/** Pages the backup copies per step, between which queries run. */
const backupPagesPerStep = 256;

const schema = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, lang TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL, skipped TEXT);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, symbol TEXT, body BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, idents, path, symbol, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER NOT NULL, container TEXT, exported INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
CREATE TABLE IF NOT EXISTS imports(id INTEGER PRIMARY KEY, path TEXT NOT NULL, spec TEXT NOT NULL, target TEXT);
CREATE INDEX IF NOT EXISTS imports_path ON imports(path);
CREATE INDEX IF NOT EXISTS imports_target ON imports(target);
CREATE TABLE IF NOT EXISTS cochange(a TEXT NOT NULL, b TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(a, b)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cochange_b ON cochange(b);
`;

export interface FileState {
	readonly size: number;
	readonly mtime: number;
	readonly hash: string;
	/** Why it was read but left out, when it was. */
	readonly skipped?: string;
}

export interface FileRecord extends FileState {
	readonly path: string;
	readonly lang: string;
	/** Why the file was read but not indexed, such as binary content. */
	readonly skipped?: string;
}

type Sqlite = typeof import('node:sqlite');

/** Loaded on first use: `node:sqlite` prints an experimental warning when it loads. */
let sqlite: Sqlite | undefined;
function loadSqlite(): Sqlite {
	return sqlite ??= require('node:sqlite') as Sqlite;
}

/** The index was written with another schema, so it is rebuilt. */
export class SchemaMismatch extends Error {
	constructor() {
		super('The index is from another version.');
	}
}

interface Counts {
	files: number;
	symbols: number;
	skipped: number;
}

export class IndexStore {

	private readonly statements = new Map<string, StatementSync>();
	/** Counted once, then kept current by each write, so a save doesn't count every row again. */
	private counted: Counts | undefined;

	private constructor(readonly db: DatabaseSync, readonly file: string, readonly readOnly: boolean) { }

	/**
	 * Opens the index at `file`, creating it (and its folder) when missing. A
	 * file SQLite reports damaged, or one from another schema, is moved aside
	 * and a new one started, unless `readOnly`, which then throws. Any other
	 * error leaves the file as it is and throws, to be tried again.
	 */
	static async open(file: string, options: { readonly readOnly?: boolean } = {}): Promise<IndexStore> {
		const { DatabaseSync } = loadSqlite();
		if (options.readOnly) {
			const db = new DatabaseSync(file, { readOnly: true });
			const store = new IndexStore(db, file, true);
			db.exec('PRAGMA busy_timeout = 3000');
			if (store.meta('schema_version') !== String(schemaVersion)) {
				db.close();
				throw new SchemaMismatch();
			}
			return store;
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		try {
			return IndexStore.openWritable(file, DatabaseSync);
		} catch (err) {
			if (!(err instanceof SchemaMismatch) && !isCorruption(err)) {
				throw err;
			}
			await moveAside(file);
			return IndexStore.openWritable(file, DatabaseSync);
		}
	}

	private static openWritable(file: string, Database: Sqlite['DatabaseSync']): IndexStore {
		const db = new Database(file);
		try {
			db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8000');
			const hasMeta = db.prepare('SELECT 1 FROM sqlite_master WHERE name = \'meta\'').get();
			const version = hasMeta ? (db.prepare('SELECT value FROM meta WHERE key = \'schema_version\'').get() as { value?: string } | undefined)?.value : undefined;
			if (hasMeta && version !== String(schemaVersion)) {
				throw new SchemaMismatch();
			}
			db.exec(schema);
			db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (\'schema_version\', ?)').run(String(schemaVersion));
			return new IndexStore(db, file, false);
		} catch (err) {
			db.close();
			throw err;
		}
	}

	/** A prepared statement, kept for reuse. */
	statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	meta(key: string): string | undefined {
		return (this.statement('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
	}

	setMeta(key: string, value: string): void {
		this.statement('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, value);
	}

	/** Runs `fn` in one transaction: all of it lands, or none. */
	transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN');
		try {
			const result = fn();
			this.db.exec('COMMIT');
			return result;
		} catch (err) {
			// The kept counts may have moved with what was rolled back.
			this.counted = undefined;
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	/**
	 * What the index knows of each file, or only of `paths`: a few changed
	 * files are looked up one by one rather than reading every row of a large
	 * repository's index.
	 */
	fileStates(paths?: readonly string[]): Map<string, FileState> {
		type Row = { path: string; size: number; mtime: number; hash: string; skipped: string | null };
		const rows = paths
			? paths.flatMap(p => (this.statement('SELECT path, size, mtime, hash, skipped FROM files WHERE path = ?').get(p) as Row | undefined) ?? [])
			: this.statement('SELECT path, size, mtime, hash, skipped FROM files').all() as Row[];
		const states = new Map<string, FileState>();
		for (const row of rows) {
			states.set(row.path, { size: row.size, mtime: row.mtime, hash: row.hash, ...row.skipped ? { skipped: row.skipped } : {} });
		}
		return states;
	}

	/** Replaces everything known about one file. `targets` are the files its imports resolve to, in `parsed.imports` order. */
	writeFile(record: FileRecord, parsed: ParsedFile | undefined, targets: readonly (string | undefined)[] = []): void {
		this.removeContents(record.path);
		this.countFile(record.path, -1);
		this.statement('INSERT OR REPLACE INTO files(path, lang, size, mtime, hash, skipped) VALUES (?, ?, ?, ?, ?, ?)')
			.run(record.path, record.lang, record.size, record.mtime, record.hash, record.skipped ?? null);
		if (this.counted) {
			this.counted[record.skipped ? 'skipped' : 'files']++;
		}
		if (!parsed) {
			return;
		}
		if (this.counted) {
			this.counted.symbols += parsed.symbols.length;
		}
		const pathWords = splitIdentifier(record.path).join(' ');
		for (const chunk of parsed.chunks) {
			const id = this.statement('INSERT INTO chunks(path, start_line, end_line, symbol, body) VALUES (?, ?, ?, ?, ?)')
				.run(record.path, chunk.startLine, chunk.endLine, chunk.symbol ?? null, packText(chunk.text)).lastInsertRowid;
			const symbolWords = chunk.symbol ? splitIdentifier(chunk.symbol).join(' ') : '';
			this.statement('INSERT INTO chunks_fts(rowid, text, idents, path, symbol) VALUES (?, ?, ?, ?, ?)')
				.run(id, chunk.text, `${identifierWords(chunk.text)} ${symbolWords}`, `${record.path} ${pathWords}`, chunk.symbol ? `${chunk.symbol} ${symbolWords}` : '');
		}
		for (const symbol of parsed.symbols) {
			this.statement('INSERT INTO symbols(path, name, kind, line, end_line, container, exported) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(record.path, symbol.name, symbol.kind, symbol.line, symbol.endLine, symbol.container ?? null, symbol.exported ? 1 : 0);
		}
		parsed.imports.forEach((spec, index) => {
			this.statement('INSERT INTO imports(path, spec, target) VALUES (?, ?, ?)').run(record.path, spec, targets[index] ?? null);
		});
	}

	/** Records a file's new stat when its content is unchanged. */
	touchFile(relative: string, size: number, mtime: number): void {
		this.statement('UPDATE files SET size = ?, mtime = ? WHERE path = ?').run(size, mtime, relative);
	}

	removeFile(relative: string): void {
		this.removeContents(relative);
		this.countFile(relative, -1);
		this.statement('DELETE FROM files WHERE path = ?').run(relative);
		this.statement('UPDATE imports SET target = NULL WHERE target = ?').run(relative);
	}

	/** The indexed files under the folder `relative`, found by their path's prefix. */
	filesUnder(relative: string): string[] {
		const prefix = `${relative.replace(/\/+$/, '')}/`;
		// '0' follows '/': the range is every path that starts with the prefix, read from the primary key.
		return (this.statement('SELECT path FROM files WHERE path >= ? AND path < ?').all(prefix, `${prefix.slice(0, -1)}0`) as { path: string }[]).map(row => row.path);
	}

	/** Moves the kept counts by one file at `relative`, of the kind it is stored as now. */
	private countFile(relative: string, delta: number): void {
		if (!this.counted) {
			return;
		}
		const row = this.statement('SELECT skipped FROM files WHERE path = ?').get(relative) as { skipped: string | null } | undefined;
		if (row) {
			this.counted[row.skipped ? 'skipped' : 'files'] += delta;
		}
	}

	private removeContents(relative: string): void {
		for (const row of this.statement('SELECT id FROM chunks WHERE path = ?').all(relative) as { id: number }[]) {
			this.statement('DELETE FROM chunks_fts WHERE rowid = ?').run(row.id);
		}
		this.statement('DELETE FROM chunks WHERE path = ?').run(relative);
		const removed = Number(this.statement('DELETE FROM symbols WHERE path = ?').run(relative).changes);
		if (this.counted) {
			this.counted.symbols -= removed;
		}
		this.statement('DELETE FROM imports WHERE path = ?').run(relative);
	}

	/**
	 * Imports not pointing at a file, whose specifier holds one of `names` as
	 * a part (`./cart`, `com.acme.Cart`, `cart.h`): the ones a newly added
	 * file can resolve. Only id and specifier are read for the rest.
	 */
	unresolvedImports(names: ReadonlySet<string>): { readonly id: number; readonly path: string; readonly spec: string; readonly lang: string }[] {
		const ids: number[] = [];
		for (const row of this.statement('SELECT id, spec FROM imports WHERE target IS NULL').iterate() as Iterable<{ id: number; spec: string }>) {
			if (row.spec.split(/[/\\.:]+/).some(part => names.has(part))) {
				ids.push(row.id);
			}
		}
		return ids.flatMap(id => (this.statement('SELECT imports.id AS id, imports.path AS path, imports.spec AS spec, files.lang AS lang FROM imports JOIN files ON files.path = imports.path WHERE imports.id = ?').get(id) as { id: number; path: string; spec: string; lang: string } | undefined) ?? []);
	}

	setImportTarget(id: number, target: string): void {
		this.statement('UPDATE imports SET target = ? WHERE id = ?').run(target, id);
	}

	replaceCochange(pairs: ReadonlyMap<string, number>): void {
		this.statement('DELETE FROM cochange').run();
		for (const [key, count] of pairs) {
			const [a, b] = key.split('\0');
			this.statement('INSERT INTO cochange(a, b, count) VALUES (?, ?, ?)').run(a, b, count);
		}
	}

	counts(): { readonly files: number; readonly symbols: number; readonly skipped: number } {
		if (!this.counted) {
			const files = (this.statement('SELECT count(*) AS n FROM files WHERE skipped IS NULL').get() as { n: number }).n;
			const skipped = (this.statement('SELECT count(*) AS n FROM files WHERE skipped IS NOT NULL').get() as { n: number }).n;
			const symbols = (this.statement('SELECT count(*) AS n FROM symbols').get() as { n: number }).n;
			if (this.readOnly) {
				// Another window writes it: what was counted goes stale.
				return { files, symbols, skipped };
			}
			this.counted = { files, symbols, skipped };
		}
		return { ...this.counted };
	}

	/**
	 * Copies the index to `target` with SQLite's online backup, a few hundred
	 * pages a step on SQLite's own thread, so queries go on meanwhile (`VACUUM
	 * INTO` held the process for seconds on a large index).
	 */
	async copyTo(target: string): Promise<void> {
		await loadSqlite().backup(this.db, target, { rate: backupPagesPerStep });
	}

	close(): void {
		this.counted = undefined;
		this.statements.clear();
		try {
			this.db.close();
		} catch {
			// Already closed.
		}
	}
}

/** A chunk's text as stored: compressed. */
function packText(text: string): Uint8Array {
	return deflateRawSync(text, { level: 6 });
}

/** A chunk's text from its stored body. */
export function unpackText(body: Uint8Array): string {
	return inflateRawSync(body).toString('utf8');
}

/** Whether an error says the index file is damaged, so it should be rebuilt. */
export function isCorruption(err: unknown): boolean {
	return /malformed|corrupt|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err));
}

/** Moves a damaged index out of the way, keeping only the latest one for a look. */
export async function moveAside(file: string): Promise<void> {
	const dir = path.dirname(file);
	const base = path.basename(file);
	for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
		if (name.startsWith(`${base}.broken`)) {
			await fs.rm(path.join(dir, name), { force: true });
		}
	}
	for (const suffix of ['', '-wal', '-shm']) {
		await fs.rename(file + suffix, `${file}.broken${suffix}`).catch(() => fs.rm(file + suffix, { force: true }));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What agents ask an index: ranked chunks for some words (BM25, with names
// and paths weighted above body text), where a symbol is defined and used,
// which files go with a file, and an outline of the folder.

import { bodyLines } from './format';
import { splitIdentifier } from './identifiers';
import { IgnoreRules } from './ignore';
import { IndexStore, unpackText } from './indexStore';

export interface SearchQuery {
	readonly query: string;
	/** A glob in .gitignore syntax: `src/cart`, `*.ts`, `**\/test/**`. */
	readonly path?: string;
	readonly lang?: string;
	readonly limit?: number;
}

export interface SearchHit {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly symbol?: string;
	readonly text: string;
}

export interface SearchResult {
	readonly hits: readonly SearchHit[];
	/** Matching chunks in all, when more matched than were returned. */
	readonly total: number;
	/** The words searched for, for pointing at the matching lines. */
	readonly terms: readonly string[];
}

export interface SymbolHit {
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly line: number;
	readonly endLine: number;
	readonly container?: string;
	readonly exported: boolean;
	/** The definition's first line. */
	readonly signature: string;
	/** The lines after the signature, up to `bodyLines` (format.ts); only the first definition carries them. */
	readonly body?: string;
}

export interface SymbolResult {
	readonly definitions: readonly SymbolHit[];
	/** Definitions with similar names, when none has this one. */
	readonly similar: readonly SymbolHit[];
	readonly references: readonly { readonly path: string; readonly line: number; readonly text: string }[];
	/** References found in all, when more were found than returned. */
	readonly referenceTotal: number;
}

export interface RelatedResult {
	readonly imports: readonly string[];
	readonly importedBy: readonly string[];
	readonly tests: readonly string[];
	readonly changedWith: readonly { readonly path: string; readonly count: number }[];
}

const maxLimit = 20;
const defaultLimit = 8;
const maxReferences = 60;
/** Chunks BM25 hands to re-ranking; their text is read only for the ones returned. */
const candidatePool = 150;
/** Words that only make a question a question. */
const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'be', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'and', 'or', 'not', 'it', 'its', 'this', 'that', 'these', 'those', 'where', 'what', 'which', 'who', 'how', 'why', 'when', 'does', 'do', 'did', 'can', 'should', 'we', 'i', 'you', 'all', 'any', 'some', 'there', 'here', 'into', 'about', 'find', 'show', 'me', 'get']);

/**
 * The words of a query, as SQLite's tokenizer sees them (letters and digits
 * of any script, diacritics folded as `remove_diacritics 2` folds them), with
 * camelCase names also split. Each word goes to FTS5 quoted, so nothing in a
 * query is read as its syntax.
 */
export function queryTerms(query: string): { readonly groups: readonly string[]; readonly words: readonly string[] } {
	const groups: string[] = [];
	const words = new Set<string>();
	for (const original of query.match(/[\p{L}\p{N}_]+/gu) ?? []) {
		const token = original.normalize('NFD').replace(/\p{M}+/gu, '');
		if (!token) {
			continue;
		}
		const lower = token.toLowerCase();
		if (token !== original) {
			// Live search (ripgrep) matches the text as written.
			words.add(original.toLowerCase());
		}
		if (stopWords.has(lower) && token === lower) {
			continue;
		}
		const parts = token.split('_').filter(Boolean).map(part => part.toLowerCase());
		// camelCase is split for ASCII names only; other scripts are one word each, as the tokenizer keeps them.
		const camel = /^[A-Za-z0-9_]+$/.test(token) ? splitIdentifier(token).filter(word => !parts.includes(word)) : [];
		const alternatives = [...parts.length > 1 ? [`(${parts.map(p => `"${p}"`).join(' AND ')})`] : [`"${lower}"*`], ...camel.length > 1 ? [`(${camel.map(w => `idents:"${w}"`).join(' AND ')})`] : []];
		groups.push(alternatives.length > 1 ? `(${alternatives.join(' OR ')})` : alternatives[0]);
		for (const word of [lower, ...parts, ...camel]) {
			words.add(word);
		}
	}
	return { groups, words: [...words] };
}

export function search(store: IndexStore, query: SearchQuery): SearchResult {
	const limit = Math.min(Math.max(1, Math.floor(query.limit ?? defaultLimit)), maxLimit);
	const { groups, words } = queryTerms(query.query);
	if (!groups.length) {
		return { hits: [], total: 0, terms: [] };
	}
	const filter = query.path ? new IgnoreRules([query.path]) : undefined;
	const wanted = (hit: { readonly path: string }) => !filter || filter.ignores(hit.path);
	const hits: SearchHit[] = [];
	const seen = new Set<number>();
	let total = 0;
	// A name in the query (applyDiscount, CartService, DISCOUNT_RULES) puts the chunk that defines it first.
	for (const row of definitionChunks(store, query.query, query.lang)) {
		if (!seen.has(row.id) && wanted(row) && hits.length < limit) {
			seen.add(row.id);
			hits.push({ path: row.path, startLine: row.startLine, endLine: row.endLine, symbol: row.symbol ?? undefined, text: chunkText(store, row.id) });
		}
	}
	// Every word first; then any of them, for what the strict search missed.
	for (const expression of groups.length > 1 ? [groups.join(' AND '), groups.join(' OR ')] : [groups[0]]) {
		// A wide pool, so re-ranking can lift code above the tests that outrank it in BM25.
		const rows = rerank(runMatch(store, expression, query.lang, filter ? 400 : candidatePool), query.query, words);
		const matching = rows.filter(row => !seen.has(row.id) && wanted(row));
		total = Math.max(total, matching.length + hits.length);
		for (const row of matching) {
			seen.add(row.id);
			if (hits.length < limit) {
				hits.push({ path: row.path, startLine: row.startLine, endLine: row.endLine, symbol: row.symbol ?? undefined, text: chunkText(store, row.id) });
			}
		}
		if (hits.length >= limit) {
			break;
		}
	}
	return { hits, total, terms: words };
}

interface ChunkRow {
	readonly id: number;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly symbol?: string;
}

/**
 * The chunks defining the names in a query: identifiers written as code
 * (camelCase, PascalCase, snake_case), or a single word on its own. Plain
 * words in a sentence ("editor service open") name no definition.
 */
function definitionChunks(store: IndexStore, query: string, lang: string | undefined): ChunkRow[] {
	const tokens = query.match(/[A-Za-z_$][\w$]*/g) ?? [];
	const names = tokens.filter(token => token.length > 2 && (tokens.length === 1 || /[a-z][A-Z]|[A-Z]{2,}[a-z]|_/.test(token)));
	if (!names.length) {
		return [];
	}
	const rows: ChunkRow[] = [];
	const wantsTests = asksForTests(query);
	for (const name of names.slice(0, 4)) {
		const definitions = store.statement(`SELECT s.path AS path, s.line AS line FROM symbols s${lang ? ' JOIN files f ON f.path = s.path AND f.lang = ?' : ''} WHERE s.name = ? COLLATE NOCASE ORDER BY s.exported DESC, s.container IS NOT NULL, length(s.path) LIMIT 3`)
			.all(...lang ? [lang.toLowerCase(), name] : [name]) as { path: string; line: number }[];
		for (const definition of definitions) {
			if (!wantsTests && isTestPath(definition.path)) {
				continue;
			}
			const chunk = store.statement('SELECT id, path, start_line AS startLine, end_line AS endLine, symbol FROM chunks WHERE path = ? AND start_line <= ? AND end_line >= ? ORDER BY start_line DESC LIMIT 1')
				.get(definition.path, definition.line, definition.line) as ChunkRow | undefined;
			if (chunk) {
				rows.push(chunk);
			}
		}
	}
	return rows;
}

/**
 * Puts the chunk that defines what the query names first, then chunks whose
 * definition or file name holds a query word, keeping BM25's order within
 * each. BM25 alone can't tell a definition from a call when a name is common
 * in the folder, or when the folder is small and every chunk shares the word.
 */
function rerank(rows: readonly ChunkRow[], query: string, words: readonly string[]): ChunkRow[] {
	const names = new Set((query.match(/[A-Za-z_$][\w$]*/g) ?? []).map(name => name.toLowerCase()));
	const useful = words.filter(word => word.length > 2);
	const wantsTests = asksForTests(query);
	const bonus = (row: ChunkRow) => {
		const symbol = (row.symbol ?? '').toLowerCase();
		const last = symbol.slice(symbol.lastIndexOf('.') + 1);
		const base = row.path.slice(row.path.lastIndexOf('/') + 1).toLowerCase();
		// Tests repeat the words of what they test, so they outrank it unless asked for.
		const test = !wantsTests && isTestPath(row.path) ? -3 : 0;
		return (names.has(last) || names.has(symbol) ? 4 : useful.some(word => last.includes(word)) ? 2 : 0) + (useful.some(word => base.includes(word)) ? 1 : 0) + test;
	};
	return rows.map((row, index) => ({ row, index, bonus: bonus(row) })).sort((a, b) => b.bonus - a.bonus || a.index - b.index).map(entry => entry.row);
}

/** Whether a path is a test: in a tests folder, or named as one (`*.test.ts`, `*Test.java`, `*_test.go`, `test_*.py`). */
export function isTestPath(relative: string): boolean {
	return /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\/|\.(?:test|spec)\.[a-z]+$|Tests?\.(?:java|kt|cs|scala|groovy)$|_test\.(?:go|py|rb)$|(?:^|\/)test_[^/]*\.py$/.test(relative);
}

function asksForTests(query: string): boolean {
	return /\b(?:tests?|specs?|testing|e2e|unit test|mocks?)\b/i.test(query);
}

function chunkText(store: IndexStore, id: number): string {
	const row = store.statement('SELECT body FROM chunks WHERE id = ?').get(id) as { body: Uint8Array } | undefined;
	return row ? unpackText(row.body) : '';
}

function runMatch(store: IndexStore, expression: string, lang: string | undefined, limit: number): ChunkRow[] {
	const sql = `SELECT c.id AS id, c.path AS path, c.start_line AS startLine, c.end_line AS endLine, c.symbol AS symbol
		FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
		WHERE chunks_fts MATCH ?${lang ? ' AND c.path IN (SELECT path FROM files WHERE lang = ?)' : ''}
		ORDER BY bm25(chunks_fts, 1.0, 3.0, 2.0, 6.0) LIMIT ?`;
	try {
		return store.statement(sql).all(...lang ? [expression, lang.toLowerCase(), limit] : [expression, limit]) as unknown as ChunkRow[];
	} catch {
		// A query FTS5 can't parse finds nothing rather than failing the tool.
		return [];
	}
}

export function findSymbol(store: IndexStore, name: string, options: { readonly kind?: string; readonly references?: boolean } = {}): SymbolResult {
	const dot = name.lastIndexOf('.');
	const container = dot > 0 ? name.slice(0, dot) : undefined;
	const base = dot > 0 ? name.slice(dot + 1) : name;
	const kind = options.kind ? ' AND kind = ?' : '';
	const args = (first: string) => [first, ...container ? [container] : [], ...options.kind ? [options.kind] : []];
	const select = 'SELECT name, kind, path, line, end_line AS endLine, container, exported FROM symbols';
	const order = 'ORDER BY exported DESC, length(path), path, line LIMIT 20';
	const containerClause = container ? ' AND container = ? COLLATE NOCASE' : '';
	const rows = store.statement(`${select} WHERE name = ? COLLATE NOCASE${containerClause}${kind} ${order}`).all(...args(base)) as unknown as RawSymbol[];
	// The first definition is shown in full, so the model needn't open the file for it.
	const definitions = rows.map((row, index) => withSignature(store, row, index === 0));
	const similar = definitions.length ? [] : (store.statement(`${select} WHERE name LIKE ? ESCAPE '\\'${kind} ${order}`).all(`%${base.replace(/[%_\\]/g, '\\$&')}%`, ...options.kind ? [options.kind] : []) as unknown as RawSymbol[]).slice(0, 10).map(row => withSignature(store, row));
	if (!options.references || !/^\w+$/.test(base)) {
		return { definitions, similar, references: [], referenceTotal: 0 };
	}
	const definedAt = new Set(definitions.map(d => `${d.path}:${d.line}`));
	const pattern = new RegExp(`\\b${base}\\b`);
	const references: { path: string; line: number; text: string }[] = [];
	let referenceTotal = 0;
	const chunks = (store.statement('SELECT c.path AS path, c.start_line AS startLine, c.body AS body FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY c.path, c.start_line LIMIT 500')
		.all(`text:"${base.toLowerCase()}"`) as { path: string; startLine: number; body: Uint8Array }[]).map(row => ({ path: row.path, startLine: row.startLine, text: unpackText(row.body) }));
	const seenLines = new Set<string>();
	for (const chunk of chunks) {
		chunk.text.split('\n').forEach((text, offset) => {
			const line = chunk.startLine + offset;
			const key = `${chunk.path}:${line}`;
			if (!pattern.test(text) || definedAt.has(key) || seenLines.has(key)) {
				return;
			}
			seenLines.add(key);
			referenceTotal++;
			if (references.length < maxReferences) {
				references.push({ path: chunk.path, line, text: text.trim().slice(0, 200) });
			}
		});
	}
	return { definitions, similar, references, referenceTotal };
}

interface RawSymbol {
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly line: number;
	readonly endLine: number;
	readonly container: string | null;
	readonly exported: number;
}

function withSignature(store: IndexStore, row: RawSymbol, withBody = false): SymbolHit {
	const chunk = store.statement('SELECT start_line AS startLine, body FROM chunks WHERE path = ? AND start_line <= ? AND end_line >= ? LIMIT 1').get(row.path, row.line, row.line) as { startLine: number; body: Uint8Array } | undefined;
	const lines = chunk ? unpackText(chunk.body).split('\n') : [];
	const signature = (lines[row.line - (chunk?.startLine ?? 0)] ?? '').trim();
	// What the chunk holds of the definition after its signature; a definition longer than its chunk ends where the chunk does.
	const rest = chunk && withBody && row.endLine > row.line ? lines.slice(row.line - chunk.startLine + 1, Math.min(row.endLine, row.line + bodyLines) - chunk.startLine + 1) : [];
	return { name: row.name, kind: row.kind, path: row.path, line: row.line, endLine: row.endLine, container: row.container ?? undefined, exported: !!row.exported, signature, ...(rest.length ? { body: rest.join('\n') } : {}) };
}

export function relatedFiles(store: IndexStore, relative: string): RelatedResult {
	const column = (sql: string, ...args: (string | number)[]) => (store.statement(sql).all(...args) as Record<string, string>[]).map(row => Object.values(row)[0]);
	const imports = column('SELECT DISTINCT target FROM imports WHERE path = ? AND target IS NOT NULL ORDER BY target LIMIT 30', relative);
	const importedBy = column('SELECT DISTINCT path FROM imports WHERE target = ? ORDER BY path LIMIT 30', relative);
	const base = relative.slice(relative.lastIndexOf('/') + 1);
	const stem = base.replace(/\.(?:test|spec)$/, '').replace(/\.[^.]+$/, '').replace(/\.(?:test|spec)$/, '');
	const tests = stem.length > 1 ? column(`SELECT path FROM files WHERE path != ? AND skipped IS NULL AND path LIKE ? ESCAPE '\\' AND (path LIKE '%test%' OR path LIKE '%spec%') ORDER BY length(path) LIMIT 10`, relative, `%${stem.replace(/[%_\\]/g, '\\$&')}%`) : [];
	const changedWith = store.statement('SELECT b AS path, count FROM cochange WHERE a = ? UNION ALL SELECT a AS path, count FROM cochange WHERE b = ? ORDER BY count DESC LIMIT 10').all(relative, relative) as { path: string; count: number }[];
	return { imports, importedBy, tests, changedWith };
}

/** Whether the index knows `relative`, so a tool can say when a path is wrong. */
export function hasFile(store: IndexStore, relative: string): boolean {
	return !!store.statement('SELECT 1 FROM files WHERE path = ?').get(relative);
}

/** Files whose path ends with `relative`'s name, to suggest when a path is wrong. */
export function filesNamed(store: IndexStore, relative: string): string[] {
	const base = relative.slice(relative.lastIndexOf('/') + 1);
	return (store.statement('SELECT path FROM files WHERE path = ? OR path LIKE ? ESCAPE \'\\\' ORDER BY length(path) LIMIT 5').all(base, `%/${base.replace(/[%_\\]/g, '\\$&')}`) as { path: string }[]).map(row => row.path);
}

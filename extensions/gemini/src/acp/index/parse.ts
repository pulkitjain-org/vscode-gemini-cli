/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Turns one file's text into what the index stores: its definitions, the
// chunks search returns (cut at definitions, so a result is one function or
// class rather than an arbitrary window), and its import specifiers.
//
// Definitions are found line by line (languages.ts). A container, such as a
// class, holds the lines indented deeper than it; its members are the
// definitions at its shallowest inner indentation, so calls inside a
// method's body, which sit deeper, are never taken for methods. Outside a
// container only definitions at the start of a line count.

import { Language, languageName, languageOf, notNames, SymbolKind } from './languages';

export interface ParsedSymbol {
	readonly name: string;
	readonly kind: SymbolKind;
	/** 1-based. */
	readonly line: number;
	readonly endLine: number;
	/** The class, trait or receiver it belongs to. */
	readonly container?: string;
	readonly exported: boolean;
}

export interface Chunk {
	/** 1-based, inclusive. */
	readonly startLine: number;
	readonly endLine: number;
	/** The definition the chunk is, or is inside of, as `Container.name`. */
	readonly symbol?: string;
	readonly text: string;
}

export interface ParsedFile {
	/** A language name for filters, such as `typescript` or `yaml`. */
	readonly lang: string;
	readonly symbols: readonly ParsedSymbol[];
	readonly chunks: readonly Chunk[];
	/** Import specifiers as written, resolved later (resolve.ts). */
	readonly imports: readonly string[];
}

/** A chunk longer than this is cut into windows. */
const maxChunkLines = 80;
const windowLines = 60;
const windowOverlap = 5;
/** Neighbouring chunks this short are joined, up to `joinLines` together. */
const shortChunkLines = 8;
const joinLines = 40;
/** Long lines (data, generated code) are cut in what is stored and returned. */
const maxLineChars = 400;
const maxChunkChars = 6_000;

export function parseFile(relative: string, text: string): ParsedFile {
	const lines = text.split(/\r?\n/);
	const language = languageOf(relative);
	const symbols = language ? findSymbols(lines, language) : [];
	return {
		lang: languageName(relative),
		symbols,
		chunks: makeChunks(lines, symbols, language),
		// A package import (`react`, `node:fs`) never names a file in the folder; only relative ones are kept.
		imports: language?.imports ? findImports(text, language.imports).filter(spec => language.id !== 'typescript' || spec.startsWith('.')) : [],
	};
}

interface Open {
	readonly indent: number;
	readonly name: string;
	/** Where its symbol is in the list, unless it is hidden. */
	readonly index: number | undefined;
	memberIndent: number | undefined;
}

interface Found {
	name: string;
	kind: SymbolKind;
	line: number;
	endLine: number | undefined;
	container: string | undefined;
	exported: boolean;
}

export function findSymbols(lines: readonly string[], language: Language): ParsedSymbol[] {
	const found: Found[] = [];
	const open: Open[] = [];
	let fence = false;
	const close = (container: Open, lineIndex: number) => {
		if (container.index !== undefined) {
			found[container.index].endLine = lineIndex;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (language.markdown && /^\s*(?:```|~~~)/.test(line)) {
			fence = !fence;
			continue;
		}
		const trimmed = line.trim();
		if (!trimmed || fence || trimmed === '{') {
			continue;
		}
		const indent = line.length - line.trimStart().length;
		while (open.length && indent <= open[open.length - 1].indent) {
			// A closing line (`}`, `end`) belongs to the block it closes.
			close(open.pop()!, /^(?:[}\])]|end\b)/.test(trimmed) ? i + 1 : i);
		}
		const top = open[open.length - 1];
		if (top) {
			top.memberIndent = Math.min(top.memberIndent ?? indent, indent);
		}
		for (const definition of language.definitions) {
			const match = definition.pattern.exec(line);
			const groups = match?.groups;
			const name = groups?.name;
			if (!groups || !name || notNames.has(name) || (definition.member && !top)) {
				continue;
			}
			if (top ? indent !== top.memberIndent : indent !== 0) {
				break;
			}
			const receiver = groups.recv ? /(\w+)(?:\[[^\]]*\])?\s*$/.exec(groups.recv)?.[1] : undefined;
			const container = receiver ?? top?.name;
			const kind = definition.kind === 'function' && top ? 'method' : definition.kind;
			const index = definition.hidden ? undefined : found.push({
				name,
				kind,
				line: i + 1,
				endLine: undefined,
				container,
				exported: language.exported ? language.exported(groups, name) : !top,
			}) - 1;
			if (definition.container) {
				open.push({ indent, name, index, memberIndent: undefined });
			}
			break;
		}
	}
	while (open.length) {
		close(open.pop()!, lines.length);
	}
	return withEnds(found, lines, language);
}

/**
 * Ends a definition that holds nothing where the next one starts (only
 * containers hold others), and a member before its container's closing line,
 * without trailing blank lines.
 */
function withEnds(found: readonly Found[], lines: readonly string[], language: Language): ParsedSymbol[] {
	// The last container seen with each name: one pass, so a class with thousands of members stays linear.
	const containers = new Map<string, Found>();
	return found.map((symbol, index) => {
		let end = symbol.endLine;
		if (end === undefined) {
			const next = found[index + 1];
			end = next ? leadingStart(lines, next.line - 1, language) : lines.length;
			const parent = symbol.container ? containers.get(symbol.container) : undefined;
			if (parent?.endLine !== undefined && parent.endLine >= symbol.line) {
				const closing = /^(?:[}\])]|end\b)/.test(lines[parent.endLine - 1]?.trim() ?? '');
				end = Math.min(end, closing ? parent.endLine - 1 : parent.endLine);
			}
		} else {
			containers.set(symbol.name, symbol);
		}
		while (end > symbol.line && !lines[end - 1]?.trim()) {
			end--;
		}
		return { name: symbol.name, kind: symbol.kind, line: symbol.line, endLine: Math.max(end, symbol.line), container: symbol.container, exported: symbol.exported };
	});
}

/** The symbol's name as search and results show it. */
export function qualifiedName(symbol: Pick<ParsedSymbol, 'name' | 'container'>): string {
	return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

export function makeChunks(lines: readonly string[], symbols: readonly ParsedSymbol[], language: Language | undefined): Chunk[] {
	// Each top-level definition starts a chunk; so does each member of a container too long for one.
	const big = new Set(symbols.filter(s => s.endLine - s.line + 1 > maxChunkLines).map(s => s.name));
	const starts = new Set<number>();
	for (const symbol of symbols) {
		if (!symbol.container || big.has(symbol.container)) {
			starts.add(leadingStart(lines, symbol.line - 1, language));
		}
	}
	const boundaries = [...starts].sort((a, b) => a - b);
	const regions: [number, number][] = [];
	let from = 0;
	for (const start of boundaries) {
		if (start > from) {
			regions.push([from, start - 1]);
		}
		from = start;
	}
	regions.push([from, lines.length - 1]);

	const pieces: [number, number][] = [];
	for (let [start, end] of regions) {
		while (start <= end && !lines[start].trim()) {
			start++;
		}
		while (end >= start && !lines[end].trim()) {
			end--;
		}
		if (start > end) {
			continue;
		}
		if (end - start + 1 <= maxChunkLines) {
			pieces.push([start, end]);
			continue;
		}
		for (let at = start; at <= end; at += windowLines - windowOverlap) {
			pieces.push([at, Math.min(end, at + windowLines - 1)]);
			if (at + windowLines - 1 >= end) {
				break;
			}
		}
	}

	const joined: [number, number][] = [];
	for (const piece of pieces) {
		const last = joined[joined.length - 1];
		const lastLength = last ? last[1] - last[0] + 1 : 0;
		if (last && lastLength < joinLines && piece[1] - piece[0] + 1 <= shortChunkLines && piece[1] - last[0] + 1 <= joinLines && last[1] < piece[0]) {
			last[1] = piece[1];
		} else {
			joined.push([piece[0], piece[1]]);
		}
	}

	const symbolAt = chunkSymbols(symbols);
	return joined.map(([start, end]) => ({
		startLine: start + 1,
		endLine: end + 1,
		symbol: symbolAt(start + 1, end + 1),
		text: chunkText(lines, start, end),
	}));
}

/** The first line of a definition's comments and decorators, so they travel with it. */
function leadingStart(lines: readonly string[], index: number, language: Language | undefined): number {
	if (!language?.leading) {
		return index;
	}
	let start = index;
	while (start > 0 && language.leading.test(lines[start - 1])) {
		start--;
	}
	return start;
}

/**
 * The name for each chunk, asked for in order of their first lines: the
 * definition that starts in the chunk's first lines, else the innermost one
 * around its start. `symbols` are in line order; a stack of the definitions
 * still open keeps this linear however many members a class has.
 */
function chunkSymbols(symbols: readonly ParsedSymbol[]): (start: number, end: number) => string | undefined {
	let next = 0;
	let lastStart = 0;
	const open: ParsedSymbol[] = [];
	return (start, end) => {
		if (start < lastStart) {
			next = 0;
			open.length = 0;
		}
		lastStart = start;
		const starting = symbols[firstAtOrAfter(symbols, start)];
		if (starting && starting.line <= Math.min(end, start + 12)) {
			return qualifiedName(starting);
		}
		while (next < symbols.length && symbols[next].line <= start) {
			open.push(symbols[next++]);
		}
		// A definition that ended before this chunk ends before every later one too.
		while (open.length && open[open.length - 1].endLine < start) {
			open.pop();
		}
		const around = open[open.length - 1];
		return around ? qualifiedName(around) : undefined;
	};
}

/** The index of the first symbol at or after `line`. */
function firstAtOrAfter(symbols: readonly ParsedSymbol[], line: number): number {
	let low = 0;
	let high = symbols.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (symbols[middle].line < line) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function chunkText(lines: readonly string[], start: number, end: number): string {
	let text = '';
	for (let i = start; i <= end && text.length < maxChunkChars; i++) {
		const line = lines[i].length > maxLineChars ? `${lines[i].slice(0, maxLineChars)}…` : lines[i];
		text += i === start ? line : `\n${line}`;
	}
	return text.length > maxChunkChars ? `${text.slice(0, maxChunkChars)}…` : text;
}

function findImports(text: string, patterns: readonly RegExp[]): string[] {
	const specs = new Set<string>();
	for (const pattern of patterns) {
		const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
		for (const match of text.matchAll(global)) {
			const spec = match.groups?.spec;
			if (spec && spec.length < 300) {
				specs.add(spec);
			}
		}
	}
	return [...specs];
}

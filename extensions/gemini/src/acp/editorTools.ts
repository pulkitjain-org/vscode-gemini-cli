/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor's language servers behind the index tools (indexMcp.ts): exact
// references for find_symbol, and code_type, code_diagnostics and code_calls.
// The Gemini CLI alone has no language servers; GeminiCode is an editor and
// has them running. Agents name a symbol, not a cursor: the index knows where
// each definition is, and the host finds the name on that line. Where no
// language server answers (a language with none, a worktree outside the
// workspace, a server still loading), the index answers instead and says so.
// Pure: the host's adapter (src/host/editorToolsHost.ts) talks to VS Code.

import * as path from 'node:path';
import type { McpTool } from './browserMcp';
import type { SymbolHit } from './index/query';

/** A symbol in a file: the 1-based line its name is on, and the name to find on it. */
export interface CodeTarget {
	/** The agent's folder: nothing outside it is read. */
	readonly folder: string;
	/** Absolute. */
	readonly file: string;
	readonly line: number;
	readonly name: string;
}

/** A place in a file, with its line's text when the backend read it. */
export interface CodeLocation {
	/** Absolute. */
	readonly file: string;
	readonly line: number;
	readonly text?: string;
}

export interface CodeDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly source?: string;
}

export interface CodeCall {
	readonly name: string;
	readonly file: string;
	readonly line: number;
}

/**
 * What the host's language servers answer. Each read resolves undefined
 * when no language server answered in time, so the index can answer instead;
 * an empty list is an answer.
 */
export interface EditorBackend {
	references(target: CodeTarget): Promise<readonly CodeLocation[] | undefined>;
	hover(target: CodeTarget): Promise<string | undefined>;
	calls(target: CodeTarget, direction: 'incoming' | 'outgoing'): Promise<readonly CodeCall[] | undefined>;
	/** Errors and warnings in `files` (absolute), or in the folder's changed files when none are given, with how many files were checked. */
	diagnostics(folder: string, files: readonly string[] | undefined): Promise<{ readonly checked: number; readonly diagnostics: readonly CodeDiagnostic[] }>;
}

/** The tools the language servers add, listed when they are on. */
export const editorTools: readonly McpTool[] = [
	{
		name: 'code_type',
		description: 'The type and documentation of a function, variable, property or class, as the editor\'s language server knows it (what hovering shows). Give the symbol, and the file and line when there is more than one.',
		inputSchema: {
			type: 'object',
			properties: {
				symbol: { type: 'string', description: 'The name, such as calculateTotal or CartItem.price.' },
				path: { type: 'string', description: 'The file it is in or used in, relative to this folder.' },
				line: { type: 'number', description: 'The line it is on, with path.' },
			},
			required: ['symbol'],
		},
	},
	{
		name: 'code_diagnostics',
		description: 'Errors and warnings the editor\'s language servers report, in seconds and without running a build: use it after editing to check types and imports. Without paths, checks every file with uncommitted changes.',
		inputSchema: {
			type: 'object',
			properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Files to check, relative to this folder (at most 50).' } },
		},
	},
	{
		name: 'code_calls',
		description: 'What calls a function or method (incoming), or what it calls (outgoing), one level, as the editor\'s language server resolves them.',
		inputSchema: {
			type: 'object',
			properties: {
				symbol: { type: 'string', description: 'The function or method, such as checkout or CartService.checkout.' },
				direction: { type: 'string', enum: ['incoming', 'outgoing'], description: 'incoming: its callers (default). outgoing: what it calls.' },
				path: { type: 'string', description: 'The file it is defined in, relative to this folder, when the name is not unique.' },
				line: { type: 'number', description: 'Its line, with path.' },
			},
			required: ['symbol'],
		},
	},
];

/** The line the instructions add for the language-server tools. */
export const editorToolsInstruction = '- code_type, code_diagnostics, code_calls: the editor\'s language servers: a symbol\'s type, errors after an edit without a build, and its callers. find_symbol\'s references come from them too where they cover the file.';

/** The most references, calls or diagnostics a result lists. */
const maxListed = 50;
const maxFiles = 50;

/** The last part of a dotted name: `checkout` in `CartService.checkout`. */
export function baseName(symbol: string): string {
	return symbol.split('.').filter(Boolean).at(-1) ?? symbol;
}

/**
 * Where a tool's symbol is: the line given, else its one definition in the
 * index; otherwise what to say instead, such as the definitions to choose between.
 */
export function resolveTarget(folder: string, symbol: string, definitions: readonly SymbolHit[], file?: string, line?: number): CodeTarget | string {
	const name = baseName(symbol);
	if (file && line) {
		const resolved = path.resolve(folder, file);
		return relative(folder, resolved).startsWith('..') ? `${file} is outside this folder.` : { folder, file: resolved, line, name };
	}
	const container = symbol.includes('.') ? symbol.split('.').slice(0, -1).join('.') : undefined;
	const matching = definitions.filter(d => d.name === name && (!container || d.container === container) && (!file || d.path === file.split(path.sep).join('/')));
	const chosen = matching.length ? matching : definitions.filter(d => d.name === name);
	if (chosen.length === 1) {
		return { folder, file: path.resolve(folder, chosen[0].path), line: chosen[0].line, name };
	}
	if (!chosen.length) {
		return `No definition named ${symbol} was found. Give path and line where it is used, or look it up with code_search.`;
	}
	return [`${symbol} has ${chosen.length} definitions; call again with path and line:`, ...chosen.slice(0, 10).map(d => `  ${d.kind} ${d.container ? `${d.container}.` : ''}${d.name} · ${d.path}:${d.line}`)].join('\n');
}

function relative(folder: string, file: string): string {
	return path.relative(folder, file).split(path.sep).join('/');
}

/** Exact references from a language server, in find_symbol's own words, replacing the index's lines that only share the name. */
export function formatExactReferences(folder: string, locations: readonly CodeLocation[]): string {
	const inside = locations.filter(l => !relative(folder, l.file).startsWith('..'));
	const shown = inside.slice(0, maxListed);
	return [
		`References from the language server (exact: the same symbol, through imports and aliases${inside.length > shown.length ? `; showing ${shown.length} of ${inside.length}` : `; ${inside.length}`}):`,
		...shown.map(l => `  ${relative(folder, l.file)}:${l.line}${l.text ? `  ${l.text.trim()}` : ''}`),
	].join('\n');
}

export function formatHover(target: CodeTarget, folder: string, text: string | undefined): string {
	return text?.trim()
		? `${target.name} at ${relative(folder, target.file)}:${target.line}, from the language server:\n${text.trim()}`
		: `The language server has nothing to say about ${target.name} at ${relative(folder, target.file)}:${target.line}. Check the line, or read the definition with find_symbol.`;
}

export function formatDiagnostics(folder: string, files: number, diagnostics: readonly CodeDiagnostic[]): string {
	if (!files) {
		return 'No files to check: give paths, or there are no uncommitted changes.';
	}
	const errors = diagnostics.filter(d => d.severity === 'error').length;
	if (!diagnostics.length) {
		return `No errors or warnings in ${files} ${files === 1 ? 'file' : 'files'}, from the language servers.`;
	}
	const shown = [...diagnostics].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)).slice(0, maxListed);
	return [
		`${errors} ${errors === 1 ? 'error' : 'errors'} and ${diagnostics.length - errors} ${diagnostics.length - errors === 1 ? 'warning' : 'warnings'} in ${files} ${files === 1 ? 'file' : 'files'}${diagnostics.length > shown.length ? ` (showing ${shown.length})` : ''}:`,
		...shown.map(d => `  ${d.severity} ${relative(folder, d.file)}:${d.line}  ${d.message.replace(/\s+/g, ' ').trim()}${d.source ? ` (${d.source})` : ''}`),
	].join('\n');
}

export function formatCalls(target: CodeTarget, folder: string, direction: 'incoming' | 'outgoing', calls: readonly CodeCall[]): string {
	const where = `${target.name} (${relative(folder, target.file)}:${target.line})`;
	if (!calls.length) {
		return direction === 'incoming' ? `Nothing calls ${where}, as far as the language server knows.` : `${where} calls nothing the language server resolves.`;
	}
	const shown = calls.slice(0, maxListed);
	return [
		direction === 'incoming' ? `Callers of ${where}${calls.length > shown.length ? `, ${shown.length} of ${calls.length}` : ''}:` : `${where} calls${calls.length > shown.length ? `, ${shown.length} of ${calls.length}` : ''}:`,
		...shown.map(call => `  ${call.name} · ${relative(folder, call.file)}:${call.line}`),
	].join('\n');
}

/**
 * The notice after a turn that left errors in changed files, listing a few;
 * undefined when there are none. Warnings are left out: a turn's end is no
 * place to nag about them.
 */
export function errorsNotice(folder: string, diagnostics: readonly CodeDiagnostic[]): string | undefined {
	const errors = diagnostics.filter(d => d.severity === 'error');
	if (!errors.length) {
		return undefined;
	}
	const shown = errors.slice(0, 5);
	return [
		errors.length === 1 ? 'The language server reports 1 error in the changed files:' : `The language servers report ${errors.length} errors in the changed files${errors.length > shown.length ? `, the first ${shown.length} here` : ''}:`,
		...shown.map(d => `- ${relative(folder, d.file)}:${d.line}  ${d.message.replace(/\s+/g, ' ').trim()}`),
	].join('\n');
}

/** The note when no language server answered, so the agent knows the index answered alone. */
export const noLanguageServer = 'No language server answered for this file (none for its language, or still loading), so this comes from the index alone.';

/** The files a diagnostics call names, inside `folder`, at most {@link maxFiles}. */
export function diagnosticFiles(folder: string, paths: unknown): string[] | undefined {
	if (!Array.isArray(paths)) {
		return undefined;
	}
	return paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).map(p => path.resolve(folder, p.trim())).filter(file => !relative(folder, file).startsWith('..')).slice(0, maxFiles);
}

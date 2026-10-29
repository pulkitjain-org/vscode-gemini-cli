/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the @ picker offers besides files (chatAttachments.ts): the folders
// the matching files are in, and the Workspace rows' contents (the Problems
// list, the uncommitted diff) as the attachments they send. Also the code
// "Fix with Gemini" attaches with a problem (quickFix.ts).

import * as path from 'node:path';
import { type IndexedPath, indexPath, rankPaths } from './fuzzy';
import type { Attachment } from './attachments';

/**
 * The folders of `files` (and the folders above them) that best match
 * `query`, as `@src/auth` attaches a whole folder: the CLI reads a folder it
 * is given as all of its files (`folder/**`).
 */
export function foldersOf(files: readonly { readonly path: string; readonly relative: string }[], query: string, limit: number): { readonly path: string; readonly relative: string }[] {
	const folders = new Map<string, IndexedPath & { readonly path: string }>();
	for (const file of files) {
		let relative = file.relative.replace(/\\/g, '/');
		let absolute = file.path;
		for (; ;) {
			relative = path.posix.dirname(relative);
			absolute = path.dirname(absolute);
			if (relative === '.' || relative === '/' || !relative || folders.has(relative)) {
				break;
			}
			folders.set(relative, { ...indexPath(relative), path: absolute });
		}
	}
	return rankPaths(query, [...folders.values()], limit).map(folder => ({ path: folder.path, relative: folder.relative }));
}

/** A problem from the Problems list, as `vscode.Diagnostic` has it, with its file. */
export interface Problem {
	/** Absolute. */
	readonly file: string;
	readonly severity: 'error' | 'warning' | 'info' | 'hint';
	/** 1-based. */
	readonly line: number;
	readonly column: number;
	readonly message: string;
	readonly source?: string;
	readonly code?: string;
}

/** How many errors and warnings `problems` hold. */
export function countProblems(problems: readonly Problem[]): { readonly errors: number; readonly warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const problem of problems) {
		if (problem.severity === 'error') {
			errors++;
		} else if (problem.severity === 'warning') {
			warnings++;
		}
	}
	return { errors, warnings };
}

/** The Problems list sent with a prompt: one line per problem, errors first, relative to `cwd`, at most `max` of them. */
export function problemsReport(problems: readonly Problem[], cwd: string, max = 200): string {
	const rank = { error: 0, warning: 1, info: 2, hint: 3 };
	const sorted = [...problems].sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
	const lines = sorted.slice(0, max).map(problem => problemLine(problem, cwd));
	return sorted.length > max ? [...lines, `# ${sorted.length - max} more problems left out`].join('\n') : lines.join('\n');
}

/** "src/a.ts:3:5 error: Cannot find name 'Requst'. (ts 2304)" */
export function problemLine(problem: Problem, cwd: string): string {
	const relative = path.relative(cwd, problem.file);
	const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : problem.file;
	const origin = [problem.source, problem.code].filter(Boolean).join(' ');
	return `${shown}:${problem.line}:${problem.column} ${problem.severity}: ${problem.message.replace(/\s*\n\s*/g, ' ')}${origin ? ` (${origin})` : ''}`;
}

/** The lines around a problem that "Fix with Gemini" attaches: `around` lines either side of lines `start` to `end` (1-based), as a selection of the file. */
export function codeAround(file: string, text: string, start: number, end: number, around = 10, languageId?: string): Extract<Attachment, { readonly kind: 'selection' }> {
	const lines = text.split(/\r?\n/);
	const first = Math.max(1, start - around);
	const last = Math.min(lines.length, Math.max(end, start) + around);
	return { kind: 'selection', path: file, text: lines.slice(first - 1, last).join('\n'), startLine: first, endLine: last, ...languageId ? { languageId } : {} };
}

/** A definition's lines, as the @ picker's Symbols attach it: from `line` to `endLine` (1-based), at most `max` lines. */
export function symbolLines(file: string, text: string, line: number, endLine: number, max = 400): Extract<Attachment, { readonly kind: 'selection' }> {
	const lines = text.split(/\r?\n/);
	const first = Math.min(Math.max(1, line), lines.length);
	const last = Math.min(lines.length, Math.max(first, endLine), first + max - 1);
	return { kind: 'selection', path: file, text: lines.slice(first - 1, last).join('\n'), startLine: first, endLine: last };
}

/** How many files `git status --porcelain` lists. */
export function changedFileCount(porcelain: string): number {
	return porcelain.split('\n').filter(line => line.trim()).length;
}

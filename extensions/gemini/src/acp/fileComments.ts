/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Comments the user left on a Markdown file an agent wrote, in the rich
// Markdown editor, as the one message that asks the agent to revise the file.
// The workbench keeps the comments (geminiMarkdownComments.ts) and hands them
// over with their ranges; this module turns them into the message. Pure.

/** A range as the workbench sends it: 1-based lines and columns, end exclusive. */
export interface CommentRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface FileComment {
	readonly range: CommentRange;
	readonly body: string;
}

export interface FileCommentWords {
	/** `{0}` is the file's name. */
	readonly intro: string;
	readonly comments: string;
	/** `{0}` is the text commented on, `{1}` its line. */
	readonly onText: string;
	/** `{0}` is the line, for a comment on no text. */
	readonly onLine: string;
}

/** The longest quote of the commented text the message carries. */
const maxQuote = 80;

/** The comments from the workbench, without anything malformed or empty. */
export function validComments(value: unknown): FileComment[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((comment): comment is FileComment => {
		const range = (comment as FileComment | undefined)?.range;
		return typeof comment?.body === 'string' && !!comment.body.trim() && !!range
			&& [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn].every(n => Number.isInteger(n) && n >= 1);
	}).slice(0, 200);
}

/** The text `range` covers in `text`, on one line, cut to {@link maxQuote} characters. */
export function quoteOf(text: string, range: CommentRange): string {
	const lines = text.split(/\r?\n/);
	const start = Math.min(range.startLineNumber, lines.length) - 1;
	const end = Math.min(range.endLineNumber, lines.length) - 1;
	const covered = start === end
		? (lines[start] ?? '').slice(range.startColumn - 1, range.endColumn - 1)
		: [(lines[start] ?? '').slice(range.startColumn - 1), ...lines.slice(start + 1, end), (lines[end] ?? '').slice(0, range.endColumn - 1)].join(' ');
	const quote = covered.replace(/\s+/g, ' ').trim();
	return quote.length > maxQuote ? `${quote.slice(0, maxQuote - 1).trimEnd()}…` : quote;
}

/** The message asking the agent to revise `file` (its name) by `comments`, quoting from `text`, the file now; undefined without comments. */
export function fileCommentsMessage(file: string, text: string, comments: readonly FileComment[], words: FileCommentWords): string | undefined {
	if (!comments.length) {
		return undefined;
	}
	const sorted = [...comments].sort((a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn);
	const lines = [format(words.intro, file), '', words.comments];
	sorted.forEach((comment, i) => {
		const quote = quoteOf(text, comment.range);
		const line = String(comment.range.startLineNumber);
		const where = quote ? format(words.onText, quote, line) : format(words.onLine, line);
		lines.push(`${i + 1}. ${where}: ${comment.body.trim()}`);
	});
	return lines.join('\n');
}

function format(template: string, ...values: string[]): string {
	return template.replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] ?? match);
}

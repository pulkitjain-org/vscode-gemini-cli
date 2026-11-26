/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Markdown help in the composer: bold and code shortcuts, and lists that
// continue on Shift+Enter. Pure functions over the input's text and selection,
// so the composer applies each as one edit the user can undo.

/** Replace `start`..`end` of the text with `text`, then select `selectionStart`..`selectionEnd`. */
export interface TextEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

/**
 * Wraps the selection in `marker` (`**` for bold, `` ` `` for code), or
 * unwraps it when the marker already surrounds it. With nothing selected it
 * puts the cursor between a pair of markers.
 */
export function toggleWrap(value: string, start: number, end: number, marker: string): TextEdit {
	const m = marker.length;
	if (start >= m && value.slice(start - m, start) === marker && value.slice(end, end + m) === marker) {
		const inner = value.slice(start, end);
		return { start: start - m, end: end + m, text: inner, selectionStart: start - m, selectionEnd: end - m };
	}
	const selected = value.slice(start, end);
	if (selected.length > 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
		const inner = selected.slice(m, -m);
		return { start, end, text: inner, selectionStart: start, selectionEnd: start + inner.length };
	}
	return { start, end, text: marker + selected + marker, selectionStart: start + m, selectionEnd: end + m };
}

const listItem = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;

/**
 * Shift+Enter on a list line: starts the next item (numbered lists count
 * up, task lists get an empty box), or ends the list when the line is an
 * empty item. Undefined when the line is not a list item, or is in a code
 * block, so Shift+Enter adds a plain new line.
 */
export function continueList(value: string, caret: number): TextEdit | undefined {
	const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
	if (inCodeBlock(value.slice(0, lineStart))) {
		return undefined;
	}
	const before = value.slice(lineStart, caret);
	const match = listItem.exec(before);
	if (!match) {
		return undefined;
	}
	const [prefix, indent, bullet, number, delimiter, space, box] = match;
	const lineEnd = value.indexOf('\n', caret);
	const rest = value.slice(caret, lineEnd < 0 ? value.length : lineEnd);
	if (before.length === prefix.length && !rest.trim()) {
		// An empty item ends the list.
		return { start: lineStart, end: caret, text: '', selectionStart: lineStart, selectionEnd: lineStart };
	}
	const next = number ? `${Number(number) + 1}${delimiter}` : bullet;
	const text = `\n${indent}${next}${space}${box ? '[ ] ' : ''}`;
	return { start: caret, end: caret, text, selectionStart: caret + text.length, selectionEnd: caret + text.length };
}

/** Whether text ending at a line start leaves a ``` or ~~~ code block open. */
function inCodeBlock(text: string): boolean {
	return (text.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1;
}

/** The marker a formatting shortcut wraps the selection in: ⌘B bold, ⌘E code (Ctrl on Windows and Linux). */
export function formatShortcut(event: { readonly code: string; readonly altKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean }, mac: boolean): string | undefined {
	if (event.altKey || event.shiftKey || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) {
		return undefined;
	}
	return event.code === 'KeyB' ? '**' : event.code === 'KeyE' ? '`' : undefined;
}

/** What a toolbar button puts at the start of each selected line. */
export type LinePrefix = 'bullet' | 'number' | 'task' | 'quote';

const prefixPatterns: Readonly<Record<LinePrefix, RegExp>> = {
	bullet: /^[-*+]\s+(?!\[[ xX]\])/,
	number: /^\d{1,9}[.)]\s+/,
	task: /^[-*+]\s+\[[ xX]\]\s+/,
	quote: /^>\s?/,
};

/**
 * Makes the lines the selection touches a list, a task list or a quote, or
 * takes that off when every line already has it. Numbered lines count from 1.
 */
export function toggleLinePrefix(value: string, start: number, end: number, kind: LinePrefix): TextEdit {
	const from = value.lastIndexOf('\n', start - 1) + 1;
	const next = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
	const to = next < 0 ? value.length : next;
	const lines = value.slice(from, to).split('\n');
	const pattern = prefixPatterns[kind];
	const all = lines.every(line => pattern.test(line) || !line.trim());
	const text = lines.map((line, i) => {
		if (all) {
			return line.replace(pattern, '');
		}
		// A line with another list's or a quote's marker swaps it for this one.
		const bare = line.replace(prefixPatterns.task, '').replace(prefixPatterns.bullet, '').replace(prefixPatterns.number, '').replace(prefixPatterns.quote, '');
		const prefix = kind === 'bullet' ? '- ' : kind === 'number' ? `${i + 1}. ` : kind === 'task' ? '- [ ] ' : '> ';
		return lines.length > 1 && !line.trim() ? line : prefix + bare;
	}).join('\n');
	// A caret goes to the end of its line; a selection keeps the lines selected.
	return { start: from, end: to, text, selectionStart: start === end ? from + text.length : from, selectionEnd: from + text.length };
}

/** `[selection](url)`, with "url" selected to type over; with nothing selected, "text" is selected first. */
export function insertLink(value: string, start: number, end: number): TextEdit {
	const label = value.slice(start, end) || 'text';
	const text = `[${label}](url)`;
	const at = start === end ? start + 1 : start + label.length + 3;
	return { start, end, text, selectionStart: at, selectionEnd: at + (start === end ? label.length : 3) };
}

/** A block a toolbar button adds, on lines of its own. */
export type MarkdownBlock = 'code' | 'callout' | 'table' | 'rule';

/**
 * Puts block `kind` on lines of its own at the selection: a code block or a
 * callout around the selected text, an empty table, or a rule. The cursor
 * lands where the text goes.
 */
export function insertBlock(value: string, start: number, end: number, kind: MarkdownBlock): TextEdit {
	const selected = value.slice(start, end);
	const before = start > 0 && value[start - 1] !== '\n' ? '\n\n' : start > 1 && value[start - 2] !== '\n' ? '\n' : '';
	const after = end < value.length && value[end] !== '\n' ? '\n\n' : end < value.length ? '\n' : '';
	let body: string;
	let caret: number;
	let caretEnd: number;
	switch (kind) {
		case 'code':
			body = `\`\`\`\n${selected}\n\`\`\``;
			caret = 4;
			caretEnd = 4 + selected.length;
			break;
		case 'callout': {
			const lines = selected ? selected.split('\n').map(line => `> ${line}`).join('\n') : '> ';
			body = `> [!NOTE]\n${lines}`;
			caret = 12;
			caretEnd = body.length;
			break;
		}
		case 'table':
			body = '| Column | Column |\n| --- | --- |\n|  |  |';
			caret = 2;
			caretEnd = 8;
			break;
		case 'rule':
			body = '---';
			caret = caretEnd = body.length + after.length;
			break;
	}
	const text = before + body + after;
	return { start, end, text, selectionStart: start + before.length + caret, selectionEnd: start + before.length + caretEnd };
}

/**
 * The @mention being typed at `caret`: where its `@` is and the words after
 * it, up to two of them, on one line. Undefined when the caret is not in one,
 * such as in an email address.
 */
export function mentionAt(value: string, caret: number): { readonly start: number; readonly query: string } | undefined {
	const line = value.slice(value.lastIndexOf('\n', caret - 1) + 1, caret);
	// "@", "@ann" or "@ann le": a first name and the start of a second, after a space or bracket.
	const match = /(?:^|[\s([{"'])@((?:[^\s@]+(?: [^\s@]*)?)?)$/.exec(line);
	if (!match || match[1].length > 40) {
		return undefined;
	}
	return { start: caret - match[1].length - 1, query: match[1] };
}

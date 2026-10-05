/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { continueList, formatShortcut, toggleWrap, type TextEdit } from '../../webview-src/markdownEdit';

/** The text and selection after an edit, with the selection marked by [ and ]. */
function apply(value: string, edit: TextEdit | undefined): string {
	if (!edit) {
		return value;
	}
	const text = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
	return `${text.slice(0, edit.selectionStart)}[${text.slice(edit.selectionStart, edit.selectionEnd)}]${text.slice(edit.selectionEnd)}`;
}

describe('toggleWrap', () => {
	it('wraps the selection and keeps it selected', () => {
		expect(apply('fix the total', toggleWrap('fix the total', 4, 7, '**'))).toBe('fix **[the]** total');
		expect(apply('call total()', toggleWrap('call total()', 5, 12, '`'))).toBe('call `[total()]`');
	});

	it('puts the cursor between a pair of markers when nothing is selected', () => {
		expect(apply('a ', toggleWrap('a ', 2, 2, '**'))).toBe('a **[]**');
	});

	it('unwraps a selection the marker already surrounds, inside or outside it', () => {
		expect(apply('fix **the** total', toggleWrap('fix **the** total', 6, 9, '**'))).toBe('fix [the] total');
		expect(apply('fix **the** total', toggleWrap('fix **the** total', 4, 11, '**'))).toBe('fix [the] total');
		expect(apply('`x`', toggleWrap('`x`', 1, 2, '`'))).toBe('[x]');
	});
});

describe('continueList', () => {
	const at = (value: string) => continueList(value.replace('|', ''), value.indexOf('|'));
	const result = (value: string) => apply(value.replace('|', ''), at(value));

	it('starts the next bullet, number or task', () => {
		expect(result('- one|')).toBe('- one\n- []');
		expect(result('  * one|')).toBe('  * one\n  * []');
		expect(result('9. nine|')).toBe('9. nine\n10. []');
		expect(result('1) one|')).toBe('1) one\n2) []');
		expect(result('- [x] done|')).toBe('- [x] done\n- [ ] []');
	});

	it('splits an item when the cursor is inside it', () => {
		expect(result('- one| two')).toBe('- one\n- [] two');
	});

	it('ends the list on an empty item', () => {
		expect(result('- one\n- |')).toBe('- one\n[]');
		expect(result('1. one\n2. |')).toBe('1. one\n[]');
	});

	it('leaves other lines and code blocks to a plain new line', () => {
		expect(at('plain text|')).toBeUndefined();
		expect(at('-not a list|')).toBeUndefined();
		expect(at('```\n- inside code|')).toBeUndefined();
		expect(at('```\ncode\n```\n- after code|')).toBeDefined();
	});
});

describe('formatShortcut', () => {
	const key = (code: string, mods: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({ code, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });

	it('maps ⌘B and ⌘E on a Mac, Ctrl elsewhere', () => {
		expect(formatShortcut(key('KeyB', { metaKey: true }), true)).toBe('**');
		expect(formatShortcut(key('KeyE', { metaKey: true }), true)).toBe('`');
		expect(formatShortcut(key('KeyB', { ctrlKey: true }), false)).toBe('**');
		expect(formatShortcut(key('KeyB', { ctrlKey: true }), true)).toBeUndefined();
	});

	it('leaves ⌥⌘E (Enhance) and other keys alone', () => {
		expect(formatShortcut(key('KeyE', { metaKey: true, altKey: true }), true)).toBeUndefined();
		expect(formatShortcut(key('KeyI', { metaKey: true }), true)).toBeUndefined();
		expect(formatShortcut(key('KeyB', { metaKey: true, shiftKey: true }), true)).toBeUndefined();
	});
});

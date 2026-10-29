/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex, moveInGrid, recentEmoji, searchEmoji, type EmojiEntry } from '../../webview-src/emojiSearch';

const data = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'webview-src', 'emojiData.json'), 'utf8')) as { source: string; groups: EmojiEntry[][] };
const index = buildIndex(data.groups, Infinity);

describe('emojiData.json', () => {
	it('has the nine categories, each emoji with a name, words and a version, and no skin tones', () => {
		expect(data.groups).toHaveLength(9);
		expect(index.length).toBeGreaterThan(1800);
		expect(data.groups.flat().every(([emoji, name, words, version]) => !!emoji && !!name && typeof words === 'string' && typeof version === 'number')).toBe(true);
		expect(index.some(entry => /\p{Emoji_Modifier}/u.test(entry.emoji))).toBe(false);
	});
});

describe('searchEmoji', () => {
	it('puts a name that is the query first, then names that start with it, then search words', () => {
		const found = searchEmoji(index, 'rock').map(entry => entry.emoji);
		expect(found.slice(0, 2)).toEqual(['🪨', '🚀']);
	});

	it('needs every word typed, in the name or the search words', () => {
		expect(searchEmoji(index, 'thumbs up').map(entry => entry.emoji)).toEqual(['👍']);
		expect(searchEmoji(index, 'RED heart').map(entry => entry.emoji)).toContain('❤️');
		expect(searchEmoji(index, 'launch').map(entry => entry.emoji)).toContain('🚀');
		expect(searchEmoji(index, '  ')).toEqual([]);
		expect(searchEmoji(index, 'zzzzqq')).toEqual([]);
	});

	it('searches all of the emoji in a few milliseconds', () => {
		const started = performance.now();
		for (const query of ['s', 'sm', 'smile', 'face with', 'heart']) {
			searchEmoji(index, query);
		}
		expect((performance.now() - started) / 5).toBeLessThan(5);
	});
});

describe('buildIndex', () => {
	it('leaves out emoji newer than the system can draw', () => {
		const groups: EmojiEntry[][] = [[['a', 'old', '', 1], ['b', 'new', '', 16]]];
		expect(buildIndex(groups, 15.1).map(entry => entry.emoji)).toEqual(['a']);
	});
});

describe('moveInGrid', () => {
	// Recent with 3, then sections of 10 and 4, 8 to a row.
	const sizes = [3, 10, 4];
	const move = (section: number, cell: number, key: string) => moveInGrid(sizes, 8, { section, cell }, key);

	it('moves along a row and on into the next section', () => {
		expect(move(1, 0, 'ArrowRight')).toEqual({ section: 1, cell: 1 });
		expect(move(0, 2, 'ArrowRight')).toEqual({ section: 1, cell: 0 });
		expect(move(1, 0, 'ArrowLeft')).toEqual({ section: 0, cell: 2 });
		expect(move(2, 3, 'ArrowRight')).toEqual({ section: 2, cell: 3 });
	});

	it('moves up and down rows, crossing sections and keeping the column where it can', () => {
		expect(move(1, 2, 'ArrowDown')).toEqual({ section: 1, cell: 9 });
		expect(move(1, 6, 'ArrowDown')).toEqual({ section: 1, cell: 9 });
		expect(move(1, 9, 'ArrowDown')).toEqual({ section: 2, cell: 1 });
		expect(move(1, 9, 'ArrowUp')).toEqual({ section: 1, cell: 1 });
		expect(move(1, 5, 'ArrowUp')).toEqual({ section: 0, cell: 2 });
		expect(move(2, 1, 'ArrowUp')).toEqual({ section: 1, cell: 9 });
		expect(move(2, 1, 'ArrowDown')).toEqual({ section: 2, cell: 1 });
	});

	it('leaves the grid upward from the first row, and jumps to a row\'s ends', () => {
		expect(move(0, 1, 'ArrowUp')).toBeUndefined();
		expect(move(1, 9, 'Home')).toEqual({ section: 1, cell: 8 });
		expect(move(1, 3, 'End')).toEqual({ section: 1, cell: 7 });
		expect(move(1, 8, 'End')).toEqual({ section: 1, cell: 9 });
	});

	it('skips empty sections', () => {
		expect(moveInGrid([2, 0, 3], 8, { section: 0, cell: 1 }, 'ArrowDown')).toEqual({ section: 2, cell: 1 });
	});
});

describe('recentEmoji', () => {
	it('finds the recent emoji, with or without a variation selector, newest first', () => {
		expect(recentEmoji(index, ['🚀', '❤', 'not an emoji', '👍']).map(entry => entry.name)).toEqual(['rocket', 'red heart', 'thumbs up']);
	});
});

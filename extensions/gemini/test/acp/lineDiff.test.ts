/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { acceptHunk, diffLines, minimalEdit, revertHunk, splitLines } from '../../src/acp/lineDiff';

const lines = (text: string) => splitLines(text);

describe('diffLines', () => {
	it('finds no hunks in equal texts', () => {
		expect(diffLines(lines('a\nb'), lines('a\nb'))).toEqual([]);
	});

	it('finds separate changes, additions and removals', () => {
		const original = lines('one\ntwo\nthree\nfour\nfive\nsix');
		const modified = lines('one\nTWO\nthree\nfour\nfour and a half\nfive');
		expect(diffLines(original, modified)).toEqual([
			{ originalStart: 1, originalEnd: 2, modifiedStart: 1, modifiedEnd: 2 },
			{ originalStart: 4, originalEnd: 4, modifiedStart: 4, modifiedEnd: 5 },
			{ originalStart: 5, originalEnd: 6, modifiedStart: 6, modifiedEnd: 6 },
		]);
	});

	it('handles new and emptied files', () => {
		expect(diffLines(lines(''), lines('a\nb'))).toEqual([{ originalStart: 0, originalEnd: 1, modifiedStart: 0, modifiedEnd: 2 }]);
		expect(diffLines(lines('a\nb\n'), lines(''))).toEqual([{ originalStart: 0, originalEnd: 2, modifiedStart: 0, modifiedEnd: 0 }]);
	});

	it('reports a rewrite past the edit limit as one hunk, quickly', () => {
		const original = Array.from({ length: 5_000 }, (_, i) => `old ${i}`);
		const modified = ['same', ...Array.from({ length: 5_000 }, (_, i) => `new ${i}`), 'end'];
		const started = Date.now();
		expect(diffLines(['same', ...original, 'end'], modified)).toEqual([{ originalStart: 1, originalEnd: 5_001, modifiedStart: 1, modifiedEnd: 5_001 }]);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it('keeps or undoes each hunk on its own, and all of them get back to either text', () => {
		const original = lines('a\nb\nc\nd\ne\nf\ng');
		const modified = lines('a\nB\nc\nd\nnew\ne\ng');
		const hunks = diffLines(original, modified);
		expect(hunks).toHaveLength(3);
		expect(revertHunk(original, modified, hunks[0]).join('\n')).toBe('a\nb\nc\nd\nnew\ne\ng');
		expect(acceptHunk(original, modified, hunks[1]).join('\n')).toBe('a\nb\nc\nd\nnew\ne\nf\ng');
		let undone = modified;
		for (const hunk of [...hunks].reverse()) {
			undone = revertHunk(original, undone, hunk);
		}
		expect(undone).toEqual(original);
		let kept = original;
		for (const hunk of [...hunks].reverse()) {
			kept = acceptHunk(kept, modified, hunk);
		}
		expect(kept).toEqual(modified);
	});

	it('agrees with a brute-force line diff on random edits', () => {
		let seed = 7;
		const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
		for (let round = 0; round < 200; round++) {
			const original = Array.from({ length: random(12) }, () => String.fromCharCode(97 + random(4)));
			const modified = original.flatMap(line => random(4) === 0 ? [] : random(4) === 0 ? [line, String.fromCharCode(97 + random(4))] : [random(5) === 0 ? 'x' : line]);
			const hunks = diffLines(original, modified);
			const changed = hunks.reduce((n, h) => n + (h.originalEnd - h.originalStart) + (h.modifiedEnd - h.modifiedStart), 0);
			expect(changed).toBe(original.length + modified.length - 2 * lcsLength(original, modified));
			let undone = modified;
			for (const hunk of [...hunks].reverse()) {
				undone = revertHunk(original, undone, hunk);
			}
			expect(undone).toEqual(original);
		}
	});
});

describe('minimalEdit', () => {
	it('replaces only what differs', () => {
		expect(minimalEdit('let a = 1;\nlet b = 2;', 'let a = 1;\nlet b = 3;')).toEqual({ start: 19, end: 20, text: '3' });
		expect(minimalEdit('aaa', 'aaaa')).toEqual({ start: 3, end: 3, text: 'a' });
		expect(minimalEdit('same', 'same')).toEqual({ start: 4, end: 4, text: '' });
	});
});

function lcsLength(a: readonly string[], b: readonly string[]): number {
	const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	return table[0][0];
}

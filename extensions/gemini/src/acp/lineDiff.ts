/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Line diffs between a file's text before an agent changed it and its text
// now, as hunks the editor can show, keep or undo one at a time.

/** Lines `[originalStart, originalEnd)` of the original became lines `[modifiedStart, modifiedEnd)` now. 0-based. */
export interface Hunk {
	readonly originalStart: number;
	readonly originalEnd: number;
	readonly modifiedStart: number;
	readonly modifiedEnd: number;
}

/** Lines as the editor counts them; `\r` stays on the line, so texts with either line ending compare alike. */
export function splitLines(text: string): string[] {
	return text.split('\n');
}

/**
 * Past this many differing lines the diff stops looking for the smallest
 * change and reports the rest as one hunk, so a rewritten file stays fast.
 */
const maxEditDistance = 500;

/** The hunks that turn `original` into `modified` (Myers' O(ND) diff). */
export function diffLines(original: readonly string[], modified: readonly string[]): Hunk[] {
	let start = 0;
	while (start < original.length && start < modified.length && original[start] === modified[start]) {
		start++;
	}
	let originalEnd = original.length;
	let modifiedEnd = modified.length;
	while (originalEnd > start && modifiedEnd > start && original[originalEnd - 1] === modified[modifiedEnd - 1]) {
		originalEnd--;
		modifiedEnd--;
	}
	if (start === originalEnd && start === modifiedEnd) {
		return [];
	}
	const a = original.slice(start, originalEnd);
	const b = modified.slice(start, modifiedEnd);
	const matches = commonLines(a, b);
	if (!matches) {
		return [{ originalStart: start, originalEnd, modifiedStart: start, modifiedEnd }];
	}
	// Lines between matches are the hunks.
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	for (const [mi, mj] of [...matches, [a.length, b.length] as const]) {
		if (mi > i || mj > j) {
			hunks.push({ originalStart: start + i, originalEnd: start + mi, modifiedStart: start + j, modifiedEnd: start + mj });
		}
		i = mi + 1;
		j = mj + 1;
	}
	return hunks;
}

/** The pairs of matching line indexes in a longest common subsequence, in order, or undefined when the texts differ too much. */
function commonLines(a: readonly string[], b: readonly string[]): [number, number][] | undefined {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, maxEditDistance);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				return backtrack(trace, d, n, m, offset, a, b);
			}
		}
	}
	return undefined;
}

function backtrack(trace: readonly Int32Array[], d: number, n: number, m: number, offset: number, a: readonly string[], b: readonly string[]): [number, number][] {
	const matches: [number, number][] = [];
	let x = n;
	let y = m;
	for (; d > 0; d--) {
		const v = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = v[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY && a[x - 1] === b[y - 1]) {
			matches.push([--x, --y]);
		}
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		matches.push([--x, --y]);
	}
	return matches.reverse();
}

/** `modified` with `hunk` put back as it was in `original`. */
export function revertHunk(original: readonly string[], modified: readonly string[], hunk: Hunk): string[] {
	return [...modified.slice(0, hunk.modifiedStart), ...original.slice(hunk.originalStart, hunk.originalEnd), ...modified.slice(hunk.modifiedEnd)];
}

/** `original` with `hunk` taken from `modified`: the new baseline once the change is kept. */
export function acceptHunk(original: readonly string[], modified: readonly string[], hunk: Hunk): string[] {
	return [...original.slice(0, hunk.originalStart), ...modified.slice(hunk.modifiedStart, hunk.modifiedEnd), ...original.slice(hunk.originalEnd)];
}

/** The one replacement that turns `before` into `after`, by offsets in `before`, so an editor keeps the cursor and undo stays small. */
export function minimalEdit(before: string, after: string): { readonly start: number; readonly end: number; readonly text: string } {
	let start = 0;
	const limit = Math.min(before.length, after.length);
	while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) {
		start++;
	}
	let end = 0;
	while (end < limit - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) {
		end++;
	}
	return { start, end: before.length - end, text: after.slice(start, after.length - end) };
}

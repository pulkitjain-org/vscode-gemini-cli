/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Two versions of a Confluence page compared and merged block by block (a
// paragraph, heading, list or table at the page's top level): the Review
// Page's marked changes, and its merge when the page changed since a draft
// was made. Pure, for the Review Page's webview, the publish and their tests.

import type { AdfNode } from './confluence';

/** A place where the page's newer version and the draft both changed the base differently: the user picks one. */
export interface MergeConflict {
	/** Where it goes in the merged page, by block index. */
	readonly at: number;
	readonly theirs: readonly AdfNode[];
	readonly mine: readonly AdfNode[];
}

/** Each block's JSON, made once per block object: the base's blocks are compared on every change. */
const keys = new WeakMap<AdfNode, string>();

function key(node: AdfNode): string {
	let found = keys.get(node);
	if (found === undefined) {
		found = JSON.stringify(node);
		keys.set(node, found);
	}
	return found;
}

/**
 * The draft (`mine`, made from `base`) carried onto the page's newer version
 * (`theirs`), block by block, as diff3 does with lines: a stretch only one
 * side changed takes that change; where both changed the same stretch
 * differently, the merged page keeps theirs and `conflicts` lists both for
 * the user to pick.
 */
export function mergeBlocks(base: readonly AdfNode[], theirs: readonly AdfNode[], mine: readonly AdfNode[]): { readonly merged: AdfNode[]; readonly conflicts: MergeConflict[] } {
	const baseKeys = base.map(key);
	const toTheirs = matches(baseKeys, theirs.map(key));
	const toMine = matches(baseKeys, mine.map(key));
	const same = (a: readonly AdfNode[], b: readonly AdfNode[]) => a.length === b.length && a.every((node, i) => key(node) === key(b[i]));
	const merged: AdfNode[] = [];
	const conflicts: MergeConflict[] = [];
	let b = 0;
	let t = 0;
	let m = 0;
	while (b <= base.length) {
		// The next base block both sides kept, or the end.
		let k = b;
		while (k < base.length && (toTheirs[k] === undefined || toMine[k] === undefined)) {
			k++;
		}
		const tk = k < base.length ? toTheirs[k]! : theirs.length;
		const mk = k < base.length ? toMine[k]! : mine.length;
		const was = base.slice(b, k);
		const theirPart = theirs.slice(t, tk);
		const myPart = mine.slice(m, mk);
		if (same(theirPart, was) || same(theirPart, myPart)) {
			merged.push(...myPart);
		} else if (same(myPart, was)) {
			merged.push(...theirPart);
		} else {
			conflicts.push({ at: merged.length, theirs: theirPart, mine: myPart });
			merged.push(...theirPart);
		}
		if (k < base.length) {
			merged.push(base[k]);
		}
		b = k + 1;
		t = tk + 1;
		m = mk + 1;
	}
	return { merged, conflicts };
}

/**
 * For each base block, the index of the block it matches in `other`, by a
 * longest common subsequence of whole blocks. The blocks both start and end
 * with are matched first, so the table covers only the stretch that changed.
 */
function matches(base: readonly string[], other: readonly string[]): (number | undefined)[] {
	const found: (number | undefined)[] = new Array(base.length).fill(undefined);
	let start = 0;
	while (start < base.length && start < other.length && base[start] === other[start]) {
		found[start] = start;
		start++;
	}
	let n = base.length;
	let m = other.length;
	while (n > start && m > start && base[n - 1] === other[m - 1]) {
		found[--n] = --m;
	}
	const lcs: number[][] = Array.from({ length: n - start + 1 }, () => new Array<number>(m - start + 1).fill(0));
	for (let i = n - 1; i >= start; i--) {
		for (let j = m - 1; j >= start; j--) {
			lcs[i - start][j - start] = base[i] === other[j] ? lcs[i - start + 1][j - start + 1] + 1 : Math.max(lcs[i - start + 1][j - start], lcs[i - start][j - start + 1]);
		}
	}
	for (let i = start, j = start; i < n && j < m;) {
		if (base[i] === other[j]) {
			found[i++] = j++;
		} else if (lcs[i - start + 1][j - start] >= lcs[i - start][j - start + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return found;
}

/** One stretch of blocks the draft changed from the page: `removed` (the page's) became `added` (the draft's). */
export interface BlockChange {
	/** Where it starts in the page, by block index. */
	readonly at: number;
	readonly removed: readonly AdfNode[];
	readonly added: readonly AdfNode[];
	/** The same for the same change of the same page, so a decision on it can be kept and sent. */
	readonly key: string;
}

/** A block of the page the draft leaves as it is (at block `at`), or a change. */
export type BlockPart = { readonly kind: 'same'; readonly node: AdfNode; readonly at: number } | ({ readonly kind: 'change' } & BlockChange);

/** The page (`base`) and the draft (`mine`) as unchanged blocks and changes, in page order. */
export function blockChanges(base: readonly AdfNode[], mine: readonly AdfNode[]): BlockPart[] {
	const mineKeys = mine.map(key);
	const toMine = matches(base.map(key), mineKeys);
	const parts: BlockPart[] = [];
	let m = 0;
	for (let b = 0; b <= base.length;) {
		let k = b;
		while (k < base.length && toMine[k] === undefined) {
			k++;
		}
		const mk = k < base.length ? toMine[k]! : mine.length;
		if (k > b || mk > m) {
			parts.push({ kind: 'change', at: b, removed: base.slice(b, k), added: mine.slice(m, mk), key: `${b}.${k - b}.${hash(mineKeys.slice(m, mk).join('\n'))}` });
		}
		if (k < base.length) {
			parts.push({ kind: 'same', node: base[k], at: k });
		}
		b = k + 1;
		m = mk + 1;
	}
	return parts;
}

/** FNV-1a, as base 36. */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	}
	return (h >>> 0).toString(36);
}

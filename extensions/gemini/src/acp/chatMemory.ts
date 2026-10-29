/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a chat keeps in memory beside its transcript, capped by size as well as
// by count: a long-running chat that edits large files, or runs tools with
// large output, must not grow without limit. Sizes count a string's UTF-16
// code units twice, an upper bound on what the engine holds.

import type * as acp from '@agentclientprotocol/sdk';

/** The bytes a string may take in memory. */
export function textBytes(text: string | null | undefined): number {
	return (text?.length ?? 0) * 2;
}

/** What a tool call's proposed edits take in memory: each file's text before and after. */
export function diffBytes(diffs: readonly acp.Diff[]): number {
	return diffs.reduce((sum, diff) => sum + textBytes(diff.path) + textBytes(diff.oldText) + textBytes(diff.newText), 0);
}

/**
 * Values by key, oldest first, holding at most `maxBytes` in all and at most
 * `maxEntries` of them: the oldest go first. A value larger than `maxBytes`
 * on its own is not kept. Setting a key again makes it the newest.
 */
export class BoundedStore<K, V> {

	private readonly values = new Map<K, { readonly value: V; readonly bytes: number }>();
	private total = 0;

	constructor(
		private readonly maxBytes: number,
		private readonly sizeOf: (value: V) => number,
		private readonly maxEntries = Number.POSITIVE_INFINITY,
	) { }

	/** The bytes held now. */
	get bytes(): number {
		return this.total;
	}

	get size(): number {
		return this.values.size;
	}

	get(key: K): V | undefined {
		return this.values.get(key)?.value;
	}

	/** Keeps `value` as the newest; returns whether it was kept, which it is not when it alone is over the cap. */
	set(key: K, value: V): boolean {
		this.delete(key);
		const bytes = this.sizeOf(value);
		if (bytes > this.maxBytes) {
			return false;
		}
		this.values.set(key, { value, bytes });
		this.total += bytes;
		for (const [oldest, entry] of this.values) {
			if (this.total <= this.maxBytes && this.values.size <= this.maxEntries) {
				break;
			}
			this.values.delete(oldest);
			this.total -= entry.bytes;
		}
		return true;
	}

	delete(key: K): void {
		const entry = this.values.get(key);
		if (entry) {
			this.values.delete(key);
			this.total -= entry.bytes;
		}
	}

	clear(): void {
		this.values.clear();
		this.total = 0;
	}
}

/** Output over this many lines shows only its first and last lines, with the rest fetched on request. */
export const longOutputLines = 80;
/** How many lines of a long output show at its start, and at its end. */
export const shownOutputLines = 20;

/** A tool's output as a tool card first shows it: whole, or its first and last lines and how many lines are hidden between them. */
export interface TrimmedOutput {
	readonly head: string;
	/** Empty when nothing is hidden. */
	readonly tail: string;
	readonly hiddenLines: number;
}

/** `text` as a tool card first shows it: whole up to {@link longOutputLines} lines, else its first and last {@link shownOutputLines}. */
export function trimOutput(text: string): TrimmedOutput {
	const lines = text.split('\n');
	if (lines.length <= longOutputLines) {
		return { head: text, tail: '', hiddenLines: 0 };
	}
	return {
		head: lines.slice(0, shownOutputLines).join('\n'),
		tail: lines.slice(-shownOutputLines).join('\n'),
		hiddenLines: lines.length - 2 * shownOutputLines,
	};
}

/**
 * Tools' full output by transcript item and part, for a tool card's Show All
 * to fetch when the card shows only the first and last lines of a long one.
 * The oldest outputs are dropped first once the store is over its cap; a card
 * whose output was dropped keeps what it shows.
 */
export class ToolOutputStore {

	private readonly outputs: BoundedStore<string, string>;

	constructor(maxBytes: number) {
		this.outputs = new BoundedStore<string, string>(maxBytes, textBytes);
	}

	get bytes(): number {
		return this.outputs.bytes;
	}

	/** Keeps part `part` of item `itemId`'s output, when it is long enough to be trimmed; returns what the card shows first. */
	put(itemId: string, part: number, text: string): TrimmedOutput {
		const trimmed = trimOutput(text);
		if (trimmed.hiddenLines) {
			this.outputs.set(outputKey(itemId, part), text);
		} else {
			this.outputs.delete(outputKey(itemId, part));
		}
		return trimmed;
	}

	/** The full output of part `part` of item `itemId`; undefined when it was never long or has been dropped. */
	get(itemId: string, part: number): string | undefined {
		return this.outputs.get(outputKey(itemId, part));
	}

	clear(): void {
		this.outputs.clear();
	}
}

function outputKey(itemId: string, part: number): string {
	return `${itemId}\n${part}`;
}

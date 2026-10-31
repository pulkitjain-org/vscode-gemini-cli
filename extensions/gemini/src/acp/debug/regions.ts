/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The marked regions a debug session inserted (DEBUG_MODE.md, Marked lines):
// the record of what went where, finding each again by its markers wherever
// it moved after edits, and the normalised comparison that decides whether
// it can be removed exactly. A region the user or a formatter changed beyond
// whitespace is never removed silently; its diff is shown instead.

import { markerEnd, markerStart } from './templates';

export interface RegionRecord {
	readonly file: string;
	readonly point: string;
	readonly nonce: string;
	/** The exact text inserted, lines joined with `\n`, no trailing newline. */
	readonly text: string;
	/** `text` with all whitespace removed, so a formatter's rewrap still compares equal. */
	readonly normalized: string;
	/** The line it was inserted before (one-based), at the time of insertion. */
	readonly line: number;
}

export interface FoundRegion {
	/** Zero-based line index of the start marker. */
	readonly start: number;
	/** Zero-based line index of the end marker, inclusive. */
	readonly end: number;
	readonly text: string;
}

/** `text` without any whitespace. */
export function normalizeRegion(text: string): string {
	return text.replace(/\s+/g, '');
}

/** The record of a region just inserted before `line` (one-based). */
export function recordRegion(file: string, nonce: string, point: string, lines: readonly string[], line: number): RegionRecord {
	const text = lines.join('\n');
	return { file, point, nonce, text, normalized: normalizeRegion(text), line };
}

function markerPattern(kind: string, nonce: string, point: string): RegExp {
	return new RegExp(`\\b${kind}\\s+${nonce}\\s+${point}\\b`);
}

/** Splits content into lines, keeping each line's ending with the line before it is rejoined. */
function splitLines(content: string): string[] {
	return content.split(/(?<=\n)/);
}

/** The region of `point` in `content`, by its markers, wherever it is; undefined when either marker is gone. */
export function findRegion(content: string, nonce: string, point: string): FoundRegion | undefined {
	const lines = splitLines(content);
	const start = markerPattern(markerStart, nonce, point);
	const end = markerPattern(markerEnd, nonce, point);
	const startIndex = lines.findIndex(l => start.test(l));
	if (startIndex < 0) {
		return undefined;
	}
	const endOffset = lines.slice(startIndex + 1).findIndex(l => end.test(l));
	if (endOffset < 0) {
		return undefined;
	}
	const endIndex = startIndex + 1 + endOffset;
	return { start: startIndex, end: endIndex, text: lines.slice(startIndex, endIndex + 1).join('').replace(/\r?\n$/, '') };
}

/** Every region with `nonce` in `content`, by point id, in order of appearance. */
export function findRegions(content: string, nonce: string): Map<string, FoundRegion> {
	const found = new Map<string, FoundRegion>();
	const lines = splitLines(content);
	const start = new RegExp(`\\b${markerStart}\\s+${nonce}\\s+(p\\d+)\\b`);
	for (let i = 0; i < lines.length; i++) {
		const point = start.exec(lines[i])?.[1];
		if (point && !found.has(point)) {
			const region = findRegion(content, nonce, point);
			if (region) {
				found.set(point, region);
			}
		}
	}
	return found;
}

export type RegionState = 'same' | 'changed' | 'missing';

/** Whether the region in `content` is still what was inserted, apart from whitespace. */
export function compareRegion(content: string, record: RegionRecord): { readonly state: RegionState; readonly found?: FoundRegion } {
	const found = findRegion(content, record.nonce, record.point);
	if (!found) {
		return { state: 'missing' };
	}
	return { state: normalizeRegion(found.text) === record.normalized ? 'same' : 'changed', found };
}

export interface RemoveResult {
	readonly state: RegionState;
	/** The content without the region, for `same` and for `changed` with `force`. */
	readonly content?: string;
	/** For `changed`: the region as it is now, to show beside what was inserted. */
	readonly current?: string;
}

/**
 * `content` with the region removed, markers included, when its normalised
 * text is what was inserted; with `force`, a changed region goes too (the
 * user chose Remove Anyway). A missing region leaves the content alone.
 */
export function removeRegion(content: string, record: RegionRecord, force = false): RemoveResult {
	const { state, found } = compareRegion(content, record);
	if (!found || (state === 'changed' && !force)) {
		return state === 'changed' ? { state, current: found?.text } : { state };
	}
	const lines = splitLines(content);
	lines.splice(found.start, found.end - found.start + 1);
	return { state, content: lines.join(''), current: found.text };
}

/** The records whose region is still in `content` (file renamed, checked out or edited): the record's view after a git move. */
export function stillPresent(content: string, records: readonly RegionRecord[]): readonly RegionRecord[] {
	return records.filter(r => findRegion(content, r.nonce, r.point) !== undefined);
}

/** Whether a write that turns `before` into `after` changes any recorded region: a change refused in every phase. */
export function changesRegion(before: string, after: string, records: readonly RegionRecord[]): RegionRecord | undefined {
	for (const record of records) {
		const was = findRegion(before, record.nonce, record.point);
		const now = findRegion(after, record.nonce, record.point);
		if (!was) {
			continue;
		}
		if (!now || normalizeRegion(now.text) !== normalizeRegion(was.text)) {
			return record;
		}
	}
	return undefined;
}

/** A two-column diff of the inserted text against the region as it is now, for the Clean up card. */
export function regionDiff(record: RegionRecord, current: string): string {
	const was = record.text.split('\n');
	const now = current.split('\n');
	const out: string[] = [];
	const length = Math.max(was.length, now.length);
	for (let i = 0; i < length; i++) {
		const a = was[i];
		const b = now[i];
		if (a === b) {
			out.push(`  ${a}`);
		} else {
			if (a !== undefined) {
				out.push(`- ${a}`);
			}
			if (b !== undefined) {
				out.push(`+ ${b}`);
			}
		}
	}
	return out.join('\n');
}

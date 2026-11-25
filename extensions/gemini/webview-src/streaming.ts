/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Helpers for showing a reply while it streams. No DOM, so they can be tested.

/** Where a streaming reply can be cut, from {@link scanStreaming}. */
export interface StreamingScan {
	/**
	 * Where the finished part ends: just after the last blank line outside a
	 * code fence. Blocks before it no longer change as text arrives, so only
	 * the rest needs rendering again. 0 means none yet.
	 */
	readonly stableEnd: number;
	/**
	 * A code fence at column 0 that is still open at the end of the text:
	 * where its opening line starts, where its code starts (after that line)
	 * and the opening line itself. Its code only grows until the fence closes.
	 */
	readonly openFence?: { readonly start: number; readonly codeStart: number; readonly opener: string };
	/** Whether any code fence, indented ones included, is still open at the end. */
	readonly inFence: boolean;
}

/**
 * Scans `text` from `from`, which must be 0 or an earlier stable end (so it
 * is outside any fence). Starting there keeps each update proportional to
 * the unfinished part rather than the whole reply.
 */
export function scanStreaming(text: string, from = 0): StreamingScan {
	let end = from;
	let fence: string | undefined;
	let fenceAt: { start: number; codeStart: number; opener: string; indented: boolean } | undefined;
	let offset = from;
	for (const line of text.slice(from).split('\n')) {
		const lineEnd = offset + line.length + 1;
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
			fence = fence ? undefined : marker;
			fenceAt = fence ? { start: offset, codeStart: lineEnd, opener: line, indented: line[0] === ' ' } : undefined;
		} else if (!fence && !line.trim() && lineEnd <= text.length && offset > 0) {
			end = lineEnd;
		}
		offset = lineEnd;
	}
	// Only a fence whose opening line is complete, and not indented (its code would need unindenting).
	const openFence = fence && fenceAt && !fenceAt.indented && fenceAt.codeStart <= text.length
		? { start: fenceAt.start, codeStart: fenceAt.codeStart, opener: fenceAt.opener }
		: undefined;
	return { stableEnd: end, openFence, inFence: !!fence };
}

/** {@link StreamingScan.stableEnd} of `text`. */
export function stableEnd(text: string, from = 0): number {
	return scanStreaming(text, from).stableEnd;
}

/** What the agent is thinking about now: its latest bold heading (as Gemini writes them), else its latest line. */
export function thoughtPreview(text: string): string {
	const headings = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)];
	return (headings.at(-1)?.[1] ?? text.trimEnd().split('\n').at(-1) ?? '').trim();
}

/**
 * The unfinished part of a reply is rendered again on each update. A long
 * one, such as a table or a list with no blank lines, is rendered at most
 * this often, so a 200-row table does not cost a full parse 30 times a second;
 * and less often still once a draw gets slow (`renderGap`).
 */
const longTail = 4_000;
const longTailIntervalMs = 150;
/** The longest a tail waits to be drawn again, however slow its last draw was. */
const maxGapMs = 1_000;

/**
 * How long to leave between two draws of a reply's unfinished tail, in ms; 0
 * draws every update. A tail with no blank line in it (a long table, a long
 * list) is drawn whole each time, so its cost grows with its length: the gap
 * follows what the last draw cost, so drawing takes about a fifth of the time
 * however long the tail gets, and a long tail waits `longTailIntervalMs` at least.
 */
export function renderGap(tailLength: number, lastCostMs: number | undefined): number {
	const byCost = Math.min(maxGapMs, (lastCostMs ?? 0) * 4);
	const gap = Math.max(tailLength > longTail ? longTailIntervalMs : 0, byCost);
	// Under a frame is no wait worth a timer.
	return gap < 16 ? 0 : Math.round(gap);
}

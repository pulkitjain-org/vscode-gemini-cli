/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
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
	return { stableEnd: end, openFence };
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

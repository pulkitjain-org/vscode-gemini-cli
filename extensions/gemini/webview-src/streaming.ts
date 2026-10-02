/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Helpers for showing a reply while it streams. No DOM, so they can be tested.

/**
 * Where the finished part of a streaming Markdown reply ends: just after the
 * last blank line outside a code fence. Blocks before it no longer change as
 * text arrives, so only the rest needs rendering again. 0 means none yet.
 */
export function stableEnd(text: string): number {
	let end = 0;
	let fence: string | undefined;
	let offset = 0;
	for (const line of text.split('\n')) {
		const lineEnd = offset + line.length + 1;
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
			fence = fence ? undefined : marker;
		} else if (!fence && !line.trim() && lineEnd <= text.length && offset > 0) {
			end = lineEnd;
		}
		offset = lineEnd;
	}
	return end;
}

/** What the agent is thinking about now: its latest bold heading (as Gemini writes them), else its latest line. */
export function thoughtPreview(text: string): string {
	const headings = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)];
	return (headings.at(-1)?.[1] ?? text.trimEnd().split('\n').at(-1) ?? '').trim();
}

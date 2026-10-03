/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shows an agent reply while it streams, rendering only what changed.

import { emptyFence } from './chatLogic';
import { el } from './dom';
import { renderBlocks } from './items';
import { scanStreaming } from './streaming';

/**
 * A reply that is still streaming. Its first `stableCount` child nodes show
 * `stableText`, the blocks that no longer change; each update renders only
 * the text after them, so a long reply stays cheap to update. A code block
 * that is still open is not rendered again: its new code is appended as
 * text. When the reply is done it is rendered once more as a whole.
 */
export interface StreamingReply {
	readonly node: HTMLElement;
	stableText: string;
	stableCount: number;
	/** The open code block at the end, if any: where its opening line starts, its code and how much text it shows. */
	fence?: StreamingCode;
}

/**
 * The code of an open code block, in blocks of whole lines. New code only
 * goes into the last block, so the browser lays out just that block again
 * rather than every line of a long block.
 */
interface StreamingCode {
	readonly start: number;
	readonly code: HTMLElement;
	shown: number;
	tail: HTMLElement;
	tailLines: number;
}

const linesPerCodeChunk = 50;

function appendCode(fence: StreamingCode, text: string): void {
	const newlines = text.split('\n').length - 1;
	if (fence.tailLines + newlines < linesPerCodeChunk) {
		fence.tail.append(text);
		fence.tailLines += newlines;
		return;
	}
	// Close this block after its last whole line and start the next.
	const cut = text.lastIndexOf('\n') + 1;
	fence.tail.append(text.slice(0, cut));
	fence.tail = el('span', 'code-chunk');
	fence.tailLines = 0;
	fence.code.append(fence.tail);
	if (cut < text.length) {
		fence.tail.append(text.slice(cut));
	}
}

/** The replies still streaming, by item id. */
export const streamingReplies = new Map<string, StreamingReply>();

export function renderStreamingReply(item: { readonly id: string; readonly text: string }): HTMLElement {
	const reply: StreamingReply = { node: el('div', 'message agent markdown'), stableText: '', stableCount: 0 };
	streamingReplies.set(item.id, reply);
	updateStreamingReply(reply, item.text);
	return reply.node;
}

/** Whether `text` could be shown by rendering only its unfinished part. */
export function updateStreamingReply(reply: StreamingReply, text: string): boolean {
	if (!text.startsWith(reply.stableText)) {
		return false;
	}
	const scan = scanStreaming(text, reply.stableText.length);
	const { node, fence } = reply;
	if (fence && scan.openFence?.start === fence.start && text.length >= fence.shown) {
		// Still the same open code block, and nothing before it changed: add the new code.
		appendCode(fence, text.slice(fence.shown));
		fence.shown = text.length;
		return true;
	}
	reply.fence = undefined;
	while (node.childNodes.length > reply.stableCount) {
		node.lastChild?.remove();
	}
	if (scan.stableEnd > reply.stableText.length) {
		const blocks = renderBlocks(text.slice(reply.stableText.length, scan.stableEnd));
		node.append(...blocks);
		reply.stableCount += blocks.length;
		reply.stableText = text.slice(0, scan.stableEnd);
	}
	const open = scan.openFence;
	if (open && open.start >= reply.stableText.length) {
		node.append(...renderBlocks(text.slice(reply.stableText.length, open.start)));
		// Render the empty block once for its classes and copy button, then fill in the code.
		const blocks = renderBlocks(emptyFence(open.opener));
		const code = blocks.map(b => b instanceof HTMLElement ? b.querySelector('code') : null).find(c => c);
		if (code) {
			node.append(...blocks);
			const tail = el('span', 'code-chunk');
			code.replaceChildren(tail);
			reply.fence = { start: open.start, code, shown: text.length, tail, tailLines: 0 };
			appendCode(reply.fence, text.slice(open.codeStart));
			return true;
		}
	}
	node.append(...renderBlocks(text.slice(reply.stableText.length)));
	return true;
}

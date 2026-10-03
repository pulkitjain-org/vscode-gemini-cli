/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TranscriptItem } from './chatTranscript';

/** New text for a reply or thought the view already has, instead of the whole item again. */
export interface TextAppend {
	readonly kind: 'append';
	readonly id: string;
	readonly append: string;
}

export type ItemUpdate = TranscriptItem | TextAppend;

/**
 * Turns item updates into what the view needs. A streaming reply only ever
 * grows, so once the view has it, each update sends just the new text: that
 * keeps each message small however long the reply gets, rather than sending
 * the whole reply about 30 times a second.
 */
export class TextDeltas {

	/** The text the view has, by item id, for replies and thoughts. */
	private readonly sent = new Map<string, string>();

	/** Records items the view now has in full, such as with a reset. */
	reset(items: readonly TranscriptItem[]): void {
		this.sent.clear();
		for (const item of items) {
			this.remember(item);
		}
	}

	toUpdates(items: readonly TranscriptItem[]): ItemUpdate[] {
		return items.map(item => {
			const previous = this.sent.get(item.id);
			this.remember(item);
			if (previous !== undefined && (item.kind === 'agent' || item.kind === 'thought') && item.text.length > previous.length && item.text.startsWith(previous)) {
				return { kind: 'append', id: item.id, append: item.text.slice(previous.length) };
			}
			return item;
		});
	}

	private remember(item: TranscriptItem): void {
		if (item.kind === 'agent' || item.kind === 'thought') {
			this.sent.set(item.id, item.text);
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Coalesces rapid updates to the same items, so a streaming answer reaches
 * the view at most once per interval instead of once per chunk. The first
 * update after a quiet period goes out at once, so nothing feels delayed;
 * later ones in the same burst wait for the interval and only the latest
 * version of each item is sent. Items keep the order they first changed in.
 */
export class UpdateBatcher<T extends { readonly id: string }> {

	private readonly pending = new Map<string, T>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly send: (items: readonly T[]) => void, private readonly intervalMs = 32) { }

	push(item: T): void {
		this.pending.set(item.id, item);
		if (!this.timer) {
			this.flush();
			this.schedule();
		}
	}

	/** Sends what is pending now, for example before a message that must come after it. */
	flush(): void {
		if (this.pending.size) {
			const items = [...this.pending.values()];
			this.pending.clear();
			this.send(items);
		}
	}

	/** Drops what is pending, for example when the whole list is about to be sent again. */
	clear(): void {
		this.pending.clear();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}

	private schedule(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.pending.size) {
				this.flush();
				this.schedule();
			}
		}, this.intervalMs);
	}
}

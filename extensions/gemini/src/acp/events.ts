/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type Listener<T> = (event: T) => void;

/** A minimal typed event emitter; `src/acp` cannot use the vscode `EventEmitter`. */
export class Emitter<T> {

	private readonly listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>): { dispose(): void } => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(event: T): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

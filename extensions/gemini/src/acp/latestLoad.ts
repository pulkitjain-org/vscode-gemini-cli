/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Loads one at a time, and applies only the newest: a load asked for while
 * another runs waits for it, and a load that a newer one superseded before it
 * finished is dropped, so an older read never replaces a newer state. A call
 * resolves once the state is at least as new as the call.
 */
export class LatestLoad<T> {

	private chain: Promise<unknown> = Promise.resolve();
	private requested = 0;

	constructor(private readonly read: () => Promise<T>, private readonly apply: (value: T) => void) { }

	async load(): Promise<void> {
		const mine = ++this.requested;
		const run = this.chain.then(async () => {
			if (mine === this.requested) {
				const value = await this.read();
				if (mine === this.requested) {
					this.apply(value);
				}
			}
		});
		this.chain = run.catch(() => undefined);
		await run;
		// Loads asked for meanwhile read again: wait for the last of them.
		for (let last: Promise<unknown> | undefined; last !== this.chain;) {
			last = this.chain;
			await last;
		}
	}
}

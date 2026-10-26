/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A folder's file events between two flushes (indexWatchers.ts). The indexer
// reconciles instead of applying more than 300 paths at once, so a batch
// stops collecting at 301: a checkout's 100,000 events never cross to the
// indexer, and never sit in memory.

/** One more than the indexer applies path by path. */
export const maxBatchPaths = 301;

export class ChangeBatch {

	private readonly paths = new Set<string>();

	constructor(private readonly max = maxBatchPaths) { }

	add(path: string): void {
		if (this.paths.size < this.max) {
			this.paths.add(path);
		}
	}

	/** The changed paths, or undefined when there were too many: the folder is reconciled instead. */
	get changed(): readonly string[] | undefined {
		return this.paths.size >= this.max ? undefined : [...this.paths];
	}
}

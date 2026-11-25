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

/**
 * How many paths a file watcher's batch holds before it gives up counting.
 * More than the indexer takes, so that a build's output (thousands of
 * ignored files) can be told from a checkout: `settled` drops what git
 * ignores before it decides.
 */
export const maxWatchedPaths = 5_000;

export class ChangeBatch {

	private readonly paths = new Set<string>();

	/** `max` is what the indexer applies path by path, plus one; `held` is how many paths are kept to choose from. */
	constructor(private readonly max = maxBatchPaths, private readonly held = max) { }

	add(path: string): void {
		if (this.paths.size < this.held) {
			this.paths.add(path);
		}
	}

	/** The changed paths, or undefined when there were too many: the folder is reconciled instead. */
	get changed(): readonly string[] | undefined {
		return this.paths.size >= this.max ? undefined : [...this.paths];
	}

	/**
	 * The changed paths once those git ignores are left out, or undefined when
	 * there are still too many, or more came than were held. `ignored` is asked
	 * only for a batch that is too big as it is: the indexer checks a small
	 * one's paths itself.
	 */
	async settled(ignored: (paths: readonly string[]) => Promise<ReadonlySet<string>>): Promise<readonly string[] | undefined> {
		if (this.paths.size < this.max) {
			return [...this.paths];
		}
		if (this.paths.size >= this.held) {
			return undefined;
		}
		const all = [...this.paths];
		const skip = await ignored(all).catch(() => new Set<string>());
		const kept = all.filter(each => !skip.has(each));
		return kept.length < this.max ? kept : undefined;
	}
}

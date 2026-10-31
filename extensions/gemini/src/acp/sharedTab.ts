/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's one shared agent tab: which agent it shows, which agents
// have a tab of their own, and which have had no tab for long enough that
// their chat can be released. Pure bookkeeping; the tabs themselves are in
// host/agents/agentTabs.ts.

/** How long an agent may be without a tab before its chat is released, when it is not busy. */
export const releaseAfterMs = 10 * 60_000;

export class SharedTab {

	private _shown: string | undefined;
	/** The agents with a tab of their own. */
	private readonly pinned = new Set<string>();
	/** When each agent's last tab closed, while it has none. */
	private readonly untabbedSince = new Map<string, number>();

	/** The agent the shared tab shows, if any. */
	get shown(): string | undefined {
		return this._shown;
	}

	/** Whether agent `id` has a tab of its own. */
	isPinned(id: string): boolean {
		return this.pinned.has(id);
	}

	/**
	 * The shared tab shows `id` now. Returns the agent it showed before, which
	 * is then without a tab; undefined when it showed `id` already, or nothing.
	 */
	show(id: string, now: number): string | undefined {
		const previous = this._shown;
		this._shown = id;
		this.untabbedSince.delete(id);
		if (previous === undefined || previous === id) {
			return undefined;
		}
		this.untabbedSince.set(previous, now);
		return previous;
	}

	/** Agent `id` has a tab of its own: opened in one, or the shared tab showing it became its own. */
	pin(id: string): void {
		this.pinned.add(id);
		this.untabbedSince.delete(id);
		if (this._shown === id) {
			this._shown = undefined;
		}
	}

	/** Agent `id`'s tab closed: its own, or the shared one while it showed it. */
	closed(id: string, now: number): void {
		this.pinned.delete(id);
		if (this._shown === id) {
			this._shown = undefined;
		}
		this.untabbedSince.set(id, now);
	}

	/** Agent `id` is gone from this window (stopped or removed), or has a tab again: nothing to release. */
	forget(id: string): void {
		this.untabbedSince.delete(id);
	}

	/** Whether any agent is without a tab, so the release check has something to look at. */
	get tracking(): boolean {
		return this.untabbedSince.size > 0;
	}

	/** The agents without a tab for `releaseAfterMs` at `now`, oldest closed first. */
	dueForRelease(now: number): string[] {
		return [...this.untabbedSince].filter(([, since]) => now - since >= releaseAfterMs).sort((a, b) => a[1] - b[1]).map(([id]) => id);
	}
}

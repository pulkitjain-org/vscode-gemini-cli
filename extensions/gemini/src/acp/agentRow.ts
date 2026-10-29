/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The short note at the end of an agent's row in the Agents side bar: how long
// it has been working, that it waits on the user, what it added, or how old it is.

/** "0:42", "12:05", "1:02:03": a running turn's clock. */
export function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = String(total % 60).padStart(2, '0');
	const minutes = Math.floor(total / 60);
	return minutes < 60 ? `${minutes}:${seconds}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** What an agent's row says after its title; the host words `waiting` and `age`. */
export type AgentRowMeta =
	| { readonly kind: 'clock'; readonly text: string }
	| { readonly kind: 'waiting' }
	| { readonly kind: 'added'; readonly text: string }
	| { readonly kind: 'age' };

export interface AgentRowState {
	readonly state: 'working' | 'waiting' | 'done' | 'idle' | 'stopped' | 'error' | 'kept';
	/** When the running turn started, in ms since the epoch. */
	readonly startedAt?: number;
	/** Lines the agent's edits add. */
	readonly added?: number;
}

/** Working shows its clock, waiting says so, done with edits shows the lines added, anything else its age. */
export function agentRowMeta(row: AgentRowState, now: number): AgentRowMeta {
	switch (row.state) {
		case 'working':
			return row.startedAt === undefined ? { kind: 'age' } : { kind: 'clock', text: formatClock(now - row.startedAt) };
		case 'waiting':
			return { kind: 'waiting' };
		case 'done':
			return row.added ? { kind: 'added', text: `+${row.added}` } : { kind: 'age' };
		default:
			return { kind: 'age' };
	}
}

/** What can be done with an agent on a branch, the same on every surface (Home's cards, thread and fork cards, the pane's row). */
export type BranchAgentAction = 'open' | 'stop' | 'try' | 'keep' | 'takeBack' | 'send' | 'resolve' | 'review' | 'checks' | 'approve' | 'discard' | 'restore' | 'terminal' | 'fork' | 'rename' | 'markdown' | 'remove';

export interface BranchAgentInput {
	readonly state: AgentRowState['state'] | 'planned';
	/** It changed files. */
	readonly hasChanges: boolean;
	/** It works on a branch of its own, so its work can be tried, merged or sent as a merge request. */
	readonly onBranch: boolean;
	readonly trying?: boolean;
	/** The user edited tried files, so Send My Edits applies. */
	readonly checkoutChanged?: boolean;
	readonly conflicts?: boolean;
	/** Discard Changes saved work that Restore can bring back. */
	readonly discarded?: boolean;
	readonly forkable?: boolean;
	/** Checks can run on its branch (a tool that runs them is connected). */
	readonly checks?: boolean;
}

export interface BranchAgentActions {
	/** Open, and Stop while it works. */
	readonly primary: readonly BranchAgentAction[];
	/** Taking the work: Try (with Merge Back and Open Merge Request on its chevron), then Keep, Take Back, Send My Edits and Open the Conflict while tried. */
	readonly work: readonly BranchAgentAction[];
	readonly check: readonly BranchAgentAction[];
	readonly plan: readonly BranchAgentAction[];
	readonly branch: readonly BranchAgentAction[];
	readonly housekeeping: readonly BranchAgentAction[];
}

/**
 * The one action set every surface draws from: cards show `primary` and the
 * first `work` action with the rest under More; the pane's row shows the
 * same as inline icons and its menu.
 */
export function branchAgentActions(input: BranchAgentInput): BranchAgentActions {
	const busy = input.state === 'working';
	const work: BranchAgentAction[] = input.trying
		? [...input.conflicts ? ['resolve' as const] : [], 'keep', 'takeBack', ...input.checkoutChanged ? ['send' as const] : []]
		: input.hasChanges && input.onBranch && !busy && input.state !== 'kept' ? ['try'] : [];
	return {
		primary: ['open', ...busy || input.state === 'waiting' ? ['stop' as const] : []],
		work,
		check: input.hasChanges && !busy ? ['review', ...input.checks && input.onBranch ? ['checks' as const] : []] : [],
		plan: input.state === 'planned' ? ['approve'] : [],
		branch: [...input.hasChanges && input.onBranch && !input.trying ? ['discard' as const] : [], ...input.discarded ? ['restore' as const] : [], 'terminal', ...input.forkable ? ['fork' as const] : []],
		housekeeping: ['rename', 'markdown', 'remove'],
	};
}

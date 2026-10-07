/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
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
	readonly state: 'working' | 'waiting' | 'done' | 'idle' | 'stopped' | 'error';
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

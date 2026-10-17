/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One word for the state of all the team's tools together, for the status
// bar: the tools are each in their own state on the Connections page.

import type { TeamToolId } from './teamHttp';

/** The tools only reachable over the client's VPN. */
export const vpnOnlyTools: ReadonlySet<TeamToolId> = new Set(['gitlab', 'sonar', 'snyk']);

export type TeamToolStateKind = 'off' | 'checking' | 'connected' | 'unreachable' | 'auth' | 'failed' | 'notInstalled';

/**
 * `none`: nothing connected. `attention`: a token was refused or a check
 * failed. `vpnOff`: a VPN-only tool doesn't answer. `checking`: a first check
 * hasn't answered yet. Figma not being open is normal, and counts as fine.
 */
export type TeamStatusWord = 'none' | 'attention' | 'vpnOff' | 'checking' | 'connected';

export interface TeamStatusSummary {
	readonly word: TeamStatusWord;
	/** The connected tools, in the order given. */
	readonly connected: readonly TeamToolId[];
	/** The tools behind the word, when it isn't `connected`. */
	readonly affected: readonly TeamToolId[];
}

export function teamStatusSummary(states: readonly { readonly tool: TeamToolId; readonly kind: TeamToolStateKind }[]): TeamStatusSummary {
	const connected = states.filter(s => s.kind !== 'off');
	const tools = (pick: (s: { readonly tool: TeamToolId; readonly kind: TeamToolStateKind }) => boolean) => connected.filter(pick).map(s => s.tool);
	const attention = tools(s => s.kind === 'auth' || s.kind === 'failed' || s.kind === 'notInstalled');
	const vpn = tools(s => s.kind === 'unreachable' && vpnOnlyTools.has(s.tool));
	const checking = tools(s => s.kind === 'checking');
	const word: TeamStatusWord = !connected.length ? 'none' : attention.length ? 'attention' : vpn.length ? 'vpnOff' : checking.length ? 'checking' : 'connected';
	return {
		word,
		connected: connected.map(s => s.tool),
		affected: word === 'attention' ? attention : word === 'vpnOff' ? vpn : word === 'checking' ? checking : [],
	};
}

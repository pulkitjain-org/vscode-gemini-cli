/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which team servers Home shows a banner for: one per server that can't be
// reached (the VPN, usually), with the time of the results the cards still
// show, and one per server that refused its token. Read from the one
// reachability state per server (teamHttp.ts, `teamReachability`) and each
// tool's connection state, so a banner clears by itself once the server
// answers or the token is replaced.

import type { ServerHealth, TeamToolId } from './teamHttp';

export interface TeamBanner {
	readonly tool: TeamToolId;
	/** unreachable: no answer; auth: the token was refused (401). */
	readonly kind: 'unreachable' | 'auth';
	/** When the results the cards still show came, in ms since the epoch. */
	readonly resultsAt?: number;
}

/** What the banners are read from, per tool. */
export interface TeamBannerInput {
	readonly tools: readonly TeamToolId[];
	readonly connected: ReadonlySet<TeamToolId>;
	/** The tool's connection state: `stale` when loaded from the last window and not checked yet in this one. */
	readonly state: (tool: TeamToolId) => { readonly kind: string; readonly stale?: boolean };
	/** The worst state among the tool's servers in this window. */
	readonly health: (tool: TeamToolId) => ServerHealth;
	/** When the tool's data on the cards came; unset when it has none. */
	readonly resultsAt: (tool: TeamToolId) => number | undefined;
}

/**
 * A banner per connected team tool whose server is down or refused the token,
 * a refused token first, as it needs the user. Figma runs on this Mac, so its
 * app being closed is no outage. A state saved by the last window shows only
 * once this window has checked it, so a fixed outage never flashes a banner.
 */
export function teamBanners(input: TeamBannerInput): TeamBanner[] {
	const banners: TeamBanner[] = [];
	for (const tool of input.tools) {
		if (tool === 'figma' || !input.connected.has(tool)) {
			continue;
		}
		const health = input.health(tool);
		const state = input.state(tool);
		const known = !state.stale;
		const kind = health.kind === 'signIn' || (known && state.kind === 'auth') ? 'auth'
			: health.kind === 'unreachable' || (known && state.kind === 'unreachable') ? 'unreachable' : undefined;
		if (kind) {
			const resultsAt = input.resultsAt(tool);
			banners.push({ tool, kind, ...resultsAt ? { resultsAt } : {} });
		}
	}
	return banners.sort((a, b) => Number(b.kind === 'auth') - Number(a.kind === 'auth'));
}

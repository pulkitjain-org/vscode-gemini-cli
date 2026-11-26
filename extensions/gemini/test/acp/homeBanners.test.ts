/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { teamBanners, type TeamBannerInput } from '../../src/acp/homeBanners';
import { TeamReachability, teamToolIds, type ServerHealth, type TeamToolId } from '../../src/acp/teamHttp';

/** Banners for these states and health, with every tool connected unless `connected` says otherwise. */
function bannersFor(options: { state?: Partial<Record<TeamToolId, { kind: string; stale?: boolean }>>; health?: Partial<Record<TeamToolId, ServerHealth>>; resultsAt?: Partial<Record<TeamToolId, number>>; connected?: readonly TeamToolId[] }) {
	const input: TeamBannerInput = {
		tools: teamToolIds,
		connected: new Set(options.connected ?? teamToolIds),
		state: tool => options.state?.[tool] ?? { kind: 'connected' },
		health: tool => options.health?.[tool] ?? { kind: 'ok' },
		resultsAt: tool => options.resultsAt?.[tool],
	};
	return teamBanners(input);
}

describe('Home\'s team banners', () => {
	it('show one banner per server that is down or refused the token, the refused token first, with the time of the results kept', () => {
		expect(bannersFor({
			health: { gitlab: { kind: 'unreachable', since: 1, retryAt: 2, failures: 1 }, jira: { kind: 'signIn', since: 1 } },
			resultsAt: { gitlab: 1_000 },
		})).toEqual([
			{ tool: 'jira', kind: 'auth' },
			{ tool: 'gitlab', kind: 'unreachable', resultsAt: 1_000 },
		]);
	});

	it('read the connection state when no call failed in this window, but not a state the last window saved', () => {
		expect(bannersFor({
			state: { sonar: { kind: 'unreachable' }, snyk: { kind: 'auth' }, jira: { kind: 'unreachable', stale: true }, gitlab: { kind: 'auth', stale: true } },
		})).toEqual([
			{ tool: 'snyk', kind: 'auth' },
			{ tool: 'sonar', kind: 'unreachable' },
		]);
	});

	it('leave out Figma, whose app is on this Mac, and tools that aren\'t connected', () => {
		expect(bannersFor({
			state: { figma: { kind: 'unreachable' }, gitlab: { kind: 'unreachable' } },
			connected: ['figma', 'jira'],
		})).toEqual([]);
	});

	it('clear by themselves once the server answers', () => {
		const reachability = new TeamReachability(() => 0);
		const health = (tool: TeamToolId) => reachability.health(tool);
		const input: TeamBannerInput = { tools: teamToolIds, connected: new Set(teamToolIds), state: () => ({ kind: 'connected' }), health, resultsAt: () => undefined };
		reachability.failed('gitlab', 'https://gitlab.acme.internal/api/v4/user');
		const down = teamBanners(input);
		reachability.succeeded('gitlab', 'https://gitlab.acme.internal/api/v4/projects');
		expect({ down, after: teamBanners(input) }).toEqual({ down: [{ tool: 'gitlab', kind: 'unreachable' }], after: [] });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient } from '../../src/acp/gitlab';
import { teamReachability } from '../../src/acp/teamHttp';

/**
 * A fake GitLab with merge requests 1 and 2 of project 7 to review, each
 * `updated` as set; the user's review state comes from `states`, and a
 * reviewers request fails while `failing` holds it. Records the reviewers requests.
 */
function fakeGitLab() {
	const asked: string[] = [];
	const updated: Record<number, string> = { 1: 't1', 2: 't1' };
	const states: Record<number, string> = { 1: 'unreviewed', 2: 'unreviewed' };
	const failing = new Set<number>();
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === '/api/v4/user') {
			return json({ id: 5, username: 'me', name: 'Me' });
		}
		if (url.pathname === '/api/v4/merge_requests') {
			return json([1, 2].map(iid => ({ iid, project_id: 7, title: `MR ${iid}`, web_url: `https://gl/g/r/-/merge_requests/${iid}`, source_branch: 'b', target_branch: 'main', updated_at: updated[iid] })));
		}
		const reviewers = /\/merge_requests\/(\d+)\/reviewers$/.exec(url.pathname);
		if (reviewers) {
			const iid = Number(reviewers[1]);
			asked.push(`!${iid}`);
			return failing.has(iid) ? new Response('down', { status: 500 }) : json([{ user: { id: 5 }, state: states[iid] }]);
		}
		if (url.pathname.endsWith('/approve') && init?.method === 'POST') {
			return json({});
		}
		return new Response(null, { status: 404 });
	}) as typeof fetch;
	return { client: new GitLabClient({ url: 'https://gl', token: 't' }, fetcher), asked, updated, states, failing };
}

const reviews = async (client: GitLabClient) => (await client.reviewRequests()).map(mr => `!${mr.iid} ${mr.myReview ?? '-'}`);

describe('GitLabClient review states', () => {
	beforeEach(() => teamReachability.clear());

	it('reads a kept state again after a few minutes, as an approval on GitLab may not change the merge request', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const gl = fakeGitLab();
			await reviews(gl.client);
			gl.states[1] = 'approved';
			const soon = await reviews(gl.client);
			vi.setSystemTime(Date.now() + 4 * 60_000);
			const later = await reviews(gl.client);
			expect({ soon, later }).toEqual({ soon: ['!1 unreviewed', '!2 unreviewed'], later: ['!1 approved', '!2 unreviewed'] });
		} finally {
			vi.useRealTimers();
		}
	});

	it('reads each merge request\'s state once until it changes, and again after a failure or the user\'s own review', async () => {
		const gl = fakeGitLab();
		gl.failing.add(2);
		const first = await reviews(gl.client);
		const again = await reviews(gl.client);
		gl.failing.delete(2);
		const recovered = await reviews(gl.client);
		gl.updated[1] = 't2';
		gl.states[1] = 'reviewed';
		const changed = await reviews(gl.client);
		gl.states[2] = 'approved';
		await gl.client.approve(7, 2);
		gl.client.forgetReviewState(7, 2);
		await new Promise(resolve => setTimeout(resolve, 0));
		const approved = await reviews(gl.client);
		expect({ first, again, recovered, changed, approved, asked: gl.asked }).toEqual({
			first: ['!1 unreviewed', '!2 -'],
			again: ['!1 unreviewed', '!2 -'],
			recovered: ['!1 unreviewed', '!2 unreviewed'],
			changed: ['!1 reviewed', '!2 unreviewed'],
			approved: ['!1 reviewed', '!2 approved'],
			// !2 failed twice and was asked again each time; !1 only when it changed.
			asked: ['!1', '!2', '!2', '!2', '!1', '!2'],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { cardOrder, firstName, moveCard, needsYou, partOfDay, sprintProgress, ticketOrder, toggleCard } from '../../src/acp/dashboard';
import type { GitLabMr, GitLabMrSummary } from '../../src/acp/gitlab';
import type { JiraIssueSummary } from '../../src/acp/jira';

function ticket(key: string, status: string, statusCategory: JiraIssueSummary['statusCategory']): JiraIssueSummary {
	return { key, summary: key, status, statusCategory, fixVersions: [], url: `https://acme.atlassian.net/browse/${key}` };
}

function mr(iid: number, extra: Partial<GitLabMr> = {}): GitLabMr {
	return {
		projectId: 1, project: 'shop/a', iid, title: `MR ${iid}`, author: 'marie', sourceBranch: 'f', targetBranch: 'develop', draft: false,
		url: `https://gitlab/shop/a/-/merge_requests/${iid}`, updatedAt: '', reviewers: [], description: '', state: 'opened', ...extra,
	};
}

describe('dashboard', () => {
	it('puts the most urgent things first in Needs you, at most four', () => {
		const reviews: GitLabMrSummary[] = [mr(322), mr(330, { draft: true })];
		const items = needsYou({
			agents: [{ id: 'a1', title: 'ACME-409', state: 'waiting', status: 'Wants to run npm install' }, { id: 'a2', title: 'x', state: 'working', status: '' }],
			reviews,
			mine: [mr(318, { pipeline: { id: 9, status: 'failed' } }), mr(301, { pipeline: { id: 8, status: 'success' } })],
			tickets: [ticket('ACME-377', 'Reopened', 'new'), ticket('ACME-415', 'To Do', 'new')],
		});
		expect(items.map(i => i.kind)).toEqual(['agentWaiting', 'pipelineFailed', 'review', 'reopened']);
		expect(needsYou({ agents: [], reviews }, 4)).toHaveLength(1);
	});

	it('counts sprint progress and days left', () => {
		const now = Date.parse('2026-10-17T09:00:00Z');
		const progress = sprintProgress([ticket('A-1', 'Done', 'done'), ticket('A-2', 'In Progress', 'indeterminate')], { id: 1, name: 'Sprint 42', endDate: '2026-10-23T09:00:00Z' }, now);
		expect(progress).toEqual({ done: 1, total: 2, daysLeft: 6 });
		expect(sprintProgress([], undefined, now)).toEqual({ done: 0, total: 0 });
	});

	it('lists reopened and to-do tickets before done ones', () => {
		const order = ticketOrder([ticket('A-1', 'Done', 'done'), ticket('A-2', 'In Progress', 'indeterminate'), ticket('A-3', 'To Do', 'new'), ticket('A-4', 'Reopened', 'new')]);
		expect(order.map(i => i.key)).toEqual(['A-4', 'A-3', 'A-2', 'A-1']);
	});

	it('keeps the user\'s card order, adding new cards at the end, and hides cards', () => {
		expect(cardOrder(undefined)).toEqual(['agents', 'tickets', 'mergeRequests', 'quality', 'gemini']);
		let layout = moveCard(undefined, 'quality', -2);
		expect(cardOrder(layout)).toEqual(['agents', 'quality', 'tickets', 'mergeRequests', 'gemini']);
		layout = toggleCard(layout, 'gemini', false);
		expect(cardOrder(layout)).not.toContain('gemini');
		expect(cardOrder(toggleCard(layout, 'gemini', true))).toContain('gemini');
		expect(cardOrder({ order: ['nonsense', 'gemini'] })[0]).toBe('gemini');
		// A layout saved by a version that had a Releases card still loads.
		expect(cardOrder({ order: ['releases', 'gemini'], hidden: ['releases'] })).toEqual(['gemini', 'agents', 'tickets', 'mergeRequests', 'quality']);
	});

	it('greets by first name and part of day', () => {
		expect(firstName('Pulkit Jain')).toBe('Pulkit');
		expect(firstName('pulkit.jain')).toBe('Pulkit');
		expect(firstName(undefined)).toBeUndefined();
		expect([partOfDay(8), partOfDay(13), partOfDay(20)]).toEqual(['morning', 'afternoon', 'evening']);
	});

});

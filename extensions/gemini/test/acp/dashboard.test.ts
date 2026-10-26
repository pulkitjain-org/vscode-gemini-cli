/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { cardOrder, firstName, isReadyToMerge, moveCard, needsYou, partOfDay, sprintProgress, ticketGroups, ticketOrder, toggleCard } from '../../src/acp/dashboard';
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
	it('puts the most urgent things first in Needs you', () => {
		const reviews: GitLabMrSummary[] = [mr(322), mr(330, { draft: true })];
		const items = needsYou({
			agents: [{ id: 'a1', title: 'ACME-409', state: 'waiting', status: 'Wants to run npm install' }, { id: 'a2', title: 'x', state: 'working', status: '' }, { id: 'a3', title: 'Header', state: 'done', status: '', tryReady: true }],
			reviews,
			mine: [mr(318, { pipeline: { id: 9, status: 'failed' } }), mr(301, { pipeline: { id: 8, status: 'success' }, mergeStatus: 'mergeable', approvals: { given: 2, required: 2, approvedByMe: false } }), mr(299, { unresolved: true })],
			tickets: [ticket('ACME-377', 'Reopened', 'new'), ticket('ACME-415', 'To Do', 'new')],
		}, 7);
		expect(items.map(i => i.kind)).toEqual(['agentWaiting', 'reply', 'pipelineFailed', 'readyToMerge', 'tryReady', 'review', 'reopened']);
		expect(needsYou({ agents: [], reviews }, 4)).toHaveLength(1);
	});

	it('shows at most two reviews, the ones that need the user most, and counts the rest', () => {
		const reviews: GitLabMrSummary[] = [
			mr(1, { updatedAt: '2026-10-20T10:00:00Z', reviewers: ['pj', 'ana'] }),
			mr(2, { updatedAt: '2026-10-24T10:00:00Z', reviewers: ['pj'] }),
			mr(3, { updatedAt: '2026-10-18T10:00:00Z', myReview: 'approved' }),
			mr(4, { updatedAt: '2026-10-19T10:00:00Z', mergeStatus: 'conflict', reviewers: ['pj'] }),
			mr(5, { updatedAt: '2026-10-25T10:00:00Z', reviewers: ['pj', 'ana'] }),
			mr(6, { updatedAt: '2026-10-26T10:00:00Z', reviewers: ['pj', 'ana'] }),
		];
		const items = needsYou({ agents: [], reviews, reviewing: new Set(['shop/a!6']), me: 'pj' });
		expect(items.map(item => item.kind === 'review' ? item.mr.iid : item.kind === 'moreReviews' ? `${item.count} more since ${item.oldest}` : item.kind)).toEqual([
			6, 2, '3 more since 2026-10-19T10:00:00Z',
		]);
	});

	it('says a merge request is ready only when GitLab, the approvals and the pipeline agree', () => {
		const ready = mr(1, { mergeStatus: 'mergeable', approvals: { given: 1, required: 1, approvedByMe: true }, pipeline: { id: 1, status: 'success' } });
		expect(isReadyToMerge(ready)).toBe(true);
		expect(isReadyToMerge({ ...ready, approvals: { given: 0, required: 1, approvedByMe: false } })).toBe(false);
		expect(isReadyToMerge({ ...ready, mergeStatus: 'ci_still_running' })).toBe(false);
		expect(isReadyToMerge({ ...ready, draft: true })).toBe(false);
		expect(isReadyToMerge({ ...ready, pipeline: { id: 1, status: 'failed' } })).toBe(false);
		expect(isReadyToMerge({ ...ready, approvals: undefined })).toBe(true);
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

	it('lists the running sprint\'s tickets first, then the rest, each to do first', () => {
		const mine = (key: string, status: string, category: JiraIssueSummary['statusCategory'], inSprint: boolean) => ({ ...ticket(key, status, category), inSprint });
		const groups = ticketGroups([mine('A-1', 'Done', 'done', true), mine('A-2', 'In Progress', 'indeterminate', false), mine('A-3', 'To Do', 'new', true), mine('A-4', 'To Do', 'new', false)]);
		expect({ sprint: groups.sprint.map(i => i.key), other: groups.other.map(i => i.key) }).toEqual({ sprint: ['A-3', 'A-1'], other: ['A-4', 'A-2'] });
	});

	it('leaves closed tickets out of the lists', () => {
		const mine = (key: string, status: string, category: JiraIssueSummary['statusCategory'], inSprint: boolean) => ({ ...ticket(key, status, category), inSprint });
		const groups = ticketGroups([mine('A-1', 'Done', 'done', true), mine('A-2', 'Closed', 'done', true), mine('A-3', 'CLOSED', 'done', false), mine('A-4', 'To Do', 'new', false)]);
		expect({ sprint: groups.sprint.map(i => i.key), other: groups.other.map(i => i.key) }).toEqual({ sprint: ['A-1'], other: ['A-4'] });
	});

	it('keeps the user\'s card order, adding new cards at the end, and hides cards', () => {
		expect(cardOrder(undefined)).toEqual(['unfinished', 'startup', 'agents', 'tickets', 'mergeRequests', 'quality', 'gemini']);
		let layout = moveCard(undefined, 'quality', -2);
		expect(cardOrder(layout)).toEqual(['unfinished', 'startup', 'agents', 'quality', 'tickets', 'mergeRequests', 'gemini']);
		layout = toggleCard(layout, 'gemini', false);
		expect(cardOrder(layout)).not.toContain('gemini');
		expect(cardOrder(toggleCard(layout, 'gemini', true))).toContain('gemini');
		expect(cardOrder({ order: ['nonsense', 'gemini'] })[0]).toBe('gemini');
		// A layout saved by a version that had a Releases card still loads.
		expect(cardOrder({ order: ['releases', 'gemini'], hidden: ['releases'] })).toEqual(['gemini', 'unfinished', 'startup', 'agents', 'tickets', 'mergeRequests', 'quality']);
	});

	it('greets by first name and part of day', () => {
		expect(firstName('Pulkit Jain')).toBe('Pulkit');
		expect(firstName('pulkit.jain')).toBe('Pulkit');
		expect(firstName(undefined)).toBeUndefined();
		expect([partOfDay(8), partOfDay(13), partOfDay(20)]).toEqual(['morning', 'afternoon', 'evening']);
	});

});

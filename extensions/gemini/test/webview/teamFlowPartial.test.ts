/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Counts that admit they're partial, checks that couldn't be read, and what
// a posted review leaves on the Mac: the Checks and Review pages.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { ChecksView, ReviewView } from '../../src/host/teamFlowProtocol';
import { page, posted, sendToPage, showTeamFlowPage, startScript } from './pages';

const { document } = page;

const checks: ChecksView = {
	kind: 'checks', agentTitle: 'Login fix', branch: 'feature/login', findings: [],
	rows: [{
		tool: 'sonar', name: 'SonarQube: new code', state: 'done', detail: 'Quality gate passed · 50 of 312 issues shown',
		pill: { text: '50', tone: 'warn' }, link: { label: 'Open in SonarQube', url: 'https://sonar.example.com/project/issues?id=shop' },
	}],
};

const review: ReviewView = {
	kind: 'review', project: 'shop/api', state: 'ready', summary: '', comments: [], threads: [], resolvedThreads: 0, rev: 0, approvedByMe: false,
	mr: { iid: 482, title: 'Rate limit', url: 'https://gitlab.example.com/shop/api/-/merge_requests/482', author: 'ada', source: 'rate-limit', target: 'main', files: 1 },
	side: [{ tool: 'people', label: 'Approvals', detail: 'couldn\'t read, counted as pending', pill: { text: 'pending', tone: 'muted' }, retry: true }],
	files: [{ path: 'src/limit.ts', dir: 'src/', name: 'limit.ts', added: 3, removed: 1, comments: 0 }],
	moreFiles: 39,
	agentId: 'reviewer',
	done: 'Posted 6 comments to !482.',
	leftover: 'The reviewer agent and its checkout (review/482-rate-limit) are still on this Mac.',
};

/** The buttons on the page, by their text. */
function buttonNamed(text: string): HTMLElement | undefined {
	return [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text) as HTMLElement | undefined;
}

beforeAll(async () => {
	await showTeamFlowPage();
	await startScript('teamFlow');
});

describe('partial counts and unread checks', () => {
	it('opens SonarQube\'s list beside a cut list of issues', () => {
		sendToPage({ type: 'state', state: { view: checks } });
		buttonNamed('Open in SonarQube')?.click();
		expect({
			detail: document.body.textContent?.includes('50 of 312 issues shown'),
			posted: posted.filter(message => message.type === 'act'),
		}).toEqual({ detail: true, posted: [{ type: 'act', action: 'open', value: checks.rows[0].link!.url }] });
	});

	it('shows a review\'s unread approvals as pending with Retry, how many files it shows, and what Post left behind', () => {
		posted.length = 0;
		sendToPage({ type: 'state', state: { view: review } });
		buttonNamed('Retry')?.click();
		buttonNamed('Keep for Re-review')?.click();
		buttonNamed('Remove Reviewer and Checkout')?.click();
		const text = document.body.textContent ?? '';
		expect({
			pending: text.includes('couldn\'t read, counted as pending'),
			files: text.includes('1 of 40 files shown. The rest are in GitLab.'),
			leftover: text.includes(review.leftover!),
			actions: posted.filter(message => message.type === 'act').map(message => message.action),
		}).toEqual({ pending: true, files: true, leftover: true, actions: ['retrySide', 'keepReviewer', 'removeReviewer'] });
	});
});

describe('the merge card in the Changes panel', () => {
	it('shows a check GitLab didn\'t answer as pending, with Retry', async () => {
		const { renderTeam } = await startScript('mrPanel') as { renderTeam: (view: unknown, post: (message: unknown) => void) => HTMLElement };
		const sent: unknown[] = [];
		const card = renderTeam({
			mr: {
				iid: 482, heading: '!482 Rate limit', target: 'into main', url: 'https://gitlab.example.com/x', openIn: 'Open in GitLab', rows: [],
				merge: {
					heading: 'Merge !482', readAt: 'read live 2 s ago', ready: false, button: 'Merge...', note: '',
					squash: { label: 'Squash', on: false }, removeSourceBranch: { label: 'Delete', on: true }, request: { path: '/merge_requests/482/merge', sha: 'abc1234' },
					checks: [{ name: 'Approvals', state: 'pending', detail: 'couldn\'t read, counted as pending', source: 'approval_state', retry: 'Retry' }],
				},
			},
		}, message => sent.push(message));
		const retry = [...card.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry');
		retry?.click();
		expect({ pending: !!card.querySelector('.mr-check.pending'), sent }).toEqual({ pending: true, sent: [{ type: 'team', action: 'retry' }] });
	});
	it('is one card: the pipeline and review threads show once, as their checks, with the failed job and open thread under them', async () => {
		const { renderTeam } = await startScript('mrPanel') as { renderTeam: (view: unknown, post: (message: unknown) => void) => HTMLElement };
		const sent: unknown[] = [];
		const section = renderTeam({
			mr: {
				iid: 14, heading: '!14 Guest checkout', target: '→ develop', url: 'https://gitlab.example.com/x', openIn: 'Open in GitLab',
				rows: [
					{ tool: 'gitlab', label: 'Pipeline for a79d1f6', pill: { text: 'failed', tone: 'error' }, jobs: [{ id: 7, name: 'test · semgrep-sast', fix: 'Fix' }], covers: 'pipeline' },
					{ tool: 'review', label: 'Review threads', pill: { text: '1 unresolved', tone: 'warn' }, threads: [{ id: 't1', author: 'Ana', text: 'Rename this step' }], covers: 'threads' },
					{ tool: 'jira', label: 'VCAAUTO-13', detail: 'AU guest checkout', pill: { text: 'In Review', tone: 'info' } },
				],
				fixAll: { label: 'Fix Pipeline and {0} Comments', one: 'Fix Pipeline and 1 Comment', pipelineOnly: 'Fix Pipeline', commentsOnly: 'Fix {0} Comments' },
				merge: {
					heading: 'Merge !14', readAt: 'read live 2 s ago', ready: false, button: 'Merge...', note: '',
					squash: { label: 'Squash', on: false }, removeSourceBranch: { label: 'Delete', on: true }, request: { path: '/merge_requests/14/merge', sha: 'a79d1f6' },
					checks: [
						{ name: 'Pipeline', state: 'missing', detail: 'head pipeline failed', source: 'head_pipeline.status', kind: 'pipeline' },
						{ name: 'Review threads', state: 'ok', detail: '1 unresolved', source: 'discussions', kind: 'threads' },
						{ name: 'No conflicts with the target', state: 'ok', detail: 'clean', source: 'has_conflicts' },
					],
				},
			},
		}, message => sent.push(message));
		const checks = [...section.querySelectorAll('.mr-check')].map(check => [check.querySelector('.mr-check-text > div')?.textContent, [...(check.nextElementSibling?.classList.contains('mr-check-under') ? check.nextElementSibling.querySelectorAll('.mr-sub-text') : [])].map(node => node.textContent)]);
		[...section.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Fix')?.click();
		[...section.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Fix Pipeline and 1 Comment')?.click();
		expect({
			cards: section.querySelectorAll('.mr-card').length,
			rows: [...section.querySelectorAll('.mr-row-text')].map(node => node.textContent),
			checks,
			sent,
		}).toEqual({
			cards: 1,
			rows: ['VCAAUTO-13'],
			checks: [['Pipeline', ['test · semgrep-sast']], ['Review threads', ['Ana · Rename this step']], ['No conflicts with the target', []]],
			sent: [{ type: 'team', action: 'fixJob', job: 7 }, { type: 'team', action: 'fixMr', jobs: true, threads: ['t1'] }],
		});
	});
});

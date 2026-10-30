/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Home's dashboard shows, worked out from the team tools' last answers
// and the agents: the order of reviews, sprint progress, card order. Pure,
// so the host only localizes it; nothing here calls a tool.

import type { GitLabMr, GitLabMrSummary } from './gitlab';
import type { JiraIssueSummary, JiraMyTicket, JiraSprint } from './jira';

export type DashboardCardId = 'unfinished' | 'startup' | 'agents' | 'tickets' | 'mergeRequests' | 'quality' | 'gemini';

export const dashboardCards: readonly DashboardCardId[] = ['unfinished', 'startup', 'agents', 'tickets', 'mergeRequests', 'quality', 'gemini'];

/** The user's card layout: the order, and which are hidden. */
export interface DashboardLayout {
	readonly order?: readonly string[];
	readonly hidden?: readonly string[];
	/** The release branch Quality looks at; the newest release branch when unset. */
	readonly qualityBranch?: string;
}

/** The cards to show, in the user's order; cards they never placed go at the end in the default order. */
export function cardOrder(layout: DashboardLayout | undefined): DashboardCardId[] {
	const known = (layout?.order ?? []).filter((id): id is DashboardCardId => dashboardCards.includes(id as DashboardCardId));
	const order = [...new Set([...known, ...dashboardCards])];
	return order.filter(id => !layout?.hidden?.includes(id));
}

/** `layout` with `card` moved by `delta` places among all cards (hidden ones keep their place). */
export function moveCard(layout: DashboardLayout | undefined, card: DashboardCardId, delta: number): DashboardLayout {
	const known = (layout?.order ?? []).filter((id): id is DashboardCardId => dashboardCards.includes(id as DashboardCardId));
	const order = [...new Set([...known, ...dashboardCards])];
	const from = order.indexOf(card);
	const to = Math.max(0, Math.min(order.length - 1, from + delta));
	order.splice(from, 1);
	order.splice(to, 0, card);
	return { ...layout, order };
}

export function toggleCard(layout: DashboardLayout | undefined, card: DashboardCardId, visible: boolean): DashboardLayout {
	const hidden = new Set(layout?.hidden ?? []);
	if (visible) {
		hidden.delete(card);
	} else {
		hidden.add(card);
	}
	return { ...layout, hidden: [...hidden] };
}

export interface SprintProgress {
	readonly done: number;
	readonly total: number;
	/** Whole days to the sprint's end, when Jira gives it; 0 on its last day. */
	readonly daysLeft?: number;
}

export function sprintProgress(issues: readonly JiraIssueSummary[], sprint: JiraSprint | undefined, now: number): SprintProgress {
	const end = sprint?.endDate ? Date.parse(sprint.endDate) : NaN;
	return {
		done: issues.filter(i => i.statusCategory === 'done').length,
		total: issues.length,
		...Number.isFinite(end) ? { daysLeft: Math.max(0, Math.ceil((end - now) / 86_400_000)) } : {},
	};
}

/** Tickets still to do first (reopened, then to do, then in progress), done last. */
export function ticketOrder<T extends JiraIssueSummary>(issues: readonly T[]): T[] {
	const rank = (i: JiraIssueSummary) => isReopened(i) ? 0 : i.statusCategory === 'new' ? 1 : i.statusCategory === 'indeterminate' ? 2 : 3;
	return [...issues].sort((a, b) => rank(a) - rank(b));
}

/** The user's tickets in the sprint running now, then the rest, each in `ticketOrder`. Closed tickets are left out: nothing is left to do on them. */
export function ticketGroups(issues: readonly JiraMyTicket[]): { readonly sprint: JiraMyTicket[]; readonly other: JiraMyTicket[] } {
	const open = issues.filter(i => !isClosed(i));
	return { sprint: ticketOrder(open.filter(i => i.inSprint)), other: ticketOrder(open.filter(i => !i.inSprint)) };
}

/**
 * Whether GitLab's own summary says the merge request can be merged now:
 * mergeable, not a draft, every approval given, and no failed pipeline. The
 * merge itself reads the full checks again (gitlab.ts, `mergeReadiness`).
 */
export function isReadyToMerge(mr: GitLabMr): boolean {
	return mr.state === 'opened' && !mr.draft && mr.mergeStatus === 'mergeable' && (!mr.approvals || mr.approvals.given >= mr.approvals.required) && mr.pipeline?.status !== 'failed';
}

export function isReopened(issue: JiraIssueSummary): boolean {
	return /reopen/i.test(issue.status);
}

/** A ticket in a done status named Closed, as against Done or Resolved, which the sprint's list still shows. */
export function isClosed(issue: JiraIssueSummary): boolean {
	return issue.statusCategory === 'done' && /^closed?$/i.test(issue.status.trim());
}

/** What ranking the reviews asked of the user looks at. */
export interface ReviewsInput {
	readonly reviews?: readonly GitLabMrSummary[];
	/** Reviews the user started in GeminiCode, as `project!iid`: they come first. */
	readonly reviewing?: ReadonlySet<string>;
	/** The user's GitLab username, to tell when they are an MR's only reviewer. */
	readonly me?: string;
}

/** States in which the user's part in a review is done until GitLab asks again. */
const reviewDone: ReadonlySet<string> = new Set(['approved', 'reviewed', 'requested_changes']);

/**
 * The reviews asked of the user that still need them, most pressing first:
 * ones they started, then ones where they are the only reviewer, then the
 * longest waiting. Drafts and reviews they already gave are left out; ones
 * the author must fix first (conflicts, failing CI) go last.
 */
export function rankReviews(input: ReviewsInput): GitLabMrSummary[] {
	const open = (input.reviews ?? []).filter(mr => !mr.draft && !(mr.myReview && reviewDone.has(mr.myReview)));
	const blocked = (mr: GitLabMrSummary) => mr.mergeStatus === 'conflict' || mr.mergeStatus === 'ci_must_pass' || mr.mergeStatus === 'broken_status';
	const rank = (mr: GitLabMrSummary) => [
		input.reviewing?.has(`${mr.project}!${mr.iid}`) || mr.myReview === 'review_started' ? 0 : 1,
		blocked(mr) ? 1 : 0,
		input.me && mr.reviewers.length === 1 && mr.reviewers[0] === input.me ? 0 : 1,
	];
	return [...open].sort((a, b) => {
		const [x, y] = [rank(a), rank(b)];
		for (let i = 0; i < x.length; i++) {
			if (x[i] !== y[i]) {
				return x[i] - y[i];
			}
		}
		// The longest waiting first.
		return (a.updatedAt || '').localeCompare(b.updatedAt || '');
	});
}

/** "morning" before noon, "afternoon" before six, then "evening". */
export function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
	return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** The first name in a display name or login: "Pulkit Jain" and "pulkit.jain" both give "Pulkit". */
export function firstName(name: string | undefined): string | undefined {
	const first = name?.trim().split(/[\s._-]+/)[0];
	return first ? first[0].toUpperCase() + first.slice(1) : undefined;
}

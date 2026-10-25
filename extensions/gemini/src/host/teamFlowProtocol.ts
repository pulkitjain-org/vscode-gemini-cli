/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the team flows' pages (src/host/teamFlows.ts) and their
// webview (webview-src/teamFlow.ts): Open Merge Request, Move Ticket and Log
// Time, Review a merge request, and Checks.
// The host holds each page's state; the page sends what the user types with
// `set` (no re-render) and what they press with `act`.

import type { CheckFinding, ReviewFinding, TargetChoice } from '../acp/teamFlowLogic';

export type FlowTool = 'jira' | 'gitlab' | 'sonar' | 'snyk' | 'figma';

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted';

export interface FlowPill {
	readonly text: string;
	readonly tone: Tone;
}

export interface FlowPerson {
	readonly id: number;
	readonly username: string;
	readonly name: string;
}

export interface FlowAttachment {
	readonly id: string;
	readonly name: string;
	readonly detail: string;
	readonly icon: string;
	readonly tools?: readonly FlowTool[];
	readonly checked: boolean;
}

export interface OpenMrView {
	readonly kind: 'openMr';
	readonly project: string;
	readonly source: string;
	readonly host: string;
	readonly account: string;
	readonly targets: readonly TargetChoice[];
	readonly target?: string;
	/** Branches GitLab has that weren't listed, found by searching. */
	readonly moreTargets: boolean;
	/** The target isn't develop, main or a release branch: how far ahead the source is. */
	readonly unusualTarget?: string;
	/** The target the description was written for, when it isn't the target now. */
	readonly describedFor?: string;
	/** On a reviewer agent: the merge request it reviews, instead of the form. */
	readonly reviewOf?: { readonly iid: number; readonly url: string; readonly project: string };
	readonly ticket?: { readonly key: string; readonly summary: string; readonly url: string; readonly fixVersions: readonly string[] };
	readonly title: string;
	readonly description: string;
	/** Bumped when the host replaces the description (generated), so the page takes it over the user's text. */
	readonly descriptionRev: number;
	readonly generating: boolean;
	readonly attachments: readonly FlowAttachment[];
	readonly reviewers: readonly FlowPerson[];
	readonly members: readonly FlowPerson[];
	readonly updateJira: boolean;
	readonly deleteBranch: boolean;
	readonly draft: boolean;
	readonly existing?: { readonly iid: number; readonly url: string };
}

export interface TransitionView {
	readonly id: string;
	readonly name: string;
	readonly to: string;
	readonly tone: Tone;
	readonly fields: readonly { readonly id: string; readonly name: string; readonly required: boolean; readonly multiple: boolean; readonly allowed?: readonly { readonly id: string; readonly name: string }[] }[];
}

export interface MoveTicketView {
	readonly kind: 'moveTicket';
	/** `log` shows Log Time only. */
	readonly mode: 'move' | 'log';
	readonly key: string;
	readonly summary: string;
	readonly url: string;
	readonly status: string;
	readonly statusTone: Tone;
	readonly transitions: readonly TransitionView[];
	readonly selected?: string;
	readonly fieldValues: Readonly<Record<string, string>>;
	readonly comment: string;
	readonly commentRev: number;
	readonly generating: boolean;
	readonly visibility?: string;
	readonly addComment: boolean;
	readonly logTime: boolean;
	readonly spent: string;
	/** YYYY-MM-DD */
	readonly date: string;
	readonly workComment: string;
	/** "3h logged, 1h 30m by you" */
	readonly logged?: string;
	readonly done?: string;
}

/** A comment in the review's draft, as the Review page shows it. */
export interface ReviewCommentView {
	readonly id: string;
	readonly by: 'gemini' | 'you';
	readonly kind?: ReviewFinding['kind'];
	readonly title?: string;
	readonly comment: string;
	readonly checked: boolean;
	/** The file and line, shortened: "…/fea/myaccount/en.xml:1". */
	readonly where?: string;
	/** The full path and line, for the tooltip. */
	readonly path?: string;
	readonly onLine: boolean;
	readonly lineChanged?: boolean;
	readonly suggestion?: {
		readonly text: string;
		readonly by: 'gemini' | 'you';
		readonly include: boolean;
		/** The lines it replaces, as they are now. */
		readonly old: string;
	};
	/** Whether a suggestion can go on its lines: inside one hunk of the merge request's changes. */
	readonly canSuggest: boolean;
	/** Gemini is writing a suggestion for it. */
	readonly suggesting?: boolean;
	/** Why Gemini's last suggestion didn't come. */
	readonly suggestNote?: string;
}

/** One of the merge request's threads, with the user's draft reply. */
export interface ReviewThreadView {
	readonly id: string;
	readonly where?: string;
	readonly path?: string;
	/** Shown on its line in the diff. */
	readonly onLine: boolean;
	readonly outdated?: boolean;
	readonly removedLine?: boolean;
	readonly resolvable: boolean;
	readonly notes: readonly { readonly author: string; readonly body: string; readonly when: string }[];
	readonly url: string;
	readonly reply?: { readonly id: string; readonly by: 'gemini' | 'you'; readonly text: string; readonly resolve: boolean; readonly checked: boolean };
}

export interface ReviewView {
	readonly kind: 'review';
	readonly project: string;
	readonly mr: { readonly iid: number; readonly title: string; readonly url: string; readonly author: string; readonly source: string; readonly target: string; readonly files: number; readonly head?: string };
	readonly state: 'preparing' | 'reviewing' | 'ready' | 'unparsed';
	readonly summary: string;
	readonly comments: readonly ReviewCommentView[];
	/** Open threads, and those Gemini or the user replied to. */
	readonly threads: readonly ReviewThreadView[];
	readonly resolvedThreads: number;
	/** Bumped when the host replaces the draft, so the page takes its text over what the user typed. */
	readonly rev: number;
	readonly side: readonly { readonly tool: FlowTool | 'people'; readonly label: string; readonly detail?: string; readonly pill?: FlowPill }[];
	readonly files: readonly { readonly path: string; readonly dir: string; readonly name: string; readonly added: number; readonly removed: number; readonly comments: number }[];
	/** Changed files GitLab didn't list, beyond its first 100. */
	readonly moreFiles?: number;
	readonly agentId?: string;
	/** The reviewer agent was removed; Ask Gemini Again starts another. */
	readonly agentGone?: boolean;
	/** New commits on the source branch since the diff's version, as a sentence. */
	readonly moved?: string;
	readonly approvedByMe: boolean;
	readonly done?: string;
}

export interface ChecksView {
	readonly kind: 'checks';
	readonly agentTitle: string;
	readonly agentId?: string;
	readonly branch?: string;
	/** The checkout the checks run on, as the user names it (~/.geminicode/worktrees/…). */
	readonly where?: string;
	/** What the checkout's setup did: "setup: npm ci (done, 41 s)". */
	readonly setup?: string;
	readonly rows: readonly { readonly tool: FlowTool; readonly name: string; readonly state: 'running' | 'done' | 'problem' | 'off'; readonly detail: string; readonly pill?: FlowPill }[];
	readonly findings: readonly (CheckFinding & { readonly checked: boolean })[];
	readonly sent?: string;
}

export type TeamFlowView = OpenMrView | MoveTicketView | ReviewView | ChecksView;

export interface TeamFlowState {
	readonly view?: TeamFlowView;
	/** Shown instead of the view while it loads. */
	readonly loading?: string;
	/** A button's work in progress, such as "Pushing the branch…"; disables the actions. */
	readonly busy?: string;
	readonly error?: string;
}

export type ToTeamFlow =
	| { readonly type: 'state'; readonly state: TeamFlowState }
	/** Branches found by searching GitLab, for the open target menu; the page isn't re-rendered. */
	| { readonly type: 'branches'; readonly branches: readonly TargetChoice[] };

export type FromTeamFlow =
	| { readonly type: 'ready' }
	/** A field the user typed in or ticked; the host keeps it and doesn't re-render. */
	| { readonly type: 'set'; readonly field: string; readonly value: unknown }
	| { readonly type: 'act'; readonly action: string; readonly value?: unknown };

export interface TeamFlowStrings {
	readonly close: string;
	readonly cancel: string;
	readonly back: string;
	readonly openIn: string;
	readonly openMr: string;
	readonly title: string;
	readonly description: string;
	readonly regenerate: string;
	readonly generating: string;
	readonly descriptionHint: string;
	readonly attachments: string;
	readonly attachmentsHint: string;
	readonly addFile: string;
	readonly updateJira: string;
	readonly updateJiraHint: string;
	readonly deleteBranch: string;
	readonly draft: string;
	readonly reviewers: string;
	readonly addReviewer: string;
	readonly searchPeople: string;
	readonly noPeople: string;
	readonly pushesAs: string;
	readonly existingMr: string;
	readonly moveTicket: string;
	readonly moveTo: string;
	readonly noMoves: string;
	readonly fieldNeeded: string;
	readonly choose: string;
	readonly comment: string;
	readonly addComment: string;
	readonly commentHint: string;
	readonly visibleTo: string;
	readonly everyone: string;
	readonly move: string;
	readonly moveAndLog: string;
	readonly logTime: string;
	readonly logTimeHint: string;
	readonly timeSpent: string;
	readonly timeSpentPlaceholder: string;
	readonly badTime: string;
	readonly date: string;
	readonly workComment: string;
	readonly logIt: string;
	readonly reviewTitle: string;
	readonly reviewing: string;
	readonly preparing: string;
	readonly unparsed: string;
	readonly readAgain: string;
	readonly geminiReview: string;
	readonly openDiff: string;
	readonly yourReview: string;
	/** "Ticked: {0} from Gemini · {1} from you · {2} in threads" */
	readonly yourReviewHint: string;
	readonly postOne: string;
	readonly postMany: string;
	readonly postAndRequestOne: string;
	readonly postAndRequestMany: string;
	readonly postAndApproveOne: string;
	readonly postAndApproveMany: string;
	readonly approve: string;
	readonly approved: string;
	readonly you: string;
	readonly addReviewComment: string;
	readonly deleteComment: string;
	readonly generalComment: string;
	readonly lineChanged: string;
	readonly lineChangedHint: string;
	readonly addSuggestion: string;
	readonly removeSuggestion: string;
	readonly askSuggestion: string;
	readonly askSuggestionAgain: string;
	readonly suggesting: string;
	readonly includeSuggestion: string;
	readonly byGemini: string;
	readonly suggestionHint: string;
	readonly threads: string;
	/** "Open: {0} · Resolved: {1}" */
	readonly threadCounts: string;
	readonly outdated: string;
	readonly removedLine: string;
	readonly reply: string;
	readonly resolve: string;
	readonly resolveThread: string;
	readonly yourReply: string;
	readonly geminiReply: string;
	readonly deleteReply: string;
	readonly refresh: string;
	readonly askGeminiAgain: string;
	readonly moreFiles: string;
	readonly files: string;
	readonly noFindings: string;
	readonly kindBug: string;
	readonly kindShouldFix: string;
	readonly kindNit: string;
	readonly kindQuestion: string;
	readonly openAgent: string;
	readonly openReview: string;
	readonly fixMr: string;
	/** On a reviewer agent: "This agent reviews !{0}. …" */
	readonly reviewerBranch: string;
	readonly targetHeading: string;
	readonly searchBranches: string;
	readonly noBranches: string;
	readonly targetSuggested: string;
	readonly targetRecent: string;
	readonly targetRelease: string;
	readonly targetOther: string;
	readonly fixVersion: string;
	readonly projectDefault: string;
	readonly describedFor: string;
	readonly checksTitle: string;
	/** Under the findings when no agent works on the branch: Fix starts one. */
	readonly fixNote: string;
	readonly fix: string;
	readonly fixAll: string;
	readonly fixChosen: string;
	readonly fixAllNew: string;
	readonly fixChosenNew: string;
	readonly runAgain: string;
	readonly noIssues: string;
}

/** The team part of the Changes panel (src/host/mrPanel.ts): Open Merge Request and Run Checks, then the agent's open merge request. */
export interface ChangesTeamView {
	readonly openMr?: string;
	readonly runChecks?: string;
	readonly mr?: {
		readonly iid: number;
		/** "!321 Gift message at checkout" */
		readonly heading: string;
		/** "→ release/2026.11" */
		readonly target: string;
		readonly url: string;
		readonly openIn: string;
		readonly rows: readonly {
			readonly tool: FlowTool | 'review';
			readonly label: string;
			readonly detail?: string;
			readonly pill?: FlowPill;
			/** Failed jobs, each with Fix. */
			readonly jobs?: readonly { readonly id: number; readonly name: string; readonly fix: string }[];
			/** Open review threads, each ticked to send. */
			readonly threads?: readonly { readonly id: string; readonly author: string; readonly text: string }[];
			readonly note?: string;
		}[];
		/** "Fix Pipeline and 2 Comments" */
		readonly fixAll?: { readonly label: string; readonly one: string; readonly pipelineOnly: string; readonly commentsOnly: string };
		/** The merge checks GitLab reports, read live, the options, the request it will make, and the Merge button, on only when every check holds. */
		readonly merge?: {
			readonly heading: string;
			/** "read live 12 s ago" */
			readonly readAt: string;
			/** pending: waiting on GitLab, such as a pipeline still running. */
			readonly checks: readonly { readonly name: string; readonly state: 'ok' | 'missing' | 'pending'; readonly detail: string; readonly source: string }[];
			readonly ready: boolean;
			readonly squash: { readonly label: string; readonly on: boolean };
			readonly removeSourceBranch: { readonly label: string; readonly on: boolean };
			/** Offered when the merge request names a ticket. */
			readonly moveTicket?: { readonly label: string; readonly on: boolean; readonly key: string };
			/** What the merge sends: the path and the head it was read at. */
			readonly request: { readonly path: string; readonly sha: string };
			readonly button: string;
			readonly note: string;
		};
	};
}

export type FromChangesTeam =
	| { readonly type: 'team'; readonly action: 'openMr' | 'runChecks' | 'openUrl' }
	| { readonly type: 'team'; readonly action: 'merge'; readonly squash: boolean; readonly removeSourceBranch: boolean; readonly moveTicket: boolean }
	| { readonly type: 'team'; readonly action: 'fixJob'; readonly job: number }
	| { readonly type: 'team'; readonly action: 'fixMr'; readonly jobs: boolean; readonly threads: readonly string[] };

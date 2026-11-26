/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The messages between Plan Review (planReviewPage.ts) and its page
// (webview-src/planReview.ts).

import type { PlanComment } from '../acp/planReview';

export interface PlanView {
	/** The plan's first heading, else its file's name. */
	readonly title: string;
	/** The plan file's name, as the header shows it. */
	readonly file: string;
	/** The agent that wrote it. */
	readonly agent: string;
	readonly markdown: string;
	readonly comments: readonly PlanComment[];
	/** Sections the user edited here. */
	readonly edited: readonly string[];
	/** The agent is revising the plan from the comments sent. */
	readonly revising: boolean;
	/** Sections the agent's last revision changed, until the next send. */
	readonly changed: readonly string[];
	/** The plan file isn't there (moved or deleted). */
	readonly missing: boolean;
	/** The agent is in a turn: Build waits for it, and so does editing. */
	readonly busy: boolean;
	/** Approve Plan is offered: the agent's latest turn ended in Plan mode. */
	readonly canBuild: boolean;
}

export type ToPlan =
	| { readonly type: 'view'; readonly view: PlanView }
	| { readonly type: 'saved' }
	/** `text`: an edit that couldn't be saved, shown so it isn't lost. */
	| { readonly type: 'error'; readonly message: string; readonly text?: string }
	/** The section changed in the file since the user began editing it (`theirs` is it now): `mine` wasn't saved. */
	| { readonly type: 'conflict'; readonly section: string; readonly mine: string; readonly theirs: string };

export type FromPlan =
	| { readonly type: 'ready' }
	/** `original`: the section as it was when editing began; the save is refused when the file's differs. */
	| { readonly type: 'saveSection'; readonly section: string; readonly markdown: string; readonly original: string }
	| { readonly type: 'addComment'; readonly section: string; readonly quote: string; readonly text: string }
	| { readonly type: 'editComment'; readonly id: string; readonly text: string }
	| { readonly type: 'deleteComment'; readonly id: string }
	| { readonly type: 'send' }
	| { readonly type: 'build' }
	| { readonly type: 'showChanges' }
	| { readonly type: 'clearSent' }
	| { readonly type: 'openSource' };

export interface PlanStrings {
	/** `{0}` is the agent's title. */
	readonly from: string;
	readonly saved: string;
	readonly saving: string;
	/** `{0}` is how many sections the user edited. */
	readonly editedOne: string;
	readonly editedMany: string;
	readonly commentsOne: string;
	readonly commentsMany: string;
	readonly commentsHead: string;
	/** `{0}` is how many comments wait to be sent. */
	readonly toSend: string;
	readonly allSent: string;
	readonly onSection: string;
	readonly sent: string;
	readonly addTip: string;
	readonly comment: string;
	readonly commentPlaceholder: string;
	readonly addComment: string;
	readonly addHint: string;
	readonly cancel: string;
	readonly edit: string;
	readonly delete: string;
	readonly save: string;
	readonly editHint: string;
	readonly editTip: string;
	/** Why sections can't be edited while the agent works. */
	readonly editBusy: string;
	readonly conflict: string;
	readonly showNew: string;
	readonly hideNew: string;
	readonly copyText: string;
	readonly showSection: string;
	readonly changedTag: string;
	readonly foot: string;
	readonly build: string;
	readonly buildShort: string;
	readonly buildBusy: string;
	readonly send: string;
	readonly sendShort: string;
	readonly revising: string;
	/** `{0}` is how many sections changed. */
	readonly revisedOne: string;
	readonly revisedMany: string;
	readonly revisedNone: string;
	readonly showChanges: string;
	readonly clearSent: string;
	readonly openSource: string;
	readonly empty: string;
	readonly missing: string;
}

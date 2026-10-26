/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Messages between the Review Page (confluenceReviewPage.ts) and its webview (webview-src/confluenceReview.ts).

import type { AdfDocument } from '../acp/confluence';
import type { DraftReview } from '../acp/draftReview';

export interface ReviewView {
	readonly id: string;
	readonly title: string;
	/** A new page, or a new version of `url`. */
	readonly kind: 'new' | 'edit';
	/** Where it goes, as the breadcrumb shows it: site, space, parent page. */
	readonly where: readonly string[];
	/** The page's link, for an edit. */
	readonly url?: string;
	/** For an edit: the version the draft was made from, its author's name when known, and the page as it is in that version. */
	readonly baseVersion?: number;
	readonly base?: AdfDocument;
	/** What the agent wrote, until the user saves their own edit. */
	readonly markdown?: string;
	readonly saved?: AdfDocument;
	/** The user's decisions so far. */
	readonly review?: DraftReview;
	readonly createdAt: string;
}

/** What a part the Review Page's editor can't change shows when it has no text of its own (webview-src/adfHtml.ts). */
export interface OpaqueLabels {
	readonly someone: string;
	readonly link: string;
	readonly date: string;
	readonly macro: string;
	readonly media: string;
	readonly other: string;
}

export interface ReviewStrings {
	readonly newPage: string;
	readonly newVersion: string;
	/** `{0}` the time the agent drafted it. */
	readonly draftedAt: string;
	readonly titleLabel: string;
	readonly pageNow: string;
	readonly withChanges: string;
	readonly changesOnly: string;
	readonly edit: string;
	/** `{0}` the version. */
	readonly editNote: string;
	readonly keep: string;
	readonly undo: string;
	readonly keepAll: string;
	readonly undoAll: string;
	/** `{0}` this change's number, `{1}` how many. */
	readonly changeOf: string;
	readonly noChanges: string;
	readonly bold: string;
	readonly italic: string;
	readonly strike: string;
	readonly code: string;
	readonly paragraph: string;
	readonly heading1: string;
	readonly heading2: string;
	readonly heading3: string;
	readonly bulletList: string;
	readonly numberedList: string;
	readonly link: string;
	readonly linkPrompt: string;
	readonly readOnlyBlock: string;
	/** `{0}` what the part is, as it shows. */
	readonly readOnlyLabel: string;
	/** A part of the page the draft would have removed, put back; `{0}` what it holds that the agent can't write. */
	readonly held: string;
	/** Above the agent's version of a part put back; `{0}` what using it drops. */
	readonly agentVersion: string;
	readonly usePage: string;
	readonly useAgent: string;
	/** What the agent can't write, by kind (`draftReview.ts`'s `lostKinds`), and `other`. */
	readonly kinds: Readonly<Record<string, string>>;
	/** What a part the editor can't change shows when it has no text of its own. */
	readonly opaque: OpaqueLabels;
	/** `{0}` how many changes are left to keep or undo. */
	readonly decideFirst: string;
	readonly footNew: string;
	/** `{0}` the version publishing makes. */
	readonly footEdit: string;
	readonly discard: string;
	readonly save: string;
	readonly saved: string;
	readonly publishNew: string;
	readonly publishEdit: string;
	readonly publishing: string;
	readonly openInConfluence: string;
	/** `{0}` the version someone saved since the draft. */
	readonly conflictTitle: string;
	readonly conflictText: string;
	/** `{0}` how many places. */
	readonly conflictPlaces: string;
	readonly keepTheirs: string;
	readonly keepMine: string;
	readonly theirs: string;
	readonly mine: string;
	readonly publishedTitle: string;
	/** `{0}` the version. */
	readonly publishedText: string;
}

export type ToReview =
	| { readonly type: 'view'; readonly view: ReviewView }
	| { readonly type: 'saved' }
	| { readonly type: 'published'; readonly url: string; readonly version: number }
	/** Someone saved the page since the draft: `theirs` is the latest version, to merge the draft onto. */
	| { readonly type: 'conflict'; readonly theirs: AdfDocument; readonly version: number }
	| { readonly type: 'error'; readonly message: string };

export type FromReview =
	| { readonly type: 'ready' }
	| { readonly type: 'save'; readonly title: string; readonly document: AdfDocument; readonly review: DraftReview }
	/** Publishes the draft as saved with this: for a new version, only the changes `review` keeps. */
	| { readonly type: 'publish'; readonly title: string; readonly document: AdfDocument; readonly review: DraftReview }
	/** The draft merged onto the latest version: it is now made from `version`, whose page is `base`. */
	| { readonly type: 'rebase'; readonly title: string; readonly document: AdfDocument; readonly review: DraftReview; readonly version: number; readonly base: AdfDocument }
	| { readonly type: 'discard' }
	| { readonly type: 'open'; readonly url: string };

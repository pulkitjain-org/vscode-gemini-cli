/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Review Page: a Confluence page an agent drafted, edited in place as it
// will look, before anything is published. For a new version of a page it
// opens on the page as it is now with the draft's changes marked, each kept
// or undone. Publishing asks the team tools' audited write; when someone
// saved the page meanwhile, the page shows their version merged with the
// draft and asks only where both changed the same place.

import * as vscode from 'vscode';
import { ConfluenceConflictError, type AdfDocument } from '../acp/confluence';
import type { ConfluenceDraft } from '../acp/confluenceDrafts';
import type { DraftReview } from '../acp/draftReview';
import { hostOf } from '../acp/teamHttp';
import type { TeamWriteResult } from '../acp/teamTools';
import type { FromReview, ReviewStrings, ReviewView, ToReview } from './confluenceReviewProtocol';
import { PagePanel, PageShell } from './pagePanel';

export interface ReviewActions {
	/** The draft as it is kept now. */
	load(): Promise<ConfluenceDraft | undefined>;
	save(title: string, document: AdfDocument, review: DraftReview): Promise<void>;
	publish(title: string, document: AdfDocument, review: DraftReview): Promise<TeamWriteResult>;
	rebase(title: string, document: AdfDocument, review: DraftReview, version: number, base: AdfDocument): Promise<void>;
	discard(): Promise<void>;
	/** Opens a page on the draft's Confluence site, as Home opens team links. */
	open(url: string): Promise<void>;
}

export class ConfluenceReviewPage implements vscode.Disposable {

	private readonly page: PagePanel<ToReview, FromReview>;
	readonly onDidDispose: vscode.Event<void>;

	constructor(extensionUri: vscode.Uri, private draft: ConfluenceDraft, column: vscode.ViewColumn, private readonly actions: ReviewActions) {
		const media = vscode.Uri.joinPath(extensionUri, 'media');
		this.page = new PagePanel<ToReview, FromReview>(extensionUri, { viewType: 'gemini.confluenceReview', title: vscode.l10n.t("Review Page: {0}", draft.title), icon: vscode.Uri.joinPath(media, 'tools', 'confluence.svg'), column, retainContextWhenHidden: true }, this.shell(), message => this.onMessage(message));
		this.onDidDispose = this.page.onDidDispose;
	}

	reveal(): void {
		this.page.reveal();
	}

	dispose(): void {
		this.page.dispose();
	}

	/** Someone saved the page since the draft: the webview merges the draft onto `theirs`. */
	conflict(theirs: AdfDocument, version: number): void {
		this.post({ type: 'conflict', theirs, version });
	}

	private post(message: ToReview): void {
		this.page.post(message);
	}

	private view(): ReviewView {
		const draft = this.draft;
		const target = draft.target;
		const where = target.kind === 'new'
			? [hostOf(draft.site), target.spaceName ? `${target.spaceName} (${target.spaceKey})` : target.spaceKey, ...target.parentTitle ? [target.parentTitle] : []]
			: [hostOf(draft.site), ...target.spaceKey ? [target.spaceKey] : [], target.baseTitle];
		return {
			id: draft.id,
			title: draft.title,
			kind: target.kind,
			where,
			...target.kind === 'edit' ? { url: target.url, baseVersion: target.baseVersion, base: target.base } : {},
			...draft.saved ? { saved: draft.saved } : { markdown: draft.markdown },
			...draft.review ? { review: draft.review } : {},
			createdAt: draft.createdAt,
		};
	}

	private async onMessage(message: FromReview): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					// The draft as kept now, not as it was when the page opened: a reload shows the latest edits.
					this.draft = await this.actions.load() ?? this.draft;
					this.post({ type: 'view', view: this.view() });
					return;
				case 'save':
					await this.actions.save(message.title, message.document, message.review);
					this.post({ type: 'saved' });
					return;
				case 'rebase':
					await this.actions.rebase(message.title, message.document, message.review, message.version, message.base);
					this.post({ type: 'saved' });
					return;
				case 'publish': {
					const result = await this.actions.publish(message.title, message.document, message.review);
					if (result.ok) {
						this.post({ type: 'published', url: String(result.data?.url ?? ''), version: Number(result.data?.version ?? 1) });
						this.page.panel.title = vscode.l10n.t("Published: {0}", message.title);
					} else if (!result.data?.conflict) {
						// A conflict was sent to the page by the feature, with the latest version.
						this.post({ type: 'error', message: result.text });
					}
					return;
				}
				case 'discard': {
					const discard = vscode.l10n.t("Discard Draft");
					if (await vscode.window.showWarningMessage(vscode.l10n.t("Discard the draft of {0}?", this.draft.title), { modal: true, detail: vscode.l10n.t("Nothing was published. The draft and your edits are deleted.") }, discard) === discard) {
						await this.actions.discard();
						this.page.dispose();
					}
					return;
				}
				case 'open':
					if (/^https:\/\//i.test(message.url) && hostOf(message.url) === hostOf(this.draft.site)) {
						await this.actions.open(message.url);
					}
					return;
			}
		} catch (err) {
			this.post({ type: 'error', message: confluenceErrorText(err) });
		}
	}

	private shell(): PageShell {
		// The Markdown renderer is a chunk of its own (media/draftMarkdown.js), loaded by the page's script.
		return { script: 'confluenceReview.js', styles: ['confluenceReview.css'], title: this.draft.title, bodyClass: 'review-page', strings: reviewStrings(), media: { 'draft-markdown': 'draftMarkdown.js' }, loadsMedia: true };
	}
}

/** What the user reads for a failure on the Review Page: a conflict or a refused page in their words, else the failure's own message. */
export function confluenceErrorText(err: unknown): string {
	if (err instanceof ConfluenceConflictError) {
		return vscode.l10n.t("The page changed since the draft was made: version {0} is the latest.", err.current.version);
	}
	// By its status, not its class: the request is the extension bundle's, whose errors are its own copy of `TeamToolError`.
	if ((err as { status?: unknown } | undefined)?.status === 400) {
		return vscode.l10n.t("Confluence refused the page as it is. Remove anything unusual in it, such as a heading inside a list, and publish again. ({0})", (err as Error).message);
	}
	return err instanceof Error ? err.message : String(err);
}

/** The Review Page's strings, in the user's language. */
export function reviewStrings(): ReviewStrings {
	return {
		newPage: vscode.l10n.t("New page, not published"),
		newVersion: vscode.l10n.t("Draft edit, not published"),
		draftedAt: vscode.l10n.t("Drafted by an agent at {0}"),
		titleLabel: vscode.l10n.t("Title"),
		pageNow: vscode.l10n.t("Page as It Is Now"),
		withChanges: vscode.l10n.t("With Changes Marked"),
		changesOnly: vscode.l10n.t("Changes Only"),
		edit: vscode.l10n.t("Edit"),
		editNote: vscode.l10n.t("This is the page as it is in Confluence now, version {0}, with the agent's changes marked. Keep or undo each change, then edit anything in Edit."),
		keep: vscode.l10n.t("Keep"),
		undo: vscode.l10n.t("Undo"),
		keepAll: vscode.l10n.t("Keep All"),
		undoAll: vscode.l10n.t("Undo All"),
		changeOf: vscode.l10n.t("Change {0} of {1}"),
		noChanges: vscode.l10n.t("The draft doesn't change the page."),
		bold: vscode.l10n.t("Bold"),
		italic: vscode.l10n.t("Italic"),
		strike: vscode.l10n.t("Strikethrough"),
		code: vscode.l10n.t("Code"),
		paragraph: vscode.l10n.t("Text"),
		heading1: vscode.l10n.t("Heading 1"),
		heading2: vscode.l10n.t("Heading 2"),
		heading3: vscode.l10n.t("Heading 3"),
		bulletList: vscode.l10n.t("Bulleted List"),
		numberedList: vscode.l10n.t("Numbered List"),
		link: vscode.l10n.t("Link"),
		linkPrompt: vscode.l10n.t("Link address"),
		readOnlyBlock: vscode.l10n.t("Kept as it is: the editor can't change this."),
		readOnlyLabel: vscode.l10n.t("{0}, kept as it is: the editor can't change this"),
		held: vscode.l10n.t("Kept as it is on the page: the agent's draft removed or rewrote this part, which holds what the agent can't write ({0}). Delete it in Edit if you mean to."),
		agentVersion: vscode.l10n.t("The agent's version of the part above. Using it drops what the agent can't write ({0})."),
		usePage: vscode.l10n.t("Keep the Page's Version"),
		useAgent: vscode.l10n.t("Use the Agent's Version"),
		kinds: {
			mention: vscode.l10n.t("mentions"),
			extension: vscode.l10n.t("macros"),
			table: vscode.l10n.t("tables"),
			media: vscode.l10n.t("images and files"),
			annotation: vscode.l10n.t("inline comments"),
			textColor: vscode.l10n.t("colours"),
			status: vscode.l10n.t("status lozenges"),
			date: vscode.l10n.t("dates"),
			emoji: vscode.l10n.t("emoji"),
			inlineCard: vscode.l10n.t("smart links"),
			panel: vscode.l10n.t("panels"),
			other: vscode.l10n.t("other formatting"),
		},
		opaque: {
			someone: vscode.l10n.t("@someone"),
			link: vscode.l10n.t("Link"),
			date: vscode.l10n.t("Date"),
			macro: vscode.l10n.t("Macro"),
			media: vscode.l10n.t("Image or file"),
			other: vscode.l10n.t("Confluence content"),
		},
		decideFirst: vscode.l10n.t("Keep or undo each change before publishing: {0} left."),
		footNew: vscode.l10n.t("Edit the page as it will look. Only you see this draft; publishing is recorded in the audit log."),
		footEdit: vscode.l10n.t("Publishing makes version {0}: the page as it is now, with only the changes you kept and your own edits. If someone saves first, you'll see their change before anything is written."),
		discard: vscode.l10n.t("Discard Draft"),
		save: vscode.l10n.t("Save Draft"),
		saved: vscode.l10n.t("Saved"),
		publishNew: vscode.l10n.t("Publish to Confluence"),
		publishEdit: vscode.l10n.t("Publish Changes"),
		publishing: vscode.l10n.t("Publishing…"),
		openInConfluence: vscode.l10n.t("Open in Confluence"),
		conflictTitle: vscode.l10n.t("The page changed since this draft was made: version {0} is the latest"),
		conflictText: vscode.l10n.t("Nothing was published. Your draft is now combined with the latest version; where only one side changed a part, that change is kept."),
		conflictPlaces: vscode.l10n.t("Pick a version for each part you both changed ({0}), then publish."),
		keepTheirs: vscode.l10n.t("Keep Theirs"),
		keepMine: vscode.l10n.t("Keep Mine"),
		theirs: vscode.l10n.t("Latest version"),
		mine: vscode.l10n.t("Your draft"),
		publishedTitle: vscode.l10n.t("Published"),
		publishedText: vscode.l10n.t("Version {0} is on Confluence."),
	};
}

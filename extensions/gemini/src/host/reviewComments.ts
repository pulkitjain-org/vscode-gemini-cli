/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { showError } from './errorNotice';

export const reviewControllerId = 'gemini.review';

/** A thread in a review's diff: one of the draft's comments, or one of the merge request's threads. */
export interface DiffThread {
	/** `c:` and the draft comment's id, or `g:` and the discussion's id. */
	readonly id: string;
	readonly uri: vscode.Uri;
	/** Lines of the new version. */
	readonly line: number;
	readonly endLine?: number;
	readonly kind: 'draft' | 'gitlab';
	readonly resolved?: boolean;
	readonly label?: string;
	readonly comments: readonly DiffComment[];
}

export interface DiffComment {
	/** The draft comment's or reply's id; a GitLab note's number as text. */
	readonly id: string;
	readonly author: string;
	readonly label?: string;
	readonly body: string;
	/** The text to edit, for the draft's own comments and replies. */
	readonly editText?: string;
	/** Whether Gemini can be asked to suggest a change for it. */
	readonly askable?: boolean;
	readonly timestamp?: Date;
}

/** What a review does when the user acts in its diff. */
export interface ReviewDiffHost {
	/** The new version's line ranges a comment can go on, for a document of the review. */
	commentable(uri: vscode.Uri): readonly { readonly start: number; readonly end: number }[] | undefined;
	/** Adds the user's comment on lines `line` to `endLine`; with `suggest`, a suggestion filled with those lines. Resolves with the new comment's id. */
	add(uri: vscode.Uri, line: number, endLine: number, text: string, suggest: boolean): Promise<string | undefined>;
	reply(discussion: string, text: string, resolve: boolean): void;
	edit(id: string, text: string): void;
	remove(id: string): void;
	askSuggestion(id: string): Promise<void>;
	openPage(): void;
}

class ReviewComment implements vscode.Comment {
	mode = vscode.CommentMode.Preview;
	body: string | vscode.MarkdownString;
	readonly author: vscode.CommentAuthorInformation;
	readonly label?: string;
	readonly contextValue?: string;
	readonly timestamp?: Date;

	constructor(readonly review: string, readonly draftId: string | undefined, readonly source: DiffComment) {
		this.body = new vscode.MarkdownString(source.body);
		this.author = { name: source.author };
		this.label = source.label;
		this.timestamp = source.timestamp;
		this.contextValue = source.editText === undefined ? undefined : source.askable ? 'draft askable' : 'draft';
	}
}

/**
 * The review's comments in the diff editor (comment controller
 * `gemini.review`): the draft's comments and the merge request's threads on
 * their lines, the gutter "+" on the lines a comment can go on, and the
 * commands that add, reply, edit, delete and ask Gemini to suggest a change.
 * Each review's threads are replaced as a whole when its draft changes.
 */
export class ReviewComments implements vscode.Disposable {

	private readonly controller: vscode.CommentController;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly hosts = new Map<string, ReviewDiffHost>();
	private readonly threads = new Map<string, Map<string, vscode.CommentThread>>();

	constructor() {
		this.controller = vscode.comments.createCommentController(reviewControllerId, vscode.l10n.t("Merge Request Review"));
		this.controller.options = { prompt: vscode.l10n.t("Write a comment or reply, for your review"), placeHolder: vscode.l10n.t("Posted when you post your review. A ```suggestion block suggests a change.") };
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: document => {
				for (const host of this.hosts.values()) {
					const ranges = host.commentable(document.uri);
					if (ranges) {
						return ranges.map(r => new vscode.Range(r.start - 1, 0, r.end - 1, 0));
					}
				}
				return [];
			},
		};
		const run = (id: string, handler: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, (...args: never[]) => {
			try {
				return Promise.resolve(handler(...args)).catch(err => void showError(errorMessage(err)));
			} catch (err) {
				void showError(errorMessage(err));
				return undefined;
			}
		});
		this.disposables.push(
			this.controller,
			run('gemini.mrReview.addComment', (reply: vscode.CommentReply) => this.add(reply, false)),
			run('gemini.mrReview.addSuggestion', (reply: vscode.CommentReply) => this.add(reply, true)),
			run('gemini.mrReview.reply', (reply: vscode.CommentReply) => this.reply(reply, false)),
			run('gemini.mrReview.replyResolve', (reply: vscode.CommentReply) => this.reply(reply, true)),
			run('gemini.mrReview.resolve', (thread: vscode.CommentThread) => this.resolve(thread)),
			run('gemini.mrReview.editComment', (comment: ReviewComment) => this.startEdit(comment)),
			run('gemini.mrReview.saveComment', (comment: ReviewComment) => this.save(comment)),
			run('gemini.mrReview.cancelEdit', (comment: ReviewComment) => this.cancel(comment)),
			run('gemini.mrReview.deleteComment', (comment: ReviewComment) => comment.draftId ? this.hosts.get(comment.review)?.remove(comment.draftId) : undefined),
			run('gemini.mrReview.askSuggestion', (comment: ReviewComment) => comment.draftId ? this.hosts.get(comment.review)?.askSuggestion(comment.draftId) : undefined),
			run('gemini.mrReview.openPage', (thread?: vscode.CommentThread) => this.hostOf(thread)?.openPage()),
		);
	}

	/** Shows review `key`'s threads, replacing the ones shown before; `host` answers what the user does in its diffs. */
	show(key: string, host: ReviewDiffHost, threads: readonly DiffThread[]): void {
		this.hosts.set(key, host);
		const shown = this.threads.get(key) ?? new Map<string, vscode.CommentThread>();
		this.threads.set(key, shown);
		const wanted = new Set(threads.map(t => t.id));
		for (const [id, thread] of shown) {
			if (!wanted.has(id)) {
				thread.dispose();
				shown.delete(id);
			}
		}
		for (const t of threads) {
			const range = new vscode.Range(t.line - 1, 0, (t.endLine ?? t.line) - 1, 0);
			const comments = t.comments.map(c => new ReviewComment(key, c.editText === undefined ? undefined : c.id, c));
			let thread = shown.get(t.id);
			if (thread && thread.uri.toString() !== t.uri.toString()) {
				thread.dispose();
				thread = undefined;
			}
			if (!thread) {
				thread = this.controller.createCommentThread(t.uri, range, comments);
				thread.collapsibleState = t.resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
				shown.set(t.id, thread);
			} else {
				// A comment being edited keeps its box until it is saved or cancelled.
				if (!thread.comments.some(c => c.mode === vscode.CommentMode.Editing)) {
					thread.comments = comments;
				}
				thread.range = range;
			}
			thread.label = t.label;
			thread.canReply = t.kind === 'gitlab' && !t.resolved;
			thread.contextValue = t.kind === 'gitlab' ? (t.resolved ? 'gitlab resolved' : 'gitlab') : 'draft';
			thread.state = t.kind === 'gitlab' ? (t.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved) : undefined;
		}
	}

	/** Removes review `key`'s threads; its diffs then take no comments. */
	hide(key: string): void {
		for (const thread of this.threads.get(key)?.values() ?? []) {
			thread.dispose();
		}
		this.threads.delete(key);
		this.hosts.delete(key);
	}

	/** Puts the draft comment `id` of review `key` in its edit box, as Suggest Change does once the comment is added. */
	editDraft(key: string, id: string): void {
		const comment = [...this.threads.get(key)?.values() ?? []].flatMap(t => t.comments).find((c): c is ReviewComment => c instanceof ReviewComment && c.draftId === id);
		if (comment) {
			this.startEdit(comment);
		}
	}

	dispose(): void {
		for (const key of [...this.threads.keys()]) {
			this.hide(key);
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private keyOf(thread: vscode.CommentThread | undefined): string | undefined {
		for (const [key, shown] of this.threads) {
			if (thread && [...shown.values()].includes(thread)) {
				return key;
			}
		}
		return undefined;
	}

	private hostOf(thread: vscode.CommentThread | undefined): ReviewDiffHost | undefined {
		const key = this.keyOf(thread);
		if (key) {
			return this.hosts.get(key);
		}
		// A new thread the gutter "+" made isn't ours yet: find the review by its document.
		return thread ? [...this.hosts.values()].find(h => h.commentable(thread.uri)) : undefined;
	}

	private async add(reply: vscode.CommentReply, suggest: boolean): Promise<void> {
		const host = this.hostOf(reply.thread);
		const range = reply.thread.range;
		if (!host || !range) {
			return;
		}
		const key = [...this.hosts].find(([, h]) => h === host)?.[0];
		const id = await host.add(reply.thread.uri, range.start.line + 1, range.end.line + 1, reply.text, suggest);
		// The draft's own thread replaces the one the "+" made.
		reply.thread.dispose();
		if (suggest && id && key) {
			this.editDraft(key, id);
		}
	}

	private reply(reply: vscode.CommentReply, resolve: boolean): void {
		const key = this.keyOf(reply.thread);
		const discussion = key && [...this.threads.get(key)!].find(([, t]) => t === reply.thread)?.[0];
		if (!key || !discussion?.startsWith('g:') || (!reply.text.trim() && !resolve)) {
			return;
		}
		this.hosts.get(key)?.reply(discussion.slice(2), reply.text, resolve);
	}

	private resolve(thread: vscode.CommentThread): void {
		const key = this.keyOf(thread);
		const discussion = key && [...this.threads.get(key)!].find(([, t]) => t === thread)?.[0];
		if (key && discussion?.startsWith('g:')) {
			this.hosts.get(key)?.reply(discussion.slice(2), '', true);
		}
	}

	private threadOf(comment: ReviewComment): vscode.CommentThread | undefined {
		return [...this.threads.get(comment.review)?.values() ?? []].find(t => t.comments.includes(comment));
	}

	private startEdit(comment: ReviewComment): void {
		const thread = this.threadOf(comment);
		if (!thread || comment.source.editText === undefined) {
			return;
		}
		thread.comments = thread.comments.map(c => {
			if (c === comment) {
				comment.body = new vscode.MarkdownString(comment.source.editText);
				comment.mode = vscode.CommentMode.Editing;
			}
			return c;
		});
	}

	private save(comment: ReviewComment): void {
		const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
		comment.mode = vscode.CommentMode.Preview;
		const thread = this.threadOf(comment);
		if (thread) {
			// Out of edit mode first, so the host's redraw replaces it.
			thread.comments = [...thread.comments];
		}
		if (comment.draftId) {
			this.hosts.get(comment.review)?.edit(comment.draftId, text);
		}
	}

	private cancel(comment: ReviewComment): void {
		comment.body = new vscode.MarkdownString(comment.source.body);
		comment.mode = vscode.CommentMode.Preview;
		const thread = this.threadOf(comment);
		if (thread) {
			thread.comments = [...thread.comments];
		}
	}
}

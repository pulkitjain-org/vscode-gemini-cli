/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { SavedReview } from '../acp/reviewStore';
import { draftCounts } from '../acp/reviewDraft';
import { ReviewComments } from './reviewComments';
import { ReviewDiffs } from './reviewDiffs';
import { newReview, ReviewDeps, reviewKey, ReviewSession } from './reviewSession';

/** How long after a review changes Home and the chat hear of it. */
const changedDelayMs = 400;

/** A review in progress, as Home, the reviewer's chat and the Command Palette show it. */
export interface ReviewInProgress {
	readonly project: string;
	readonly iid: number;
	readonly title: string;
	readonly agentId?: string;
	/** Comments and replies in the draft. */
	readonly comments: number;
	readonly updatedAt: string;
	/** The folder of the clone it reads from. */
	readonly repository: string;
}

/**
 * The merge request reviews in progress: one ReviewSession per review that
 * is open (its page, or its threads in the diffs), and the saved ones, which
 * reopen where they were left. Home, the reviewer agent's chat and the
 * Command Palette read `inProgress` and open a review with `open`.
 */
export class Reviews implements vscode.Disposable {

	readonly diffs = new ReviewDiffs();
	readonly comments = new ReviewComments();
	private readonly sessions = new Map<string, ReviewSession>();
	/** Each review being opened, so a double click opens it once. */
	private readonly opening = new Map<string, Promise<void>>();
	/** The reviewer agents of reviews posted or discarded in this window, for Remove Reviewer and Checkout. */
	private readonly endedReviewers = new Map<string, string>();
	private saved: readonly SavedReview[] = [];
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	/** A review started, changed, was posted or discarded. */
	readonly onDidChange = this.onDidChangeEmitter.event;
	private changedTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [this.diffs, this.comments, this.onDidChangeEmitter];
	private readonly deps: ReviewDeps;

	constructor(deps: Omit<ReviewDeps, 'diffs' | 'comments' | 'changed' | 'ended' | 'removeReviewer'>) {
		this.deps = {
			...deps,
			diffs: this.diffs,
			comments: this.comments,
			changed: () => this.changed(),
			ended: session => this.forget(session),
			removeReviewer: async session => {
				const { project, iid } = session.review;
				this.forget(session);
				if (await this.removeReviewer(project, iid)) {
					void vscode.window.showInformationMessage(vscode.l10n.t("Removed the reviewer of !{0} and its checkout.", iid));
				}
			},
		};
		this.disposables.push(deps.agents.onDidChangeAgents(() => {
			// A reviewer removed: its review offers Ask Gemini Again.
			for (const session of this.sessions.values()) {
				session.render();
			}
		}));
		void this.reload();
	}

	/** The reviews in progress, the last changed first. */
	get inProgress(): readonly ReviewInProgress[] {
		const live = new Map([...this.sessions.values()].map(s => [s.key, s]));
		const reviews = this.saved.map(r => live.get(reviewKey(r.project, r.iid))?.review ?? r);
		return reviews.map(r => {
			const counts = draftCounts(live.get(reviewKey(r.project, r.iid))?.draft ?? r.draft);
			return {
				project: r.project, iid: r.iid, title: r.title, comments: counts.comments + counts.replies, updatedAt: r.updatedAt, repository: r.repository,
				...r.agentId ? { agentId: r.agentId } : {},
			};
		});
	}

	/** The review agent `agentId` works on, when it is a reviewer. */
	forAgent(agentId: string): ReviewInProgress | undefined {
		return this.inProgress.find(r => r.agentId === agentId);
	}

	/** The review of merge request `iid` in progress, if any. */
	find(project: string, iid: number): ReviewInProgress | undefined {
		return this.inProgress.find(r => r.project === project && r.iid === iid);
	}

	/**
	 * Opens the review of merge request `iid`: the one in progress where it
	 * was left, else a new one that Gemini starts. `fresh` starts over,
	 * replacing a draft in progress.
	 */
	open(project: string, iid: number, fresh = false): Promise<void> {
		const key = reviewKey(project, iid);
		const pending = this.opening.get(key);
		if (pending) {
			return pending;
		}
		const opening = this.openNow(project, iid, fresh).finally(() => this.opening.delete(key));
		this.opening.set(key, opening);
		return opening;
	}

	/**
	 * The reviewer agent of merge request `iid`'s review, when the review was
	 * posted or discarded in this window and the agent is still there: what
	 * Remove Reviewer and Checkout offers to remove.
	 */
	endedReviewer(project: string, iid: number): string | undefined {
		const agentId = this.endedReviewers.get(reviewKey(project, iid));
		return agentId && this.deps.agents.agentPlace(agentId) ? agentId : undefined;
	}

	/**
	 * Remove Reviewer and Checkout, after Post or Discard: removes the
	 * reviewer agent with its worktree and its review/ branch, which are
	 * GeminiCode's own. Resolves whether there was one to remove.
	 */
	async removeReviewer(project: string, iid: number): Promise<boolean> {
		const key = reviewKey(project, iid);
		const agentId = this.endedReviewer(project, iid);
		this.endedReviewers.delete(key);
		if (!agentId || this.sessions.has(key)) {
			return false;
		}
		await this.deps.agents.removeTeamAgent(agentId, true);
		return true;
	}

	private async openNow(project: string, iid: number, fresh: boolean): Promise<void> {
		const key = reviewKey(project, iid);
		const live = this.sessions.get(key);
		if (live && !fresh) {
			return live.show();
		}
		if (live) {
			this.sessions.delete(key);
			await live.end(true);
		}
		const store = this.deps.tools.reviews;
		const saved = fresh ? undefined : await store.get(project, iid);
		if (fresh) {
			await store.remove(project, iid);
		}
		if (saved) {
			const session = this.add(new ReviewSession(saved, this.deps));
			await session.show();
			try {
				await session.load();
				await session.resume();
			} catch (err) {
				session.fail(err);
			}
			return;
		}
		const gitlab = this.deps.gitlab();
		const mr = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Reading !{0}...", iid) }, () => gitlab.mr(project, iid));
		const clone = await this.deps.cloneOf(project, gitlab);
		if (!clone) {
			throw new Error(vscode.l10n.t("Open a clone of {0} first, so the merge request can be checked out.", project));
		}
		const session = this.add(new ReviewSession(await store.save(newReview(mr, clone)), this.deps));
		this.changed();
		await session.show();
		try {
			await session.load();
			await session.startReviewer();
		} catch (err) {
			session.fail(err);
		}
	}

	/** Throws away the review's draft, after the user confirmed. */
	async discard(project: string, iid: number): Promise<void> {
		const key = reviewKey(project, iid);
		const live = this.sessions.get(key);
		const agentId = live?.agentId ?? this.saved.find(r => r.project === project && r.iid === iid)?.agentId;
		if (agentId) {
			this.endedReviewers.set(key, agentId);
		}
		this.sessions.delete(key);
		if (live) {
			await live.end(true);
		} else {
			await this.deps.tools.reviews.remove(project, iid);
		}
		await this.reload();
		void this.offerRemoveAfterDiscard(project, iid);
	}

	/** After Discard, while the reviewer is still there: Remove Reviewer and Checkout, or Keep for Re-review. */
	private async offerRemoveAfterDiscard(project: string, iid: number): Promise<void> {
		const agentId = this.endedReviewer(project, iid);
		const branch = agentId && this.deps.agents.agentPlace(agentId)?.branch;
		if (!agentId) {
			return;
		}
		const remove = vscode.l10n.t("Remove Reviewer and Checkout");
		const keep = vscode.l10n.t("Keep for Re-review");
		const text = branch
			? vscode.l10n.t("Discarded your review of !{0}. The reviewer agent and its checkout ({1}) are still on this Mac.", iid, branch)
			: vscode.l10n.t("Discarded your review of !{0}. The reviewer agent and its checkout are still on this Mac.", iid);
		if (await vscode.window.showInformationMessage(text, remove, keep) === remove && await this.removeReviewer(project, iid)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Removed the reviewer of !{0} and its checkout.", iid));
		}
	}

	dispose(): void {
		clearTimeout(this.changedTimer);
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.sessions.clear();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private add(session: ReviewSession): ReviewSession {
		this.sessions.set(session.key, session);
		return session;
	}

	private forget(session: ReviewSession): void {
		if (session.agentId) {
			this.endedReviewers.set(session.key, session.agentId);
		}
		if (this.sessions.get(session.key) === session) {
			this.sessions.delete(session.key);
		}
		session.dispose();
		this.changed();
	}

	private changed(): void {
		clearTimeout(this.changedTimer);
		this.changedTimer = setTimeout(() => void this.reload(), changedDelayMs);
	}

	private async reload(): Promise<void> {
		this.saved = await this.deps.tools.reviews.list();
		this.onDidChangeEmitter.fire();
	}
}

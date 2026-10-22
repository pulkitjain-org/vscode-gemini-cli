/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
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
	private saved: readonly SavedReview[] = [];
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	/** A review started, changed, was posted or discarded. */
	readonly onDidChange = this.onDidChangeEmitter.event;
	private changedTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [this.diffs, this.comments, this.onDidChangeEmitter];
	private readonly deps: ReviewDeps;

	constructor(deps: Omit<ReviewDeps, 'diffs' | 'comments' | 'changed' | 'ended'>) {
		this.deps = {
			...deps,
			diffs: this.diffs,
			comments: this.comments,
			changed: () => this.changed(),
			ended: session => this.forget(session),
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
	async open(project: string, iid: number, fresh = false): Promise<void> {
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
		this.sessions.delete(key);
		if (live) {
			await live.end(true);
		} else {
			await this.deps.tools.reviews.remove(project, iid);
		}
		await this.reload();
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

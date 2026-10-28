/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { samePath } from '../acp/fsUtil';
import type { GitLabClient, GitLabDiffFile, GitLabDiscussion, GitLabMr } from '../acp/gitlab';
import { jiraKeyIn } from '../acp/jira';
import { fetchBranches, reviewWorktree } from '../acp/releaseMerge';
import {
	commentableRanges, draftFieldPattern, editableText, fileLabels, foldFields, Hunk, inOneHunk, lineInDiff, mergeFindings, moveDraft, parseHunks,
	postItems, ReviewDraft, shortPath, splitSuggestion, threadPlace, withoutPosted,
} from '../acp/reviewDraft';
import type { SavedReview } from '../acp/reviewStore';
import { parseReviewFindings, parseSuggestion, reviewPrompt, reviewSummary, suggestPrompt } from '../acp/teamFlowLogic';
import { git, inRepository } from '../acp/worktrees';
import type { AgentsView } from './agentsView';
import type { ChatController } from './chatController';
import { agentColumn } from './editorPlacement';
import { DiffThread, ReviewComments, ReviewDiffHost } from './reviewComments';
import { ReviewDiffs, reviewDiffTitle } from './reviewDiffs';
import type { TeamConnections } from './teamConnections';
import type { TeamFlowPanel } from './teamFlowPanel';
import { extensionChunk } from './lazyFeature';
import type { ReviewCommentView, ReviewThreadView, ReviewView } from './teamFlowProtocol';
import { openTeamLink } from './teamLinks';
import { showError } from './errorNotice';

/** What a review needs from the team flows around it. */
export interface ReviewDeps {
	readonly extensionUri: vscode.Uri;
	readonly tools: TeamConnections;
	readonly agents: AgentsView;
	readonly diffs: ReviewDiffs;
	readonly comments: ReviewComments;
	gitlab(): GitLabClient;
	/** The clone of `project` to check out from; for the review of merge request `askFor`, asks the user when none is found. Undefined when they cancel. */
	cloneOf(project: string, gitlab: GitLabClient, askFor?: number): Promise<{ folder: string; remote: string } | undefined>;
	/** The Pipeline, Quality gate, ticket and Approvals rows beside the review. */
	side(mr: GitLabMr, ticket: string | undefined, folder: string): Promise<ReviewView['side']>;
	/** The review changed: its draft, or it was posted or discarded. */
	changed(): void;
	/** The review is over: posted or discarded, with its page closed. */
	ended(session: ReviewSession): void;
	/** Remove Reviewer and Checkout after Post: ends the review, then removes its reviewer agent with its worktree and branch. */
	removeReviewer(session: ReviewSession): Promise<void>;
}

/** How long after the last keystroke on the page the draft is saved and the diff's threads redrawn. */
const typingDelayMs = 500;

/** The review's key: project and number. */
export function reviewKey(project: string, iid: number): string {
	return `${project}!${iid}`;
}

/** The local branch a review of merge request `iid` checks out: GeminiCode's own, so it may be reset to a new head. */
export function reviewBranch(iid: number, sourceBranch: string): string {
	return `review/${iid}-${sourceBranch.replace(/[^\w.-]+/g, '-')}`.slice(0, 60);
}

/** Waits until the agent's turn, if one runs, is over. */
function whenIdle(controller: ChatController): Promise<void> {
	if (!controller.activity.busy) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const listener = controller.onDidChangeActivity(activity => {
			if (!activity.busy) {
				listener.dispose();
				resolve();
			}
		});
	});
}

/** The agent's reply to its last prompt, when that prompt is `prompt`. */
function replyTo(controller: ChatController, prompt?: string): string | undefined {
	const items = controller.conversation;
	const lastUser = items.map(i => i.kind).lastIndexOf('user');
	const asked = items[lastUser];
	if (prompt !== undefined && (!asked || asked.kind !== 'user' || asked.text.trim() !== prompt.trim())) {
		return undefined;
	}
	return items.slice(lastUser + 1).flatMap(i => i.kind === 'agent' ? [i.text] : []).join('\n');
}

/**
 * One merge request review: the draft (saved as it changes, so it outlives
 * its page and the app), the Review page while it is open, the draft's
 * comments and the merge request's threads in the diffs, and the reviewer
 * agent Gemini reviews with. Nothing reaches GitLab until the user posts.
 */
export class ReviewSession implements vscode.Disposable, ReviewDiffHost {

	readonly key: string;
	private flow: TeamFlowPanel<ReviewView> | undefined;
	/** The bundle the review's page comes from (src/pages.ts), loaded when the review opens. */
	private readonly pages = extensionChunk<typeof import('../pages')>('pages');
	private mr: GitLabMr | undefined;
	private files: readonly GitLabDiffFile[] = [];
	private readonly hunks = new Map<string, Hunk[]>();
	private discussions: readonly GitLabDiscussion[] = [];
	private side: ReviewView['side'] = [];
	private approvedByMe = false;
	private done: string | undefined;
	/** After Post, until the user keeps or removes them: offer to remove the reviewer and its checkout. */
	private offerRemove = false;
	private moved: { readonly head: string; readonly text: string } | undefined;
	private viewRev = 0;
	private readonly suggesting = new Set<string>();
	private readonly suggestNotes = new Map<string, string>();
	/** The reviewer's requests run one after another. */
	private queue: Promise<unknown> = Promise.resolve();
	private typingTimer: ReturnType<typeof setTimeout> | undefined;
	private persisting: Promise<unknown> = Promise.resolve();
	private posted = false;
	private disposed = false;
	private ticketKey: string | undefined;

	constructor(private saved: SavedReview, private readonly deps: ReviewDeps) {
		this.key = reviewKey(saved.project, saved.iid);
	}

	get review(): SavedReview {
		return this.saved;
	}

	get agentId(): string | undefined {
		return this.saved.agentId;
	}

	/** The draft with what the user typed on the page taken in. */
	get draft(): ReviewDraft {
		const fields = this.flow?.fields;
		return fields ? foldFields(this.saved.draft, name => fields.get(name)) : this.saved.draft;
	}

	// --- Opening

	/** Shows the Review page, opening it again when it was closed. */
	async show(): Promise<void> {
		if (this.flow && !this.flow.isDisposed) {
			this.flow.panel.reveal(this.flow.panel.viewColumn);
			return;
		}
		this.openPanel();
		this.render();
		await this.place();
	}

	/** Reads the merge request, its diff and threads, and whether the source branch moved; then draws. */
	async load(): Promise<void> {
		const gitlab = this.deps.gitlab();
		const { project, iid } = this.saved;
		const [mr, files, discussions] = await Promise.all([gitlab.mr(project, iid), gitlab.diffs(project, iid), gitlab.discussions(project, iid).catch(() => [])]);
		this.mr = mr;
		this.approvedByMe = !!mr.approvals?.approvedByMe;
		this.discussions = discussions;
		this.ticketKey = reviewTicket(mr, (await this.deps.tools.defaults(this.saved.repository)).jira?.projects);
		const head = mr.diffRefs?.headSha;
		if (!this.saved.refs && mr.diffRefs) {
			this.saved = { ...this.saved, refs: mr.diffRefs };
			this.setFiles(files);
			await this.ensureCommits();
		} else if (head && this.saved.refs && head !== this.saved.refs.headSha) {
			// Keep showing the version the draft was written on until the user refreshes.
			this.moved = { head, text: await this.movedText(head) };
			this.setFiles(await this.filesAt(this.saved.refs.headSha, files));
		} else {
			this.setFiles(files);
			await this.ensureCommits();
		}
		this.render();
		void this.deps.side(mr, this.ticketKey, this.saved.repository).then(side => {
			this.side = side;
			this.render();
		}, () => undefined);
	}

	/** Starts Gemini's review: the reviewer's checkout, the agent, and the prompt. */
	async startReviewer(): Promise<void> {
		const mr = this.mr;
		if (!mr) {
			return;
		}
		const { repository, remote, iid } = this.saved;
		// The ticket's text goes in the prompt: in its untrusted checkout the reviewer has no MCP tools to read it.
		const jira = this.ticketKey ? this.deps.tools.connectors.jira : undefined;
		const issue = jira && this.ticketKey ? jira.issue(this.ticketKey).catch(() => undefined) : undefined;
		// The target too, so the reviewer diffs against today's target: its shell can't sign in to fetch it.
		await fetchBranches(repository, remote, [mr.targetBranch]).catch(() => undefined);
		// The worktree on the review's branch, this review's or an earlier one's of the same merge request, moved to the new head.
		// One in the agents' trusted worktrees folder is made again in the untrusted reviews folder, unless an agent's record still has it.
		const branch = reviewBranch(iid, mr.sourceBranch);
		const inUse = (folder: string) => this.deps.agents.summaries().some(a => !!a.worktree && samePath(a.worktree.folder, folder));
		const worktree = await inRepository(repository, () => reviewWorktree(repository, remote, mr.sourceBranch, branch, { inUse }));
		// Read-only from its session's first tool list: what the reviewer finds goes out only when the user posts it.
		this.deps.tools.markReadOnlyFolder(worktree.cwd);
		// The reviewer of an earlier review of this merge request works there already: it reviews again, so no second agent shares its folder.
		const previous = [this.saved.agentId, ...this.deps.agents.summaries().filter(a => a.worktree?.branch === branch && a.folder === repository).map(a => a.id)]
			.find(id => !!id && !!this.deps.agents.agentPlace(id));
		const agentId = previous ?? await this.deps.agents.startTeamAgent({ folder: repository, title: vscode.l10n.t("Review !{0} {1}", iid, mr.title), worktree, text: '' });
		if (!agentId) {
			throw new Error(vscode.l10n.t("The reviewer couldn't start."));
		}
		if (previous) {
			await this.deps.agents.open(previous);
		}
		this.saved = { ...this.saved, agentId, worktree, state: 'reviewing' };
		this.persist();
		this.render();
		await this.place();
		const controller = this.deps.agents.controllerOf(agentId);
		const threads = this.discussions.filter(d => !d.resolved).map(d => ({ id: d.id, author: d.notes[0].author, body: d.notes.map(n => n.body).join('\n'), path: d.notes[0].path, line: d.notes[0].line }));
		const read = await issue;
		const ticket = this.ticketKey ? { key: this.ticketKey, ...read ? { text: `${read.summary}\n\n${read.description}`.trim() } : {} } : undefined;
		// In its untrusted checkout the reviewer has no index tools either: what the index knows around the changed files comes with the prompt.
		const files = this.files.map(f => f.newPath);
		const context = await this.deps.agents.index?.contextPack(repository, files).catch(() => undefined);
		const prompt = reviewPrompt({ iid, title: mr.title, url: mr.url, author: mr.author, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, description: mr.description }, ticket, remote, files, threads, context);
		await this.run(async () => {
			await controller?.send(prompt);
			await this.readReview();
		});
	}

	/** A review reopened while Gemini was still reviewing: its findings are read once the reviewer's turn ends. */
	async resume(): Promise<void> {
		const controller = this.saved.state === 'reviewing' && this.saved.agentId ? this.deps.agents.controllerOf(this.saved.agentId) : undefined;
		if (controller) {
			await this.run(async () => {
				await whenIdle(controller);
				await this.readReview();
			});
		}
	}

	/** Shows `error` on the page. */
	fail(error: unknown): void {
		if (this.flow && !this.flow.isDisposed) {
			this.flow.fail(error);
		} else {
			void showError(errorMessage(error));
		}
	}

	/** Reads Gemini's findings from the reviewer's last reply into the draft. */
	async readReview(): Promise<void> {
		const controller = this.saved.agentId ? this.deps.agents.controllerOf(this.saved.agentId) : undefined;
		const reply = controller ? replyTo(controller) ?? '' : '';
		const findings = parseReviewFindings(reply);
		const head = this.head;
		const anchorFiles = [...new Set((findings ?? []).flatMap(f => f.file && f.line ? [f.file] : []))];
		const lines = new Map(await Promise.all(anchorFiles.map(async file => [file, await this.deps.diffs.lines(this.saved.repository, head, file)] as const)));
		const rev = this.saved.rev + 1;
		this.change(draft => findings ? mergeFindings(draft, findings, `f${rev}`, (file, line) => lines.get(file)?.[line - 1]) : draft, {
			rev, state: findings ? 'ready' : 'unparsed', summary: reviewSummary(reply),
		});
	}

	// --- The diff (ReviewDiffHost)

	private get head(): string {
		return this.saved.refs?.headSha ?? '';
	}

	private fileOf(uri: vscode.Uri): GitLabDiffFile | undefined {
		const at = this.deps.diffs.parse(uri);
		return at && at.repository === this.saved.repository && at.sha === this.head ? this.files.find(f => f.newPath === at.file && !f.deletedFile) : undefined;
	}

	commentable(uri: vscode.Uri): readonly { readonly start: number; readonly end: number }[] | undefined {
		const file = this.fileOf(uri);
		return file ? commentableRanges(this.hunks.get(file.newPath) ?? []) : undefined;
	}

	async add(uri: vscode.Uri, line: number, endLine: number, text: string, suggest: boolean): Promise<string | undefined> {
		const file = this.fileOf(uri);
		if (!file) {
			return undefined;
		}
		const lines = await this.deps.diffs.lines(this.saved.repository, this.head, file.newPath);
		const typed = splitSuggestion(text);
		const suggestion = typed.suggestion ?? (suggest ? lines.slice(line - 1, endLine).join('\n') : undefined);
		if (!typed.comment && suggestion === undefined) {
			return undefined;
		}
		const id = `y${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
		this.change(draft => ({
			...draft,
			comments: [...draft.comments, {
				id, by: 'you', file: file.newPath, line, comment: typed.comment, checked: true, anchor: lines[line - 1] ?? '',
				...endLine > line ? { endLine } : {},
				...suggestion !== undefined ? { suggestion: { text: suggestion, by: 'you', include: true } } : {},
			}],
		}));
		return id;
	}

	reply(discussion: string, text: string, resolve: boolean): void {
		this.change(draft => {
			const existing = draft.replies.find(r => r.discussion === discussion);
			if (existing) {
				return { ...draft, replies: draft.replies.map(r => r === existing ? { ...r, text: text.trim() ? text : r.text, resolve: resolve || r.resolve, checked: true, ...r.by === 'gemini' ? { edited: true } : {} } : r) };
			}
			const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
			return { ...draft, replies: [...draft.replies, { id, discussion, by: 'you', text, resolve, checked: true }] };
		});
	}

	edit(id: string, text: string): void {
		this.change(draft => ({
			comments: draft.comments.map(c => {
				if (c.id !== id) {
					return c;
				}
				const typed = splitSuggestion(text);
				const suggestion = typed.suggestion === undefined ? undefined : { text: typed.suggestion, by: typed.suggestion === c.suggestion?.text ? c.suggestion.by : 'you' as const, include: c.suggestion?.include ?? true };
				const { suggestion: _old, ...rest } = c;
				return { ...rest, comment: typed.comment, ...suggestion ? { suggestion } : {}, ...c.by === 'gemini' ? { edited: true } : {} };
			}),
			replies: draft.replies.map(r => r.id === id ? { ...r, text, ...r.by === 'gemini' ? { edited: true } : {} } : r),
		}));
	}

	remove(id: string): void {
		this.change(draft => ({ comments: draft.comments.filter(c => c.id !== id), replies: draft.replies.filter(r => r.id !== id) }));
	}

	async askSuggestion(id: string): Promise<void> {
		const comment = this.draft.comments.find(c => c.id === id);
		const agentId = this.saved.agentId;
		if (!comment?.file || !comment.line || !agentId) {
			return;
		}
		if (!this.deps.agents.agentPlace(agentId)) {
			void vscode.window.showWarningMessage(vscode.l10n.t("The reviewer agent was removed. Press Ask Gemini Again on the Review page first."));
			return;
		}
		// After a restart the reviewer runs again once its tab opens.
		if (!this.deps.agents.controllerOf(agentId)) {
			await this.deps.agents.open(agentId);
		}
		const controller = this.deps.agents.controllerOf(agentId);
		if (!controller) {
			return;
		}
		const { file, line } = comment;
		const endLine = comment.endLine ?? line;
		this.suggesting.add(id);
		this.suggestNotes.delete(id);
		this.render();
		void this.run(async () => {
			const prompt = suggestPrompt(file, line, endLine, comment.comment);
			try {
				await whenIdle(controller);
				await controller.send(prompt);
				const answer = parseSuggestion(replyTo(controller, prompt) ?? '');
				this.suggesting.delete(id);
				if (typeof answer === 'string') {
					this.change(draft => ({ ...draft, comments: draft.comments.map(c => c.id === id ? { ...c, suggestion: { text: answer, by: 'gemini', include: true } } : c) }));
					return;
				}
				this.suggestNotes.set(id, vscode.l10n.t("Gemini didn't suggest a change for these lines. The comment is unchanged."));
			} catch (err) {
				this.suggesting.delete(id);
				this.suggestNotes.set(id, errorMessage(err));
			}
			this.render();
		});
	}

	openPage(): void {
		void this.show();
	}

	// --- The page

	private openPanel(): void {
		const { iid } = this.saved;
		// A tab in the active group (Home's), not a split beside Home; it moves beside its reviewer once that runs.
		const flow = new (this.pages().TeamFlowPanel<ReviewView>)(this.deps.extensionUri, vscode.l10n.t("Review !{0}", iid), 'gitlab', vscode.l10n.t("Reading !{0}...", iid), (action, value) => this.act(action, value), vscode.ViewColumn.Active);
		this.flow = flow;
		this.viewRev++;
		flow.onDidSetField(name => {
			if (draftFieldPattern.test(name)) {
				this.typed();
			}
		});
		flow.onDidDispose(() => {
			clearTimeout(this.typingTimer);
			// What was typed last stays in the draft.
			this.saved = { ...this.saved, draft: foldFields(this.saved.draft, name => flow.fields.get(name)) };
			this.persist();
			if (this.flow === flow) {
				this.flow = undefined;
			}
			if (this.posted) {
				this.deps.ended(this);
			}
		});
	}

	/** Moves the page into the reviewer's side group, when its agent runs. */
	private async place(): Promise<void> {
		const agentId = this.saved.agentId;
		const flow = this.flow;
		if (!flow || !agentId || !this.deps.agents.agentPlace(agentId)) {
			return;
		}
		const column = await agentColumn(agentId, undefined);
		if (flow.panel.viewColumn === column) {
			return;
		}
		// A page moved to another group opens there as a preview, which the next diff would replace: keep it.
		flow.panel.reveal(column, false);
		await vscode.commands.executeCommand('workbench.action.keepEditor');
	}

	/** The user typed or ticked on the page: the draft is saved and the diff's threads follow, a moment later. */
	private typed(): void {
		clearTimeout(this.typingTimer);
		this.typingTimer = setTimeout(() => {
			this.saved = { ...this.saved, draft: this.draft };
			this.persist();
			this.showThreads();
		}, typingDelayMs);
	}

	/** Changes the draft (with what was typed taken in) and anything else saved, then saves and redraws. */
	private change(update: (draft: ReviewDraft) => ReviewDraft, extra: Partial<SavedReview> = {}): void {
		const draft = update(this.draft);
		for (const name of [...this.flow?.fields.keys() ?? []].filter(n => draftFieldPattern.test(n))) {
			this.flow!.fields.delete(name);
		}
		this.saved = { ...this.saved, ...extra, draft };
		this.viewRev++;
		this.persist();
		this.render();
	}

	private persist(): void {
		if (this.posted || this.disposed) {
			return;
		}
		const review = this.saved;
		this.persisting = this.persisting.then(() => this.deps.tools.reviews.save(review)).then(saved => {
			this.saved = { ...this.saved, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
		}, () => undefined);
		this.deps.changed();
	}

	/** Runs the reviewer's requests one after another. */
	private run(work: () => Promise<void>): Promise<void> {
		const next = this.queue.then(work, work);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Redraws the page and the diff's threads. */
	render(): void {
		this.showThreads();
		const flow = this.flow;
		if (!flow || flow.isDisposed) {
			return;
		}
		void this.view().then(view => {
			if (flow.isDisposed) {
				return;
			}
			if (flow.view) {
				flow.update(view);
			} else {
				flow.setView(view);
			}
		}, err => flow.fail(err));
	}

	private async view(): Promise<ReviewView> {
		const s = this.saved;
		const mr = this.mr;
		const draft = this.draft;
		const labels = fileLabels(this.files.map(f => f.newPath));
		const comments: ReviewCommentView[] = await Promise.all(draft.comments.map(async c => {
			const hunks = c.file ? this.hunks.get(c.file) : undefined;
			const end = c.endLine ?? c.line ?? 0;
			const onLine = !!(c.line && hunks && lineInDiff(hunks, c.line));
			const canSuggest = !!(c.line && hunks && inOneHunk(hunks, c.line, end) && onLine);
			const old = c.suggestion && c.file && c.line ? (await this.deps.diffs.lines(s.repository, this.head, c.file)).slice(c.line - 1, end).join('\n') : '';
			const lineText = c.line ? `:${c.line}${c.endLine ? `\u2013${c.endLine}` : ''}` : '';
			return {
				id: c.id, by: c.by, comment: c.comment, checked: c.checked, onLine, canSuggest,
				...c.kind ? { kind: c.kind } : {},
				...c.title ? { title: c.title } : {},
				...c.file ? { where: `${shortPath(c.file)}${lineText}`, path: `${c.file}${lineText}` } : {},
				...c.lineChanged ? { lineChanged: true } : {},
				...c.suggestion ? { suggestion: { ...c.suggestion, old } } : {},
				...this.suggesting.has(c.id) ? { suggesting: true } : {},
			};
		}));
		const replies = new Map(draft.replies.map(r => [r.discussion, r]));
		const threads: ReviewThreadView[] = this.discussions.filter(d => !d.resolved || replies.has(d.id)).map(d => {
			const place = threadPlace(d.notes[0], this.head);
			const reply = replies.get(d.id);
			return {
				id: d.id,
				onLine: !!(place.line && !place.outdated && this.files.some(f => f.newPath === place.file)),
				resolvable: !!d.resolvable,
				notes: d.notes.map(n => ({ author: n.author, body: n.body, when: n.createdAt ? new Date(n.createdAt).toLocaleDateString(vscode.env.language, { month: 'short', day: 'numeric' }) : '' })),
				url: `${mr?.url ?? s.url}#note_${d.notes[0].id}`,
				...place.file ? { where: `${shortPath(place.file)}${place.line ? `:${place.line}` : ''}`, path: `${place.file}${place.line ? `:${place.line}` : ''}` } : {},
				...place.outdated ? { outdated: true } : {},
				...place.removedLine ? { removedLine: true } : {},
				...reply ? { reply: { id: reply.id, by: reply.by, text: reply.text, resolve: reply.resolve, checked: reply.checked } } : {},
			};
		});
		const agentGone = !!s.agentId && !this.deps.agents.agentPlace(s.agentId);
		const total = Number.parseInt(mr?.changes ?? '', 10);
		return {
			kind: 'review', project: s.project,
			mr: { iid: s.iid, title: mr?.title ?? s.title, url: mr?.url ?? s.url, author: mr?.author ?? s.author, source: mr?.sourceBranch ?? s.source, target: mr?.targetBranch ?? s.target, files: this.files.length, ...this.head ? { head: this.head.slice(0, 7) } : {} },
			state: !mr ? 'preparing' : s.state,
			summary: s.summary,
			comments: comments.map(c => this.suggestNotes.has(c.id) ? { ...c, suggestNote: this.suggestNotes.get(c.id) } : c),
			threads,
			resolvedThreads: this.discussions.filter(d => d.resolved && d.resolvable && !replies.has(d.id)).length,
			rev: this.viewRev,
			side: this.side,
			files: this.files.map(f => {
				const label = labels.get(f.newPath)!;
				let added = 0;
				let removed = 0;
				for (const hunk of this.hunks.get(f.newPath) ?? []) {
					added += hunk.lines.filter(l => l.type === 'added').length;
					removed += hunk.lines.filter(l => l.type === 'removed').length;
				}
				return { path: f.newPath, dir: label.dir, name: label.name, added, removed, comments: draft.comments.filter(c => c.file === f.newPath).length };
			}),
			...total > this.files.length ? { moreFiles: total - this.files.length } : {},
			...s.agentId && !agentGone ? { agentId: s.agentId } : {},
			...agentGone ? { agentGone } : {},
			...this.moved ? { moved: this.moved.text } : {},
			approvedByMe: this.approvedByMe,
			...this.done ? { done: this.done } : {},
			...this.done && this.offerRemove ? leftoverOf(this.saved.agentId && this.deps.agents.agentPlace(this.saved.agentId)) : {},
		};
	}

	/** The draft's comments and the merge request's threads in the diffs. */
	private showThreads(): void {
		if (this.disposed) {
			return;
		}
		if (!this.head || this.posted) {
			this.deps.comments.hide(this.key);
			return;
		}
		const { repository } = this.saved;
		const draft = this.draft;
		const agentAlive = !!this.saved.agentId && !!this.deps.agents.agentPlace(this.saved.agentId);
		const kindNames: Record<string, string> = { bug: vscode.l10n.t("Bug"), shouldFix: vscode.l10n.t("Should fix"), nit: vscode.l10n.t("Nit"), question: vscode.l10n.t("Question") };
		const threads: DiffThread[] = [];
		for (const c of draft.comments) {
			const file = c.file && c.line ? this.files.find(f => f.newPath === c.file && !f.deletedFile) : undefined;
			if (!file || !c.line) {
				continue;
			}
			const hunks = this.hunks.get(file.newPath) ?? [];
			const preview = c.suggestion?.include ? `\n\n${vscode.l10n.t("Suggested change:")}\n\n\`\`\`\`\n${c.suggestion.text}\n\`\`\`\`` : '';
			threads.push({
				id: `c:${c.id}`, uri: this.deps.diffs.uri(repository, this.head, file.newPath), line: c.line, ...c.endLine ? { endLine: c.endLine } : {}, kind: 'draft',
				label: c.checked ? vscode.l10n.t("In your review") : vscode.l10n.t("In your review, not ticked"),
				comments: [{
					id: c.id,
					author: c.by === 'gemini' ? 'Gemini' : vscode.l10n.t("You"),
					...c.kind ? { label: kindNames[c.kind] } : {},
					body: `${c.title && c.by === 'gemini' ? `**${c.title}**\n\n` : ''}${c.comment}${preview}`,
					editText: editableText(c),
					askable: agentAlive && inOneHunk(hunks, c.line, c.endLine ?? c.line),
				}],
			});
		}
		const replies = new Map(draft.replies.map(r => [r.discussion, r]));
		for (const d of this.discussions) {
			const place = threadPlace(d.notes[0], this.head);
			const file = place.file && place.line && !place.outdated ? this.files.find(f => f.newPath === place.file && !f.deletedFile) : undefined;
			if (!file || !place.line) {
				continue;
			}
			const reply = replies.get(d.id);
			threads.push({
				id: `g:${d.id}`, uri: this.deps.diffs.uri(repository, this.head, file.newPath), line: place.line, kind: 'gitlab', resolved: d.resolved,
				...d.resolved && d.resolvedBy ? { label: vscode.l10n.t("Resolved by {0}", d.resolvedBy) } : {},
				comments: [
					...d.notes.map(n => ({ id: String(n.id), author: n.author, body: n.body, ...n.createdAt ? { timestamp: new Date(n.createdAt) } : {} })),
					...reply ? [{
						id: reply.id, author: reply.by === 'gemini' ? 'Gemini' : vscode.l10n.t("You"),
						label: reply.resolve ? (reply.text.trim() ? vscode.l10n.t("Draft reply, resolves the thread") : vscode.l10n.t("Draft: resolve the thread")) : vscode.l10n.t("Draft reply"),
						body: reply.text || vscode.l10n.t("Resolve the thread."), editText: reply.text,
					}] : [],
				],
			});
		}
		this.deps.comments.show(this.key, this, threads);
	}

	// --- What the page asks

	private async act(action: string, value: unknown): Promise<void> {
		const id = typeof value === 'string' ? value : '';
		switch (action) {
			case 'openAgent':
				return this.saved.agentId ? this.deps.agents.open(this.saved.agentId) : undefined;
			case 'openGitLab':
				return void openTeamLink(this.mr?.url ?? this.saved.url);
			case 'readAgain':
				// After a restart the reviewer runs again once its tab opens.
				if (this.saved.agentId && !this.deps.agents.controllerOf(this.saved.agentId)) {
					await this.deps.agents.open(this.saved.agentId);
				}
				return this.readReview();
			case 'askAgain':
				return this.flow?.busy(vscode.l10n.t("Starting the reviewer..."), () => this.startReviewer());
			case 'openDiff': {
				const c = this.draft.comments.find(c => c.id === id);
				return c?.file ? this.openDiff(c.file, c.line) : undefined;
			}
			case 'openFile':
				return this.openDiff(id);
			case 'openThread': {
				const d = this.discussions.find(d => d.id === id);
				const place = d && threadPlace(d.notes[0], this.head);
				if (place?.file && place.line && !place.outdated) {
					return this.openDiff(place.file, place.line);
				}
				return void openTeamLink(`${this.mr?.url ?? this.saved.url}#note_${d?.notes[0].id ?? ''}`);
			}
			case 'addComment':
				return this.change(draft => ({ ...draft, comments: [...draft.comments, { id: `y${Date.now().toString(36)}`, by: 'you', comment: '', checked: true }] }));
			case 'deleteComment':
			case 'deleteReply':
				return this.remove(id);
			case 'reply':
				return this.reply(id, '', false);
			case 'resolve':
				return this.reply(id, '', true);
			case 'addSuggestion': {
				const c = this.draft.comments.find(c => c.id === id);
				if (!c?.file || !c.line) {
					return;
				}
				const lines = await this.deps.diffs.lines(this.saved.repository, this.head, c.file);
				const text = lines.slice(c.line - 1, c.endLine ?? c.line).join('\n');
				return this.change(draft => ({ ...draft, comments: draft.comments.map(x => x.id === id ? { ...x, suggestion: { text, by: 'you', include: true } } : x) }));
			}
			case 'removeSuggestion':
				return this.change(draft => ({
					...draft, comments: draft.comments.map(c => {
						if (c.id !== id) {
							return c;
						}
						const { suggestion: _removed, ...rest } = c;
						return rest;
					}),
				}));
			case 'askSuggestion':
				return this.askSuggestion(id);
			case 'refresh':
				return this.flow?.busy(vscode.l10n.t("Reading the new commits..."), () => this.refresh());
			case 'post':
				return this.flow?.busy(vscode.l10n.t("Posting to GitLab..."), () => this.post(id));
			case 'retrySide':
				return this.flow?.busy(vscode.l10n.t("Reading GitLab again..."), () => this.readSide());
			case 'removeReviewer':
				return this.flow?.busy(vscode.l10n.t("Removing the reviewer..."), () => this.deps.removeReviewer(this));
			case 'keepReviewer':
				this.offerRemove = false;
				return this.render();
		}
	}

	private async openDiff(file: string, line?: number): Promise<void> {
		const diff = this.files.find(f => f.newPath === file);
		const refs = this.saved.refs;
		if (!diff || !refs) {
			return;
		}
		const agentId = this.saved.agentId;
		// Into the reviewer's side group, with the reviewer in front; else beside the page.
		const viewColumn = agentId && this.deps.agents.agentPlace(agentId) ? await agentColumn(agentId, undefined, true) : vscode.ViewColumn.Active;
		await this.deps.diffs.open({
			repository: this.saved.repository, base: refs.baseSha, head: refs.headSha, oldPath: diff.oldPath, newPath: diff.newPath,
			newFile: diff.newFile, deletedFile: diff.deletedFile, ...line ? { line } : {},
			title: reviewDiffTitle(diff.newPath, this.saved.iid, this.mr?.targetBranch ?? this.saved.target, this.mr?.sourceBranch ?? this.saved.source),
			viewColumn,
		});
	}

	/** Reads the merge request and the rows beside the review again, after one couldn't be read. */
	private async readSide(): Promise<void> {
		const mr = await this.deps.gitlab().mr(this.saved.project, this.saved.iid);
		this.mr = mr;
		this.approvedByMe = !!mr.approvals?.approvedByMe;
		this.side = await this.deps.side(mr, this.ticketKey, this.saved.repository);
		this.render();
	}

	/** Moves the review to the merge request's newest version: comments follow their lines, those whose line changed are flagged. */
	private async refresh(): Promise<void> {
		const gitlab = this.deps.gitlab();
		const { project, iid, repository } = this.saved;
		const [mr, files, discussions] = await Promise.all([gitlab.mr(project, iid), gitlab.diffs(project, iid), gitlab.discussions(project, iid).catch(() => [])]);
		this.mr = mr;
		this.discussions = discussions;
		this.approvedByMe = !!mr.approvals?.approvedByMe;
		if (!mr.diffRefs) {
			this.moved = undefined;
			return this.render();
		}
		this.saved = { ...this.saved, refs: mr.diffRefs };
		this.setFiles(files);
		await this.ensureCommits();
		const head = mr.diffRefs.headSha;
		const commented = [...new Set(this.draft.comments.flatMap(c => c.file ? [c.file] : []))];
		const lines = new Map(await Promise.all(commented.map(async file => [file, await this.deps.diffs.lines(repository, head, file)] as const)));
		this.moved = undefined;
		this.change(draft => moveDraft(draft, file => lines.get(file)));
	}

	private async post(mode: string): Promise<void> {
		const gitlab = this.deps.gitlab();
		const { project, iid, repository } = this.saved;
		// Comments go on the lines of the version shown: a push since then is looked at first.
		const latest = await gitlab.mr(project, iid, false);
		if (latest.diffRefs && this.saved.refs && latest.diffRefs.headSha !== this.saved.refs.headSha) {
			this.moved = { head: latest.diffRefs.headSha, text: await this.movedText(latest.diffRefs.headSha) };
			this.render();
			throw new Error(vscode.l10n.t("The source branch has new commits. Press Refresh, check your comments, then post."));
		}
		this.change(draft => draft);
		const items = postItems(this.saved.draft, file => this.hunks.get(file));
		const mr = { project, mr: String(iid) };
		const refs = this.saved.refs;
		const posted = new Set<string>();
		let comments = 0;
		let replies = 0;
		try {
			for (const item of items) {
				if (item.kind === 'comment') {
					const diff = item.file ? this.files.find(f => f.newPath === item.file) : undefined;
					await this.deps.tools.write('gitlab_reply', {
						...mr, text: item.text,
						...item.file && item.line ? { path: item.file, line: item.line } : {},
						...item.oldLine ? { oldLine: item.oldLine } : {},
						...diff && diff.oldPath !== diff.newPath ? { oldPath: diff.oldPath } : {},
						...refs && item.line ? { baseSha: refs.baseSha, startSha: refs.startSha, headSha: refs.headSha } : {},
					}, repository);
					comments++;
				} else if (item.kind === 'reply') {
					await this.deps.tools.write('gitlab_reply', { ...mr, discussion: item.discussion, text: item.text, resolve: item.resolve }, repository);
					replies++;
				} else {
					await this.deps.tools.write('gitlab_resolve', { ...mr, discussion: item.discussion }, repository);
					replies++;
				}
				posted.add(item.id);
			}
		} finally {
			if (posted.size) {
				this.change(draft => withoutPosted(draft, posted));
			}
		}
		if (mode === 'request') {
			await this.deps.tools.write('gitlab_request_changes', { ...mr, text: vscode.l10n.t("Requesting changes: see the {0} comments above.", comments) }, repository);
		} else if (mode === 'approve') {
			await this.deps.tools.write('gitlab_approve', mr, repository);
			this.approvedByMe = true;
		}
		const total = comments + replies;
		this.done = mode === 'approve' ? (total ? vscode.l10n.t("Approved !{0} and posted {1} comments.", iid, total) : vscode.l10n.t("Approved !{0}.", iid))
			: mode === 'request' ? vscode.l10n.t("Posted {0} comments and requested changes on !{1}.", total, iid)
				: vscode.l10n.t("Posted {0} comments to !{1}.", total, iid);
		this.offerRemove = true;
		// The review is done: its saved draft goes, and the diffs show the merge request's threads as GitLab has them now.
		this.posted = true;
		await this.persisting;
		await this.deps.tools.reviews.remove(project, iid);
		this.discussions = await gitlab.discussions(project, iid).catch(() => this.discussions);
		this.deps.changed();
		this.render();
	}

	// --- Helpers

	private setFiles(files: readonly GitLabDiffFile[]): void {
		this.files = files;
		this.hunks.clear();
		for (const f of files) {
			this.hunks.set(f.newPath, parseHunks(f.diff));
		}
	}

	/** The diff of the version the draft was written on, read from the clone, when the merge request moved past it. */
	private async filesAt(head: string, latest: readonly GitLabDiffFile[]): Promise<GitLabDiffFile[]> {
		const refs = this.saved.refs!;
		await this.ensureCommits();
		try {
			const names = (await git(this.saved.repository, ['diff', '--name-status', '-M', refs.baseSha, head])).trim().split('\n').filter(Boolean);
			return await Promise.all(names.map(async line => {
				const [status, first, second] = line.split('\t');
				const oldPath = first;
				const newPath = second ?? first;
				const diff = await git(this.saved.repository, ['diff', '-M', '--unified=3', refs.baseSha, head, '--', ...new Set([oldPath, newPath])]);
				return { oldPath, newPath, diff: diff.slice(Math.max(0, diff.indexOf('\n@@') + 1)), newFile: status === 'A', deletedFile: status === 'D' };
			}));
		} catch {
			return [...latest];
		}
	}

	/** Fetches the merge request's branches and the commits its diff names, so the diffs can be read from the clone. */
	private async ensureCommits(): Promise<void> {
		const refs = this.saved.refs;
		const { repository, remote } = this.saved;
		await fetchBranches(repository, remote, [this.mr?.sourceBranch ?? this.saved.source, this.mr?.targetBranch ?? this.saved.target]).catch(() => undefined);
		if (refs) {
			await this.deps.diffs.ensure(repository, remote, [refs.baseSha, refs.headSha]);
		}
	}

	private async movedText(head: string): Promise<string> {
		await fetchBranches(this.saved.repository, this.saved.remote, [this.mr?.sourceBranch ?? this.saved.source]).catch(() => undefined);
		const count = Number((await git(this.saved.repository, ['rev-list', '--count', `${this.head}..${head}`]).catch(() => '')).trim());
		return count > 0
			? vscode.l10n.t("The source branch has new commits since this review ({0}). Your draft stays; comments on lines that changed are labelled.", count)
			: vscode.l10n.t("The source branch changed since this review. Your draft stays; comments on lines that changed are labelled.");
	}

	/** Leaves the review: its page closes and its threads leave the diffs. The saved draft stays unless `discard`. */
	async end(discard: boolean): Promise<void> {
		if (discard) {
			this.posted = true;
			await this.persisting;
			await this.deps.tools.reviews.remove(this.saved.project, this.saved.iid);
		}
		this.dispose();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		clearTimeout(this.typingTimer);
		this.flow?.dispose();
		this.disposed = true;
		this.deps.comments.hide(this.key);
	}
}

/** What Post leaves on this Mac: the reviewer agent and its checkout, as the page says it; nothing once the agent is gone. */
function leftoverOf(place: { readonly branch?: string } | false | undefined | ''): { readonly leftover?: string } {
	if (!place) {
		return {};
	}
	return { leftover: place.branch ? vscode.l10n.t("The reviewer agent and its checkout ({0}) are still on this Mac.", place.branch) : vscode.l10n.t("The reviewer agent and its checkout are still on this Mac.") };
}

/** A review that just started: what it is about, before its first save. */
export function newReview(mr: GitLabMr, clone: { readonly folder: string; readonly remote: string }): Omit<SavedReview, 'createdAt' | 'updatedAt'> & { readonly createdAt?: string } {
	return {
		project: mr.project, iid: mr.iid, title: mr.title, url: mr.url, author: mr.author, source: mr.sourceBranch, target: mr.targetBranch,
		repository: clone.folder, remote: clone.remote, ...mr.diffRefs ? { refs: mr.diffRefs } : {},
		summary: '', state: 'reviewing', draft: { comments: [], replies: [] }, rev: 0,
	};
}

/** The Jira ticket the merge request names, among the team's Jira projects. */
export function reviewTicket(mr: GitLabMr, projects?: readonly string[]): string | undefined {
	return jiraKeyIn(`${mr.sourceBranch} ${mr.title} ${mr.description}`, projects);
}

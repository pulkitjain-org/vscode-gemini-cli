/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan Review: an agent's plan file, rendered, with each section editable in
// place and open to comments. Edits are saved to the file as they are made;
// comments are kept (per plan file, across reloads: planReviewStore.ts)
// until Send hands them all to the agent in one message, after which the
// page marks the sections that message's turn changed. Build This Plan asks first when comments
// were not sent. In dist/pages.js, loaded the first time a plan is reviewed:
// what it needs of the agents comes through `PlanReviewHost`.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { changedSections, planSections, replaceSection, reviewMessage, type PlanComment, type ReviewWords } from '../acp/planReview';
import { emptyPlanReview, legacyPlanReviewKey, PlanReviewStore, unsentReview, type PlanReviewState } from '../acp/planReviewStore';
import type { FromPlan, PlanStrings, PlanView, ToPlan } from './planReviewProtocol';
import { PagePanel, PageShell } from './pagePanel';

/** What Plan Review needs of the agent that wrote the plan. */
export interface PlanReviewHost {
	readonly extensionUri: vscode.Uri;
	/** Where Plan Review keeps its state, a file per plan (planReviewStore.ts). */
	readonly storageFolder: string;
	/** Where earlier versions kept it; moved to `storageFolder` once. */
	readonly globalState: vscode.Memento;
	title(agentId: string): string | undefined;
	/** The agent's side column, where its files open. */
	column(agentId: string): Promise<vscode.ViewColumn>;
	busy(agentId: string): boolean;
	/** Whether the agent's latest turn ended in Plan mode, so it can build the plan. */
	canBuild(agentId: string): boolean;
	/**
	 * Sends `text` to the agent as the user's message, after a running turn;
	 * resolves true once the message's own turn is over, false when it never
	 * went (taken out of the queue, or held back because the turn before it stopped).
	 */
	send(agentId: string, text: string): Promise<boolean>;
	/** Build This Plan, telling the agent `text`; resolves whether the build started. */
	build(agentId: string, text: string): Promise<boolean>;
	/** The plan as it was before the review was sent, beside the file as it is, in the agent's column. */
	showDiff(agentId: string, file: string, before: string): Promise<void>;
	/** An agent started or ended a turn. */
	readonly onDidChangeAgent: vscode.Event<string>;
}

export class PlanReviews implements vscode.Disposable {

	/** Each plan's page, from the moment it is asked for, so a second open shows the same one. */
	private readonly pages = new Map<string, Promise<PlanReviewPage>>();
	private readonly store: PlanReviewStore;
	/** Earlier versions' state moved over and stale state pruned, before a page reads its state. */
	private readonly maintained: Promise<void>;
	/** A review's message on its way to the agent, per plan file: it outlasts the page that sent it. */
	private readonly sends = new Map<string, Promise<void>>();

	constructor(private readonly host: PlanReviewHost) {
		this.store = new PlanReviewStore(host.storageFolder);
		this.maintained = this.maintain().catch(() => undefined);
	}

	/** Opens the review of `file`, written by agent `agentId`, or shows it again. */
	async open(agentId: string, file: string): Promise<void> {
		const open = this.pages.get(file);
		if (open) {
			(await open).reveal();
			return;
		}
		// In the map before anything is awaited.
		const page = this.host.column(agentId).then(column => new PlanReviewPage(this.host, this.store, this.maintained, this.sends, agentId, file, column));
		this.pages.set(file, page);
		try {
			(await page).onDidDispose(() => this.pages.delete(file));
		} catch (err) {
			this.pages.delete(file);
			throw err;
		}
	}

	/** Moves reviews kept in global state, loaded in every window at startup, to their files; then prunes. */
	private async maintain(): Promise<void> {
		const state = this.host.globalState;
		for (const key of state.keys().filter(each => each.startsWith(legacyPlanReviewKey))) {
			const saved = state.get<PlanReviewState>(key);
			if (saved) {
				await this.store.write(key.slice(legacyPlanReviewKey.length), { ...emptyPlanReview, ...saved });
			}
			await state.update(key, undefined);
		}
		await this.store.prune();
	}

	dispose(): void {
		for (const page of this.pages.values()) {
			void page.then(each => each.dispose(), () => undefined);
		}
		this.pages.clear();
	}
}

class PlanReviewPage implements vscode.Disposable {

	private readonly page: PagePanel<ToPlan, FromPlan>;
	private readonly disposables: vscode.Disposable[] = [];
	readonly onDidDispose: vscode.Event<void>;
	private markdown = '';
	/** The plan file isn't there. */
	private missing = false;
	/** The state as last read or written; read again before each change. */
	private saved: PlanReviewState = emptyPlanReview;
	/** Changes to the state, one at a time. */
	private updates: Promise<unknown> = Promise.resolve();
	/** Our own write, so the watcher doesn't read it back as the agent's; cleared at the next event. */
	private writing: string | undefined;
	constructor(private readonly host: PlanReviewHost, private readonly store: PlanReviewStore, private readonly maintained: Promise<void>, private readonly sends: Map<string, Promise<void>>, private readonly agentId: string, private readonly file: string, column: vscode.ViewColumn) {
		this.page = new PagePanel<ToPlan, FromPlan>(host.extensionUri, { viewType: 'gemini.planReview', title: vscode.l10n.t("Plan: {0}", path.basename(file)), icon: new vscode.ThemeIcon('checklist'), column: { viewColumn: column, preserveFocus: false }, retainContextWhenHidden: true }, this.shell(), message => this.onMessage(message));
		this.onDidDispose = this.page.onDidDispose;
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
		this.disposables.push(
			watcher,
			watcher.onDidChange(() => void this.reload()),
			watcher.onDidCreate(() => void this.reload()),
			watcher.onDidDelete(() => void this.reload()),
			// Build and editing follow the agent's turns; a revision ends with its own message's turn (`send`).
			host.onDidChangeAgent(id => {
				if (id === this.agentId) {
					this.postView();
				}
			}),
			this.page.onDidDispose(() => vscode.Disposable.from(...this.disposables).dispose()),
		);
	}

	reveal(): void {
		this.page.reveal();
	}

	dispose(): void {
		this.page.dispose();
	}

	/** Reads the kept state again, changes it with `change`, and keeps it. */
	private update(change: (saved: PlanReviewState) => Partial<PlanReviewState>): Promise<void> {
		const done = this.updates.then(async () => {
			this.saved = await this.store.update(this.file, change);
		});
		this.updates = done.catch(() => undefined);
		return done;
	}

	private async reload(): Promise<void> {
		const text = await fs.readFile(this.file, 'utf8').catch(() => undefined);
		const ours = text !== undefined && text === this.writing;
		// One event per write: a later write of the same text (an Undo) is read again.
		this.writing = undefined;
		if (ours) {
			return;
		}
		this.missing = text === undefined;
		this.markdown = text ?? '';
		if (text !== undefined && this.saved.plan !== undefined && text !== this.saved.plan) {
			// The copy a rebuilt plan prefers follows the file.
			await this.update(() => ({ plan: text, planAt: Date.now() }));
		}
		this.postView();
	}

	/**
	 * The page (re)opened on a review marked revising. Its message is on its
	 * way from this window: the page shows the outcome once it's in. Otherwise
	 * it went with a window that reloaded, before it was known to reach
	 * Gemini: the comments are unsent again.
	 */
	private async resumeRevision(): Promise<void> {
		const sending = this.sends.get(this.file);
		if (sending) {
			void sending.then(async () => {
				this.saved = await this.store.read(this.file);
				await this.reload();
			});
			return;
		}
		await this.update(unsentReview);
		this.postView();
		this.post({ type: 'error', message: vscode.l10n.t("Your last comments were still on their way to Gemini when the window reloaded, so they may not have reached it. They're unsent again: send them when you're ready.") });
	}

	/** The revision's turn is over: the sections it changed are marked. */
	private async finishRevision(): Promise<void> {
		const text = await fs.readFile(this.file, 'utf8').catch(() => undefined);
		if (text !== undefined) {
			this.markdown = text;
			this.missing = false;
		}
		const markdown = this.markdown;
		await this.update(saved => ({ revising: false, unsend: undefined, changed: saved.before !== undefined ? changedSections(saved.before, markdown) : [] }));
		this.postView();
	}

	private view(): PlanView {
		const first = planSections(this.markdown).find(each => each.heading);
		return {
			title: first?.heading ?? path.basename(this.file),
			file: path.basename(this.file),
			agent: this.host.title(this.agentId) ?? '',
			markdown: this.markdown,
			comments: this.saved.comments,
			edited: this.saved.edited,
			revising: !!this.saved.revising,
			changed: this.saved.changed ?? [],
			missing: this.missing,
			busy: this.host.busy(this.agentId),
			canBuild: this.host.canBuild(this.agentId),
		};
	}

	private postView(): void {
		this.post({ type: 'view', view: this.view() });
	}

	private post(message: ToPlan): void {
		this.page.post(message);
	}

	private async onMessage(message: FromPlan): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					await this.maintained;
					this.saved = await this.store.read(this.file);
					await this.reload();
					if (this.saved.revising) {
						await this.resumeRevision();
					}
					return;
				case 'saveSection':
					return await this.saveSection(message.section, message.markdown, message.original);
				case 'addComment': {
					const heading = planSections(this.markdown).find(each => each.id === message.section)?.heading;
					const comment: PlanComment = {
						id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
						section: message.section,
						...heading ? { heading } : {},
						quote: message.quote.slice(0, 200),
						text: message.text,
						createdAt: Date.now(),
					};
					await this.update(saved => ({ comments: [...saved.comments, comment] }));
					this.postView();
					return;
				}
				case 'editComment':
					await this.update(saved => ({ comments: saved.comments.map(each => each.id === message.id ? { ...each, text: message.text } : each) }));
					this.postView();
					return;
				case 'deleteComment':
					await this.update(saved => ({ comments: saved.comments.filter(each => each.id !== message.id) }));
					this.postView();
					return;
				case 'send':
					await this.send();
					return;
				case 'build':
					await this.build();
					return;
				case 'showChanges':
					if (this.saved.before !== undefined) {
						await this.host.showDiff(this.agentId, this.file, this.saved.before);
					}
					return;
				case 'clearSent':
					await this.update(saved => ({ comments: saved.comments.filter(each => !each.sentAt), changed: [], before: undefined }));
					this.postView();
					return;
				case 'openSource':
					await vscode.window.showTextDocument(vscode.Uri.file(this.file), { viewColumn: this.page.panel.viewColumn, preview: false });
					return;
			}
		} catch (err) {
			this.post({ type: 'error', message: errorMessage(err) });
		}
	}

	/**
	 * Writes the user's edit of one section to the plan file, unless the
	 * section in the file is no longer the `original` the user began from:
	 * the agent's newer text is never overwritten unseen.
	 */
	private async saveSection(section: string, text: string, original: string): Promise<void> {
		const current = await fs.readFile(this.file, 'utf8').catch(() => undefined);
		this.missing = current === undefined;
		this.markdown = current ?? '';
		const target = current === undefined ? undefined : planSections(current).find(each => each.id === section);
		if (current === undefined || !target) {
			this.postView();
			this.post({
				type: 'error',
				message: current === undefined
					? vscode.l10n.t("The plan file isn't there any more, so your edit wasn't saved. Here is your text.")
					: vscode.l10n.t("The plan changed while you were editing, and that section is no longer there. Your edit wasn't saved; here is your text."),
				text,
			});
			return;
		}
		if (target.markdown !== original) {
			this.postView();
			this.post({ type: 'conflict', section, mine: text, theirs: target.markdown });
			return;
		}
		const next = replaceSection(current, section, text)!;
		if (next !== current) {
			this.writing = next;
			await fs.writeFile(this.file, next, 'utf8');
			this.markdown = next;
			// The section may have a new id when its heading changed.
			const ids = new Set(planSections(next).map(each => each.id));
			const renamed = planSections(next).find(each => !planSections(current).some(old => old.id === each.id));
			await this.update(saved => ({
				edited: [...new Set([...saved.edited, section, ...renamed ? [renamed.id] : []].filter(id => ids.has(id)))],
				plan: next,
				planAt: Date.now(),
			}));
		}
		this.post({ type: 'saved' });
		this.postView();
	}

	/**
	 * Sends every unsent comment, and what the user edited, in one message;
	 * the agent revises the plan, and once that message's turn is over the
	 * page marks what changed. A message that never went (held back after a
	 * stopped turn, or taken out of the queue) leaves the comments unsent.
	 */
	private async send(): Promise<void> {
		const sections = planSections(this.markdown);
		const edited = this.saved.edited.flatMap(id => sections.filter(each => each.id === id).map(each => each.heading ?? each.opening));
		const text = reviewMessage(path.basename(this.file), this.saved.comments, edited, this.words());
		if (!text || this.sends.has(this.file)) {
			return;
		}
		const sending = this.deliver(text);
		this.sends.set(this.file, sending);
		try {
			await sending;
		} finally {
			this.sends.delete(this.file);
		}
	}

	private async deliver(text: string): Promise<void> {
		const sentAt = Date.now();
		const markdown = this.markdown;
		let sent = false;
		let failure: string | undefined;
		try {
			await this.update(saved => ({
				comments: saved.comments.map(each => each.sentAt ? each : { ...each, sentAt }),
				edited: [],
				before: markdown,
				revising: true,
				changed: [],
				unsend: { sentAt, edited: saved.edited, before: saved.before, changed: saved.changed },
			}));
			this.postView();
			sent = await this.host.send(this.agentId, text);
		} catch (err) {
			failure = errorMessage(err);
		}
		if (sent) {
			return this.finishRevision();
		}
		await this.update(unsentReview);
		this.postView();
		this.post({ type: 'error', message: failure ?? vscode.l10n.t("Your comments didn't go to Gemini: the turn before them was stopped or failed, or the message was taken out of the queue. Send them again when you're ready.") });
	}

	private async build(): Promise<void> {
		const open = this.saved.comments.filter(each => !each.sentAt).length;
		if (open) {
			const send = vscode.l10n.t("Send Comments First");
			const anyway = vscode.l10n.t("Build As It Is");
			const choice = await vscode.window.showWarningMessage(
				open === 1 ? vscode.l10n.t("Build the plan with 1 comment not sent?") : vscode.l10n.t("Build the plan with {0} comments not sent?", open),
				{ modal: true, detail: vscode.l10n.t("Gemini hasn't seen them. Send them first to have the plan revised, or build it as it is now, with your edits.") },
				send, anyway);
			if (choice === send) {
				await this.send();
				return;
			}
			if (choice !== anyway) {
				return;
			}
		}
		if (await this.host.build(this.agentId, this.words().build.replace('{0}', path.basename(this.file)))) {
			this.postView();
		}
	}

	private words(): ReviewWords {
		return {
			intro: vscode.l10n.t("Revise the plan in {0} using my review. Change only what the comments ask for, and keep my edits."),
			edited: vscode.l10n.t("I edited {0} myself."),
			comments: vscode.l10n.t("Comments:"),
			onSection: vscode.l10n.t("On \"{0}\" (\"{1}\")"),
			onText: vscode.l10n.t("On \"{0}\""),
			build: vscode.l10n.t("Carry out the plan in {0}."),
		};
	}

	private shell(): PageShell {
		// The Markdown renderer is a chunk of its own (media/draftMarkdown.js), loaded by the page's script.
		return { script: 'planReview.js', styles: ['planReview.css'], title: path.basename(this.file), bodyClass: 'plan-page', strings: planStrings(), media: { 'draft-markdown': 'draftMarkdown.js' }, loadsMedia: true };
	}

}

/** The page's words; exported for its tests. */
export function planStrings(): PlanStrings {
	return {
		from: vscode.l10n.t("Plan from \"{0}\""),
		saved: vscode.l10n.t("Saved"),
		saving: vscode.l10n.t("Saving…"),
		editedOne: vscode.l10n.t("Saved · your edits in 1 section"),
		editedMany: vscode.l10n.t("Saved · your edits in {0} sections"),
		commentsOne: vscode.l10n.t("1 comment"),
		commentsMany: vscode.l10n.t("{0} comments"),
		commentsHead: vscode.l10n.t("Comments"),
		toSend: vscode.l10n.t("{0} to send"),
		allSent: vscode.l10n.t("All sent"),
		onSection: vscode.l10n.t("On \u201c{0}\u201d"),
		sent: vscode.l10n.t("sent"),
		addTip: vscode.l10n.t("Comment on this section"),
		comment: vscode.l10n.t("Comment"),
		commentPlaceholder: vscode.l10n.t("What should change here?"),
		addComment: vscode.l10n.t("Add Comment"),
		addHint: process.platform === 'darwin' ? vscode.l10n.t("⌘↩ to add") : vscode.l10n.t("Ctrl+Enter to add"),
		cancel: vscode.l10n.t("Cancel"),
		edit: vscode.l10n.t("Edit"),
		delete: vscode.l10n.t("Delete"),
		save: vscode.l10n.t("Done"),
		editHint: process.platform === 'darwin' ? vscode.l10n.t("⌘↩ to save, Esc to cancel") : vscode.l10n.t("Ctrl+Enter to save, Esc to cancel"),
		editTip: vscode.l10n.t("Click, or press Enter, to edit this section"),
		editBusy: vscode.l10n.t("Gemini is working on the plan. You can edit it once its turn ends."),
		conflict: vscode.l10n.t("Gemini changed this section while you were editing, so your edit wasn't saved. Your text is still here: Done now saves it over Gemini's."),
		showNew: vscode.l10n.t("Show New Text"),
		hideNew: vscode.l10n.t("Hide New Text"),
		copyText: vscode.l10n.t("Copy Your Text"),
		showSection: vscode.l10n.t("Show the section this comment is on"),
		changedTag: vscode.l10n.t("changed"),
		foot: vscode.l10n.t("Your edits are saved to the plan file. Comments go to Gemini together, and it revises the plan."),
		build: vscode.l10n.t("Build This Plan"),
		buildShort: vscode.l10n.t("Build"),
		buildBusy: vscode.l10n.t("Build This Plan is offered once the agent's latest turn ends in Plan mode."),
		send: vscode.l10n.t("Send Comments to Gemini"),
		sendShort: vscode.l10n.t("Send Comments"),
		revising: vscode.l10n.t("Comments sent. Gemini is revising the plan; the page updates when it's done."),
		revisedOne: vscode.l10n.t("Gemini revised the plan: 1 section changed."),
		revisedMany: vscode.l10n.t("Gemini revised the plan: {0} sections changed."),
		revisedNone: vscode.l10n.t("Gemini's turn ended without changing the plan file."),
		showChanges: vscode.l10n.t("Show What Changed"),
		clearSent: vscode.l10n.t("Clear Sent Comments"),
		openSource: vscode.l10n.t("Open as Text"),
		empty: vscode.l10n.t("The plan file is empty."),
		missing: vscode.l10n.t("The plan file isn't there any more: it was moved or deleted."),
	};
}

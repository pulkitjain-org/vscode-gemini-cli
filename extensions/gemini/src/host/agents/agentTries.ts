/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Try in Workspace: an agent's work, from its worktree, in the user's
// checkout as unstaged changes, so their local server and tests use it. A
// tried agent's later turns follow into the checkout when they end; Keep
// Changes makes the work the user's (and resolves a thread), Take Back
// removes exactly what was applied, and Send My Edits gives the agent what
// the user changed meanwhile. Discard Changes resets the agent's folder,
// saved so Restore can bring it back. Nothing here commits to, stages in or
// merges into the user's branch; the files move with worktreeApply.ts, and
// the decisions are tryState.ts's.
//
// Loaded on first use (dist/onDemand.js): what it needs of the extension
// bundle's modules with state (the repository lock) comes through `host`.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentRecord, AgentsModel, AgentTried, DiscardedRepo, TriedRepo } from '../../acp/agents';
import { errorMessage } from '../../acp/errors';
import { afterTakeBack, changedKeys, discardOffer, editsToSend, foldersMoved, keptRepo, paused, settleConflicts, takeBackTree, triedPaths, withProblems } from '../../acp/tryState';
import { appliedAfterTry, appliedAfterUpdate, applyTrees, changedFiles, contains, deleteRef, deleteRefs, editedSince, filesWithMarkers, resetFolder, restoreSnapshot, saveSnapshot, sendEdits as sendEditTrees, setRef, snapshotTree, startOf, treeOf, treeWithEntries, type ApplyResult } from '../../acp/worktreeApply';
import { commitAll, git, repositoryRoot } from '../../acp/worktrees';
import { showError } from '../errorNotice';

/** What trying needs of the agents view and the extension bundle. */
export interface TriesHost {
	readonly model: AgentsModel;
	/** The extension bundle's repository lock, which worktree adds and pushes take too. */
	inRepository<T>(folder: string | readonly string[], task: () => Promise<T>): Promise<T>;
	/** Whether the agent is in a turn now. */
	busy(id: string): boolean;
	/** Adds a note the agent gets with its next prompt. */
	tell(id: string, text: string): void;
	/** The agent's try changed: its card, row and indicators show it. */
	changed(id: string): void;
	open(id: string): Promise<void>;
	log(message: string): void;
	/** The tried files the user edited and hasn't sent, for the agent's message box. */
	postEdits(id: string, files: readonly string[]): void;
	/** Marks a project thread resolved (kept) or open again. */
	setResolved(id: string, resolved: boolean): void;
}

/** Where an agent's work is tried: its worktree, the user's checkout it belongs to, and the branch it was made from. */
interface Target {
	readonly key: string;
	readonly repository: string;
	readonly worktree: string;
	readonly branch: string;
	readonly from: string;
}

/** What an apply left to tell the user about. */
interface Problems {
	readonly conflicts: string[];
	readonly unmerged: string[];
	readonly skipped: string[];
}

export class AgentTries implements vscode.Disposable {

	/** Each agent's last queued change: a second click runs after the first rather than being dropped. */
	private readonly queues = new Map<string, Promise<boolean>>();
	private readonly status: vscode.StatusBarItem;
	private readonly decorations = new vscode.EventEmitter<vscode.Uri[]>();
	/** Each tried file by absolute path, with the agent trying it: Source Control's badges, and which saves matter. */
	private tried = new Map<string, { readonly id: string; readonly title: string }>();
	/** Each checkout with a try: a watcher on its HEAD, to notice a commit of the tried files. */
	private readonly heads = new Map<string, vscode.Disposable>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly host: TriesHost) {
		this.status = vscode.window.createStatusBarItem('gemini.tries', vscode.StatusBarAlignment.Left, 50);
		this.status.name = vscode.l10n.t("Trying an Agent's Changes");
		this.status.command = 'gemini.tries.menu';
		this.disposables.push(
			this.status,
			this.decorations,
			vscode.window.registerFileDecorationProvider({
				onDidChangeFileDecorations: this.decorations.event,
				provideFileDecoration: uri => this.decorationFor(uri),
			}),
			host.model.onDidChange(() => this.refreshIndicators()),
			vscode.workspace.onDidSaveTextDocument(document => this.saved(document.uri)),
		);
		this.refreshIndicators();
		// A try left open last time: commits of its files are noticed again, and the message box offers the edits made meanwhile.
		this.watchHeads();
		void this.editsChanged();
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables, ...this.heads.values()).dispose();
		this.heads.clear();
	}

	/**
	 * Try in Workspace: applies the agent's work to the user's checkout as
	 * unstaged changes. Another agent tried in the same checkout is taken
	 * back first, if the user agrees.
	 */
	async tryIn(id: string): Promise<boolean> {
		const record = this.host.model.agent(id);
		if (!record?.worktree || record.tried?.state === 'trying' || this.refuseBusy(record)) {
			return false;
		}
		const targets = await this.targets(record);
		if (!targets.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" has no checkout to try its work in.", record.title));
			return false;
		}
		// Where the agent started in each repository: its changes are what it did since, whatever the checkout has out now.
		const kept = record.tried?.state === 'kept' ? record.tried.repos : [];
		const starts: (string | undefined)[] = [];
		for (const target of targets) {
			const before = kept.find(repo => repo.key === target.key);
			const start = before?.start ?? (before ? undefined : await startOf(target.repository, target.branch, target.from));
			if (!before && !start) {
				void showError(vscode.l10n.t("{0} and your checkout have no history in common.", target.branch));
				return false;
			}
			starts.push(start);
		}
		const older = (await Promise.all(targets.map(async (target, i) => starts[i] && !await contains(target.repository, starts[i]) ? target : undefined))).filter(target => !!target);
		if (older.length) {
			const anyway = vscode.l10n.t("Try Anyway");
			if (await vscode.window.showWarningMessage(vscode.l10n.t("Your checkout doesn't have the commit \"{0}\" started from.", record.title), { modal: true, detail: vscode.l10n.t("{0} is on an older branch or one without that commit, so the changes may not fit. Only the agent's own changes are tried; files that don't merge get conflict markers.", older.map(target => path.basename(target.repository)).join(', ')) }, anyway) !== anyway) {
				return false;
			}
		}
		const other = this.host.model.agents.find(agent => agent.id !== id && agent.tried?.state === 'trying' && agent.tried.repos.some(repo => targets.some(target => samePath(target.repository, repo.repository))));
		if (other) {
			const swap = vscode.l10n.t("Take Back and Try");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("You're trying \"{0}\" in this workspace.", other.title), { modal: true, detail: vscode.l10n.t("One agent's changes are tried at a time. Take back \"{0}\" and try \"{1}\"?", other.title, record.title) }, swap) !== swap) {
				return false;
			}
			if (!await this.takeBack(other.id, true)) {
				return false;
			}
		}
		return this.exclusive(id, async () => {
			const record = this.host.model.agent(id);
			if (!record || record.tried?.state === 'trying') {
				return false;
			}
			const kept = record.tried?.state === 'kept' ? record.tried.repos : [];
			// Every repository's trees first, so nothing is written when one can't be read.
			const plans = [];
			for (const [i, target] of targets.entries()) {
				const before = kept.find(repo => repo.key === target.key);
				const start = starts[i] ?? before?.start;
				if (!before && !start) {
					return false;
				}
				const base = before?.base ?? await treeOf(target.repository, start!);
				const from = before?.tree ?? base;
				const tree = await this.host.inRepository(target.worktree, () => snapshotTree(target.worktree));
				plans.push({ target, before, start, base, from, tree, files: await changedFiles(target.repository, base, tree), writes: await changedFiles(target.repository, from, tree) });
			}
			if (!plans.some(plan => plan.files.length)) {
				void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" hasn't changed any files yet.", record.title));
				return false;
			}
			if (this.refuseUnsaved(plans.flatMap(plan => plan.writes.map(file => path.join(plan.target.repository, file))))) {
				return false;
			}
			const repos: TriedRepo[] = [];
			const problems: Problems = { conflicts: [], unmerged: [], skipped: [] };
			try {
				for (const plan of plans) {
					const { target, before } = plan;
					await this.host.inRepository([target.repository, target.worktree], async () => {
						const result = await applyTrees(target.repository, target.repository, plan.from, plan.tree, { labels: this.labels(record), paths: plan.writes });
						collect(problems, result);
						// Recorded as soon as it's written, so a failure below can't lose it.
						const repo = withProblems({ key: target.key, repository: target.repository, worktree: target.worktree, base: plan.base, ...plan.start ? { start: plan.start } : {}, tree: plan.tree, ...before ? { kept: before.tree } : {}, files: plan.files }, { ...result, deferred: [] });
						repos.push(repo);
						// What Try wrote, as it is on disk now: the user's edits are measured from it, not from what they had before.
						repos[repos.length - 1] = { ...repo, applied: await appliedAfterTry(target.repository, plan.tree, target.repository, plan.files, result.conflicts) };
					});
				}
			} finally {
				// What was applied is recorded even when a later repository failed, so Take Back can remove it.
				if (repos.length) {
					this.host.model.setTried(id, { state: 'trying', repos, at: Date.now() });
					this.host.setResolved(id, false);
					this.watchHeads();
				}
			}
			this.report(record, problems);
			void this.editsChanged();
			return true;
		});
	}

	/** At the end of an agent's turn: a tried agent's new work follows into the checkout, and a discarded one's new work moves Restore to the card's ⋯ menu. */
	async turnEnded(id: string): Promise<void> {
		const record = this.host.model.agent(id);
		if (record?.tried) {
			await this.follow(id);
		}
		if (record?.discarded?.length) {
			await this.exclusive(id, async () => {
				const record = this.host.model.agent(id);
				if (!record?.discarded?.length || discardOffer(record.discarded) === 'menu' || !await this.discardedMoved(record)) {
					return false;
				}
				// Kept, as nothing else holds it: the card's ⋯ menu still offers it, and Remove Thread deletes it.
				this.host.model.setDiscarded(id, record.discarded.map(repo => ({ ...repo, superseded: true })));
				return true;
			});
		}
	}

	/** After the agent's turn: a tried agent's new work follows into the checkout. Quiet when nothing changed. */
	async follow(id: string): Promise<void> {
		if (!this.host.model.agent(id)?.tried || this.host.busy(id)) {
			return;
		}
		await this.exclusive(id, async () => {
			const first = this.host.model.agent(id);
			if (!first?.tried || this.host.busy(id)) {
				return false;
			}
			// Committed by the user meanwhile: kept, and what follows is tried on top.
			if (first.tried.state === 'trying' && await this.committed(first.tried)) {
				await this.markKept(first, first.tried);
			}
			const record = this.host.model.agent(id);
			if (!record?.tried) {
				return false;
			}
			// A turn after Keep Changes is the user asking for more: its work is tried on top of what was kept.
			// Updating waits while the last update's conflict markers are still there.
			const before = await this.settle(id, record.tried);
			if (paused(before)) {
				return false;
			}
			const repos = [...before.repos];
			const problems: Problems = { conflicts: [], unmerged: [], skipped: [] };
			const changed: string[] = [];
			let moved = false;
			try {
				for (const [i, repo] of before.repos.entries()) {
					await this.host.inRepository([repo.repository, repo.worktree], async () => {
						const tree = await snapshotTree(repo.worktree);
						if (tree === repo.tree) {
							return;
						}
						const unsaved = this.unsaved(repo.repository);
						const result = await applyTrees(repo.repository, repo.repository, repo.tree, tree, { labels: this.labels(record), skip: file => unsaved.has(file) });
						collect(problems, result);
						changed.push(...result.changed);
						const { kept: _kept, applied: _applied, ...rest } = repo;
						const kept = repo.kept ?? (before.state === 'kept' ? repo.tree : undefined);
						const problemsHere = { conflicts: result.conflicts, unmerged: result.unmerged };
						// Recorded as soon as it's written, so a failure below can't lose it; until then, held-back files count as updated.
						repos[i] = withProblems({ ...rest, tree, ...kept ? { kept } : {}, files: [...new Set([...repo.files, ...result.changed])] }, { ...problemsHere, deferred: [] });
						moved = true;
						// Files held back stay at their old version in the record, so the next update (on save) brings them.
						const recorded = result.skipped.length ? await treeWithEntries(repo.repository, tree, repo.tree, result.skipped) : tree;
						const applied = await appliedAfterUpdate(repo.repository, repo.applied ?? repo.tree, repo.tree, recorded, result.conflicts);
						repos[i] = withProblems({ ...rest, tree: recorded, applied, ...kept ? { kept } : {}, files: await changedFiles(repo.repository, repo.base, recorded) }, { ...problemsHere, deferred: result.skipped });
					});
				}
			} finally {
				if (moved) {
					const touched = changed.length + problems.conflicts.length + problems.unmerged.length > 0;
					const updates = (before.updates ?? 0) + (touched ? 1 : 0);
					this.host.model.setTried(id, { state: 'trying', repos, at: Date.now(), ...updates ? { updates } : {} });
					this.host.setResolved(id, false);
					this.watchHeads();
				}
			}
			if (!moved) {
				return false;
			}
			if (problems.conflicts.length || problems.unmerged.length || problems.skipped.length) {
				this.report(record, problems);
			} else if (changed.length) {
				const names = [...new Set(changed)].map(file => path.basename(file));
				const keep = vscode.l10n.t("Keep Changes");
				const show = vscode.l10n.t("Show Changes");
				const message = names.length === 1 ? vscode.l10n.t("\"{0}\" updated {1} in your workspace.", record.title, names[0]) : vscode.l10n.t("\"{0}\" updated {1} files in your workspace: {2}.", record.title, names.length, names.join(', '));
				void Promise.resolve(vscode.window.showInformationMessage(message, show, keep)).then(choice => {
					if (choice === keep) {
						void this.keep(id);
					} else if (choice === show) {
						void vscode.commands.executeCommand('workbench.view.scm');
					}
				});
			}
			void this.editsChanged();
			return true;
		});
	}

	/** Keep Changes: the tried work is the user's now. Commits it on the agent's own branch, so its folder can be cleaned up and rebuilt. */
	async keep(id: string): Promise<boolean> {
		const record = this.host.model.agent(id);
		if (!record || record.tried?.state !== 'trying' || this.refuseBusy(record)) {
			return false;
		}
		return this.exclusive(id, async () => {
			const record = this.host.model.agent(id);
			const now = record?.tried;
			if (!record || now?.state !== 'trying' || this.refuseBusy(record)) {
				return false;
			}
			const tried = await this.settle(id, now);
			const marked = tried.repos.flatMap(repo => repo.conflicts ?? []);
			if (marked.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Resolve the conflict markers in {0} first.", names(marked)));
				return false;
			}
			await this.commitOnBranch(record);
			const repos = tried.repos.map(keptRepo);
			this.host.model.setTried(id, { state: 'kept', repos, at: Date.now(), ...tried.updates ? { updates: tried.updates } : {} });
			this.host.setResolved(id, true);
			this.watchHeads();
			const files = repos.reduce((sum, repo) => sum + repo.files.length, 0);
			const scm = vscode.l10n.t("Open Source Control");
			void Promise.resolve(vscode.window.showInformationMessage(files === 1 ? vscode.l10n.t("Kept 1 file from \"{0}\". Commit it when you're ready.", record.title) : vscode.l10n.t("Kept {0} files from \"{1}\". Commit them when you're ready.", files, record.title), scm)).then(choice => choice === scm && vscode.commands.executeCommand('workbench.view.scm'));
			return true;
		});
	}

	/** Take Back: removes exactly what was tried; the user's own edits, sent or not, stay. Back to what was kept, when some was. */
	async takeBack(id: string, quiet = false): Promise<boolean> {
		if (this.host.model.agent(id)?.tried?.state !== 'trying') {
			return false;
		}
		return this.exclusive(id, async () => {
			const record = this.host.model.agent(id);
			const tried = record?.tried;
			if (!record || tried?.state !== 'trying') {
				return false;
			}
			if (await this.committed(tried)) {
				await this.markKept(record, tried);
				void vscode.window.showInformationMessage(vscode.l10n.t("The changes from \"{0}\" are in a commit now, so they're kept.", record.title));
				return false;
			}
			const writes = await Promise.all(tried.repos.map(async repo => (await changedFiles(repo.repository, repo.tree, takeBackTree(repo))).map(file => path.join(repo.repository, file))));
			if (this.refuseUnsaved(writes.flat())) {
				return false;
			}
			const problems: Problems = { conflicts: [], unmerged: [], skipped: [] };
			const done = new Set<string>();
			let changed = 0;
			try {
				for (const repo of tried.repos) {
					const result = await this.host.inRepository(repo.repository, () => applyTrees(repo.repository, repo.repository, repo.tree, takeBackTree(repo), { labels: this.labels(record) }));
					collect(problems, result);
					changed += result.changed.length;
					done.add(repo.key);
				}
			} finally {
				const next = afterTakeBack(tried, done, Date.now());
				this.host.model.setTried(id, next);
				if (next?.state === 'kept') {
					this.host.setResolved(id, true);
				}
				this.watchHeads();
			}
			if (problems.conflicts.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Took back the changes from \"{0}\", except {1}: you changed the same lines, so it has conflict markers to resolve.", record.title, names(problems.conflicts)));
			}
			if (problems.unmerged.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Took back the changes from \"{0}\", except {1}: it couldn't be merged with your edits (a binary file, a link, or deleted on one side), so it's left as it is.", record.title, names(problems.unmerged)));
			}
			// Files whose sent edits clashed with the thread's lines are left as the user has them, the thread's change in them included.
			const mixed = tried.repos.filter(repo => done.has(repo.key)).flatMap(repo => repo.mixed ?? []);
			if (mixed.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Took back the changes from \"{0}\", except in {1}: the edits you sent there clashed with its changes, so the file is left as you have it, its changes included.", record.title, names(mixed)));
			}
			if (!problems.conflicts.length && !problems.unmerged.length && !mixed.length && !quiet) {
				void vscode.window.showInformationMessage(changed === 1 ? vscode.l10n.t("Took back 1 file from \"{0}\". Your own edits stay; Try in Workspace brings it back.", record.title) : vscode.l10n.t("Took back {0} files from \"{1}\". Your own edits stay; Try in Workspace brings them back.", changed, record.title));
			}
			this.host.postEdits(id, []);
			return true;
		});
	}

	/** The tried files the user edited since Try last wrote them, not counting ones with conflict markers. */
	async editsOf(id: string): Promise<string[]> {
		const tried = this.host.model.agent(id)?.tried;
		if (tried?.state !== 'trying') {
			return [];
		}
		const edits: string[] = [];
		for (const repo of tried.repos) {
			const edited = await editedSince(repo.repository, repo.repository, repo.applied ?? repo.tree, repo.files).catch(() => []);
			edits.push(...editsToSend(repo, edited, await filesWithMarkers(repo.repository, edited), tried.repos.length));
		}
		return edits;
	}

	/**
	 * Send My Edits: copies the user's edits to tried files into the agent's
	 * folder, so its next turn builds on them. Take Back keeps them in the
	 * checkout, as they are the user's.
	 */
	async sendEdits(id: string, quiet = false): Promise<boolean> {
		const record = this.host.model.agent(id);
		if (!record || record.tried?.state !== 'trying' || this.refuseBusy(record)) {
			return false;
		}
		return this.exclusive(id, async () => {
			const record = this.host.model.agent(id);
			const tried = record?.tried;
			if (!record || tried?.state !== 'trying' || this.refuseBusy(record)) {
				return false;
			}
			const sent: string[] = [];
			const problems: Problems = { conflicts: [], unmerged: [], skipped: [] };
			const repos = [...tried.repos];
			let any = false;
			try {
				for (const [i, repo] of tried.repos.entries()) {
					const applied = repo.applied ?? repo.tree;
					const edited = await editedSince(repo.repository, repo.repository, applied, repo.files);
					const marked = await filesWithMarkers(repo.repository, edited);
					const files = edited.filter(file => !marked.includes(file));
					if (!files.length) {
						continue;
					}
					repos[i] = await this.host.inRepository([repo.repository, repo.worktree], async () => {
						// The user's edits: what they changed in these files since Try wrote them, and nothing they had before.
						// The checkout holds them already: updates start from the thread's tree with them, and Take Back returns to its tree with them.
						const done = await sendEditTrees(repo.repository, repo.worktree, { tree: repo.tree, applied, back: takeBackTree(repo) }, files, { ours: record.title, theirs: vscode.l10n.t("your edits") });
						collect(problems, done.result);
						const prefix = tried.repos.length > 1 ? `${repo.key}/` : '';
						sent.push(...files.filter(file => !done.result.unmerged.includes(file)).map(file => prefix + file));
						const mixed = [...new Set([...repo.mixed ?? [], ...done.mixed])];
						const { mixed: _mixed, ...rest } = repo;
						return { ...rest, tree: done.tree, back: done.back, applied: done.applied, ...mixed.length ? { mixed } : {}, files: await changedFiles(repo.repository, repo.base, done.tree) };
					});
					any = true;
				}
			} finally {
				if (any) {
					this.host.model.setTried(id, { ...tried, repos });
				}
			}
			void this.editsChanged();
			if (!sent.length && !problems.unmerged.length) {
				if (!quiet) {
					void vscode.window.showInformationMessage(vscode.l10n.t("You haven't changed any of the tried files since the last update."));
				}
				return false;
			}
			if (sent.length) {
				const clashed = problems.conflicts.length ? ` These now have conflict markers in your folder, where the user's edits clashed with yours; resolve them first: ${problems.conflicts.join(', ')}.` : '';
				this.host.tell(id, `The user edited these files in their workspace while testing your changes, and copied the edits into your folder: ${sent.join(', ')}. Read them before changing those files again, and build on the user's edits rather than undoing them.${clashed}`);
			}
			if (problems.conflicts.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Sent your edits to \"{0}\", but {1} clashed with its changes: the file has conflict markers in its folder, and it's been told to resolve them.", record.title, names(problems.conflicts)));
			}
			if (problems.unmerged.length) {
				void vscode.window.showWarningMessage(vscode.l10n.t("Couldn't send your edits to {0} to \"{1}\": it can't be merged (a binary file, a link, or deleted on one side).", names(problems.unmerged), record.title));
			}
			if (!quiet && sent.length && !problems.conflicts.length) {
				void vscode.window.showInformationMessage(sent.length === 1 ? vscode.l10n.t("Sent your edits to {0} to \"{1}\".", path.basename(sent[0]), record.title) : vscode.l10n.t("Sent your edits to {0} files to \"{1}\".", sent.length, record.title));
			}
			return sent.length > 0;
		});
	}

	/** Opens the first tried file that still has conflict markers; with none left, updating carries on. */
	async openConflict(id: string): Promise<void> {
		let open: string | undefined;
		await this.exclusive(id, async () => {
			const tried = this.host.model.agent(id)?.tried;
			if (!tried) {
				return false;
			}
			const repo = (await this.settle(id, tried)).repos.find(repo => repo.conflicts?.length);
			open = repo && path.join(repo.repository, repo.conflicts![0]);
			return true;
		});
		if (open) {
			await vscode.window.showTextDocument(vscode.Uri.file(open));
			return;
		}
		await this.follow(id);
	}

	/** Discard Changes: saves the agent's folder, then resets it to where it started. A try is taken back first. */
	async discard(id: string): Promise<boolean> {
		const record = this.host.model.agent(id);
		if (!record?.worktree || this.refuseBusy(record)) {
			return false;
		}
		if (discardOffer(record.discarded) === 'restore' && !await this.discardedMoved(record)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" has no changes since you discarded them.", record.title));
			return false;
		}
		const discard = vscode.l10n.t("Discard Changes");
		const detail = record.tried?.state === 'trying'
			? vscode.l10n.t("Its folder goes back to where it started, and its changes are taken out of your workspace. They're saved, so Restore can bring them back. The thread and its conversation stay.")
			: vscode.l10n.t("Its folder goes back to where it started. The changes are saved, so Restore can bring them back. The thread and its conversation stay.");
		// Work discarded before stays saved, though Restore then brings back this newer work.
		const earlier = record.discarded?.length ? vscode.l10n.t("The work you discarded before stays saved in git, under refs/geminicode/discarded/, until you remove the thread.") : undefined;
		if (await vscode.window.showWarningMessage(vscode.l10n.t("Discard the changes of \"{0}\"?", record.title), { modal: true, detail: earlier ? `${detail}\n\n${earlier}` : detail }, discard) !== discard) {
			return false;
		}
		if (record.tried?.state === 'trying' && !await this.takeBack(id, true)) {
			return false;
		}
		return this.exclusive(id, async () => {
			const record = this.host.model.agent(id);
			if (!record?.worktree || this.refuseBusy(record) || record.tried?.state === 'trying') {
				return false;
			}
			// Work saved by an earlier Discard keeps a ref of its own, which Remove Thread deletes with the rest.
			const at = Date.now();
			for (const repo of record.discarded ?? []) {
				await setRef(repo.folder, `${discardRef(id, repo.key)}-earlier-${at}`, repo.commit);
			}
			const saved: DiscardedRepo[] = [];
			try {
				for (const target of await this.targets(record)) {
					const start = await startOf(target.repository, target.branch, target.from);
					if (!start) {
						throw new Error(vscode.l10n.t("{0} and your checkout have no history in common.", target.branch));
					}
					saved.push(await this.host.inRepository([target.repository, target.worktree], async () => {
						const snapshot = await saveSnapshot(target.worktree, discardRef(id, target.key), `Discarded "${record.title}"`);
						await resetFolder(target.worktree, start);
						return { key: target.key, folder: target.worktree, commit: snapshot.commit, head: snapshot.head, reset: await treeOf(target.worktree, start) };
					}));
				}
			} finally {
				if (saved.length) {
					this.host.model.setDiscarded(id, saved);
				}
			}
			if (this.host.model.agent(id)?.tried?.state === 'kept') {
				// What was kept is the user's; the agent's folder no longer has it.
				this.host.model.setTried(id, undefined);
			}
			this.host.tell(id, 'The user discarded all your changes: your folder is back where it started. Don\'t build on that earlier work; ask the user what they want instead.');
			return true;
		});
	}

	/** Restore: puts the work Discard Changes saved back in the agent's folder; newer work there is saved first, if the user agrees. */
	async restore(id: string): Promise<boolean> {
		const record = this.host.model.agent(id);
		if (!record?.discarded?.length || this.refuseBusy(record)) {
			return false;
		}
		const moved = await this.discardedMoved(record);
		if (moved) {
			const replace = vscode.l10n.t("Save and Restore");
			if (await vscode.window.showWarningMessage(vscode.l10n.t("\"{0}\" changed files since you discarded its work.", record.title), { modal: true, detail: vscode.l10n.t("Restore puts the discarded work back in its folder in place of what's there now. What's there now is saved in git first, under refs/geminicode/discarded/.") }, replace) !== replace) {
				return false;
			}
		}
		return this.exclusive(id, async () => {
			const record = this.host.model.agent(id);
			if (!record?.discarded?.length || this.refuseBusy(record)) {
				return false;
			}
			const left = [...record.discarded];
			try {
				for (const repo of record.discarded) {
					await this.host.inRepository(repo.folder, async () => {
						if (moved) {
							await saveSnapshot(repo.folder, `${discardRef(id, repo.key)}-replaced-${Date.now()}`, `Replaced by Restore of "${record.title}"`);
						}
						await restoreSnapshot(repo.folder, repo.commit, repo.head);
						await deleteRef(repo.folder, discardRef(id, repo.key)).catch(() => undefined);
					});
					left.shift();
				}
			} finally {
				this.host.model.setDiscarded(id, left);
			}
			this.host.tell(id, 'The user restored the changes they had discarded: your folder has your earlier work again.');
			void vscode.window.showInformationMessage(vscode.l10n.t("Restored the changes of \"{0}\" in its folder. Try in Workspace to see them.", record.title));
			return true;
		});
	}

	/** Before an agent is removed: deletes what Discard Changes (and Restore over newer work) saved of its folders. */
	async forget(id: string): Promise<void> {
		const record = this.host.model.agent(id);
		if (record?.worktree) {
			await this.forgetDiscarded(record).catch(err => this.host.log(`Couldn't delete the saved work of "${record.title}": ${errorMessage(err)}`));
		}
	}

	/**
	 * Before an agent whose work is tried is removed: asks whether to keep the
	 * changes or take them back. Resolves false when the user cancels.
	 */
	async beforeRemove(id: string): Promise<boolean> {
		const record = this.host.model.agent(id);
		if (record?.tried?.state !== 'trying') {
			return true;
		}
		const files = record.tried.repos.reduce((sum, repo) => sum + repo.files.length, 0);
		const keep = vscode.l10n.t("Keep Changes and Remove");
		const back = vscode.l10n.t("Take Back and Remove");
		const choice = await vscode.window.showWarningMessage(vscode.l10n.t("Remove \"{0}\"?", record.title), { modal: true, detail: files === 1 ? vscode.l10n.t("You're trying its changes: 1 file in your workspace. Keep it as your own change, or take it back first.") : vscode.l10n.t("You're trying its changes: {0} files in your workspace. Keep them as your own changes, or take them back first.", files) }, keep, back);
		if (choice === back) {
			return this.takeBack(id, true);
		}
		if (choice === keep) {
			this.host.model.setTried(id, undefined);
			return true;
		}
		return false;
	}

	/** Whether a kept thread's folder holds nothing beyond what was kept, so Clean Up may remove it. */
	async keptClean(record: AgentRecord): Promise<boolean> {
		const tried = record.tried;
		if (tried?.state !== 'kept') {
			return false;
		}
		for (const repo of tried.repos) {
			const tree = await snapshotTree(repo.worktree).catch(() => undefined);
			const head = await treeOf(repo.worktree, 'HEAD').catch(() => undefined);
			if (!tree || tree !== repo.tree || head !== tree) {
				return false;
			}
		}
		return true;
	}

	private async commitOnBranch(record: AgentRecord): Promise<void> {
		for (const target of await this.targets(record)) {
			try {
				const status = await git(target.worktree, ['status', '--porcelain']);
				if (status.trim()) {
					await this.host.inRepository([target.repository, target.worktree], () => commitAll(target.worktree, record.title));
				}
			} catch (err) {
				// The folder stays as it is; Clean Up then leaves it alone.
				this.host.log(`Couldn't commit the kept work of "${record.title}" on its branch: ${errorMessage(err)}`);
			}
		}
	}

	/** Whether the tried files are committed now with the tried content: the user kept them their own way. */
	private async committed(tried: AgentTried): Promise<boolean> {
		for (const repo of tried.repos) {
			if (!repo.files.length) {
				continue;
			}
			const head = await treeOf(repo.repository, 'HEAD').catch(() => undefined);
			if (!head) {
				return false;
			}
			const differ = await git(repo.repository, ['diff', '--name-only', head, repo.tree, '--', ...repo.files]).catch(() => 'x');
			if (differ.trim()) {
				return false;
			}
		}
		return tried.repos.some(repo => repo.files.length);
	}

	/** Records the try as kept. Its work is committed on the agent's branch unless the agent is in a turn, which that would cut into. */
	private async markKept(record: AgentRecord, tried: AgentTried): Promise<void> {
		if (!this.host.busy(record.id)) {
			await this.commitOnBranch(record);
		}
		this.host.model.setTried(record.id, { state: 'kept', repos: tried.repos.map(keptRepo), at: Date.now() });
		this.host.setResolved(record.id, true);
		this.watchHeads();
	}

	/** A commit in a checkout with a try: tried files committed as they were tried count as kept. A busy agent's is noticed when its turn ends. */
	private headMoved(repository: string): void {
		for (const record of this.host.model.agents) {
			if (record.tried?.state === 'trying' && record.tried.repos.some(repo => samePath(repo.repository, repository)) && !this.host.busy(record.id)) {
				void this.exclusive(record.id, async () => {
					const now = this.host.model.agent(record.id);
					if (now?.tried?.state !== 'trying' || this.host.busy(record.id) || !await this.committed(now.tried)) {
						return false;
					}
					await this.markKept(now, now.tried);
					return true;
				});
			}
		}
	}

	private watchHeads(): void {
		const repositories = new Set(this.host.model.agents.flatMap(record => record.tried?.state === 'trying' ? record.tried.repos.map(repo => repo.repository) : []));
		for (const [repository, watcher] of this.heads) {
			if (!repositories.has(repository)) {
				watcher.dispose();
				this.heads.delete(repository);
			}
		}
		for (const repository of repositories) {
			if (this.heads.has(repository)) {
				continue;
			}
			const placeholder = new vscode.Disposable(() => undefined);
			this.heads.set(repository, placeholder);
			void git(repository, ['rev-parse', '--absolute-git-dir']).then(dir => {
				if (this.heads.get(repository) !== placeholder) {
					return;
				}
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir.trim()), 'logs/HEAD'));
				let timer: ReturnType<typeof setTimeout> | undefined;
				const moved = () => {
					clearTimeout(timer);
					timer = setTimeout(() => this.headMoved(repository), 500);
				};
				this.heads.set(repository, vscode.Disposable.from(watcher, watcher.onDidChange(moved), watcher.onDidCreate(moved), new vscode.Disposable(() => clearTimeout(timer))));
			}, () => undefined);
		}
	}

	/**
	 * The try with its problems as they are now, recorded when they changed:
	 * conflict files whose markers are gone, and unmerged files that now hold
	 * the thread's version, no longer count.
	 */
	private async settle(id: string, tried: AgentTried): Promise<AgentTried> {
		const repos = await Promise.all(tried.repos.map(async repo => {
			if (!repo.conflicts?.length && !repo.unmerged?.length) {
				return repo;
			}
			const marked = await filesWithMarkers(repo.repository, repo.conflicts ?? []);
			const differ = repo.unmerged?.length ? await editedSince(repo.repository, repo.repository, repo.tree, repo.unmerged).catch(() => repo.unmerged!) : [];
			return settleConflicts(repo, marked, (repo.unmerged ?? []).filter(file => !differ.includes(file)));
		}));
		if (repos.every((repo, i) => repo === tried.repos[i])) {
			return tried;
		}
		const next = { ...tried, repos };
		this.host.model.setTried(id, next);
		return next;
	}

	/** Where the agent's work is tried: each worktree with the user's checkout it belongs to. */
	private async targets(record: AgentRecord): Promise<Target[]> {
		if (record.repos?.length) {
			return record.repos.map(repo => ({ key: repo.key, repository: repo.repository, worktree: repo.folder, branch: repo.branch, from: repo.base }));
		}
		const workspace = record.worktree && this.host.model.workspace(record.workspaceId);
		const repository = workspace && await repositoryRoot(workspace.folder);
		return repository && record.worktree ? [{ key: '', repository, worktree: record.worktree.folder, branch: record.worktree.branch, from: record.worktree.base }] : [];
	}

	/** Whether a discarded agent's folders hold anything but what Discard reset them to. */
	private async discardedMoved(record: AgentRecord): Promise<boolean> {
		const saved = record.discarded ?? [];
		const targets = saved.some(repo => !repo.reset) ? await this.targets(record) : [];
		const resets = await Promise.all(saved.map(async repo => {
			if (repo.reset) {
				return repo.reset;
			}
			// Saved before the reset point was kept: where the branch started.
			const target = targets.find(target => target.key === repo.key);
			const start = target && await startOf(target.repository, target.branch, target.from);
			return start ? treeOf(repo.folder, start).catch(() => undefined) : undefined;
		}));
		const now = await Promise.all(saved.map(repo => snapshotTree(repo.folder).catch(() => undefined)));
		return foldersMoved(resets, now);
	}

	/** Deletes everything Discard Changes (and Restore over newer work) saved of the agent's folders, and forgets it. */
	private async forgetDiscarded(record: AgentRecord): Promise<void> {
		const folders = new Map<string, string>();
		for (const repo of record.discarded ?? []) {
			folders.set(repo.key, repo.folder);
		}
		for (const target of await this.targets(record)) {
			folders.set(target.key, target.repository);
		}
		for (const [key, folder] of folders) {
			await deleteRefs(folder, discardRef(record.id, key)).catch(() => undefined);
		}
		if (record.discarded?.length) {
			this.host.model.setDiscarded(record.id, undefined);
		}
	}

	private labels(record: AgentRecord): { ours: string; theirs: string } {
		return { ours: vscode.l10n.t("your workspace"), theirs: record.title };
	}

	private refuseBusy(record: AgentRecord): boolean {
		if (this.host.busy(record.id)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" is working. Try again once its turn ends.", record.title));
			return true;
		}
		return false;
	}

	/** The files under `repository` open with unsaved edits, relative to it. */
	private unsaved(repository: string): Set<string> {
		const top = path.resolve(repository) + path.sep;
		return new Set(vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file' && path.resolve(document.uri.fsPath).startsWith(top)).map(document => path.relative(top, path.resolve(document.uri.fsPath)).split(path.sep).join('/')));
	}

	/** Says which of `files` (absolute) have unsaved edits, which writing them would lose; true when any do. */
	private refuseUnsaved(files: readonly string[]): boolean {
		const wanted = new Set(files.map(file => path.resolve(file)));
		const dirty = vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file' && wanted.has(path.resolve(document.uri.fsPath)));
		if (dirty.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Save or revert {0} first: this would change it, and your unsaved edits would be lost.", dirty.map(document => path.basename(document.uri.fsPath)).join(', ')));
			return true;
		}
		return false;
	}

	/**
	 * Runs `task` once the agent's earlier changes are done: a click during an
	 * update waits for it rather than being dropped. The task reads the
	 * agent's record afresh, as the earlier ones may have changed it.
	 */
	private exclusive(id: string, task: () => Promise<boolean>): Promise<boolean> {
		const run = (this.queues.get(id) ?? Promise.resolve(true)).then(async () => {
			try {
				return await task();
			} catch (err) {
				void showError(vscode.l10n.t("Couldn't move the changes of \"{0}\": {1}", this.host.model.agent(id)?.title ?? '', errorMessage(err)));
				return false;
			} finally {
				this.host.changed(id);
			}
		});
		this.queues.set(id, run);
		void run.then(() => {
			if (this.queues.get(id) === run) {
				this.queues.delete(id);
			}
		});
		return run;
	}

	private report(record: AgentRecord, problems: Problems): void {
		if (problems.conflicts.length) {
			const open = vscode.l10n.t("Open File");
			void Promise.resolve(vscode.window.showWarningMessage(vscode.l10n.t("\"{0}\" changed the same lines as you in {1}: it has conflict markers to resolve. Updating waits until it's resolved.", record.title, names(problems.conflicts)), open)).then(choice => {
				if (choice === open) {
					void this.openConflict(record.id);
				}
			});
		}
		if (problems.unmerged.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Couldn't merge the changes of \"{0}\" to {1} with yours (a binary file, a link, or deleted on one side), so it's left as you have it.", record.title, names(problems.unmerged)));
		}
		if (problems.skipped.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("\"{0}\" didn't update {1}: it has unsaved edits. It updates when you save it.", record.title, names(problems.skipped)));
		}
	}

	/** A save: the agent's message box offers to send an edit to a tried file, and a file an update held back for it is brought now. */
	private saved(uri: vscode.Uri): void {
		const owner = uri.scheme === 'file' ? this.tried.get(path.resolve(uri.fsPath)) : undefined;
		if (!owner) {
			return;
		}
		const tried = this.host.model.agent(owner.id)?.tried;
		const listed = (lists: (repo: TriedRepo) => readonly string[] | undefined) => !!tried?.repos.some(repo => lists(repo)?.some(file => samePath(path.join(repo.repository, file), uri.fsPath)));
		if (listed(repo => repo.conflicts)) {
			// A conflict resolved and saved: the card stops saying updating is paused, and updating carries on.
			void this.exclusive(owner.id, async () => {
				const now = this.host.model.agent(owner.id)?.tried;
				return !!now && await this.settle(owner.id, now) !== now;
			}).then(() => this.follow(owner.id));
		} else if (listed(repo => repo.deferred)) {
			void this.follow(owner.id);
		}
		void this.editsChanged(owner.id);
	}

	private async editsChanged(only?: string): Promise<void> {
		for (const record of this.host.model.agents) {
			if (record.tried?.state === 'trying' && (!only || record.id === only)) {
				this.host.postEdits(record.id, await this.editsOf(record.id).catch(() => []));
			}
		}
	}

	private refreshIndicators(): void {
		const trying = this.host.model.agents.filter(record => record.tried?.state === 'trying');
		if (trying.length) {
			this.status.text = trying.length === 1 ? `$(beaker) ${vscode.l10n.t("Trying: {0}", trying[0].title)}` : `$(beaker) ${vscode.l10n.t("Trying {0} agents' changes", trying.length)}`;
			this.status.tooltip = vscode.l10n.t("These changes are in your workspace, unstaged. Keep them, or take them back.");
			this.status.show();
		} else {
			this.status.hide();
		}
		// Badges change only when the tried files do, not on every change to the agents.
		const next = triedPaths(this.host.model.agents);
		const changed = changedKeys(this.tried, next);
		this.tried = next;
		if (changed.length) {
			this.decorations.fire(changed.map(file => vscode.Uri.file(file)));
		}
	}

	private decorationFor(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const owner = uri.scheme === 'file' ? this.tried.get(path.resolve(uri.fsPath)) : undefined;
		return owner && { badge: 'T', color: new vscode.ThemeColor('charts.blue'), tooltip: vscode.l10n.t("From \"{0}\" (trying)", owner.title) };
	}

	/** What can be done with a try: Keep Changes, Take Back, open the agent, show the changes. For agent `id`, or the one picked. */
	async showMenu(id?: string): Promise<void> {
		const trying = this.host.model.agents.filter(record => record.tried?.state === 'trying' && (!id || record.id === id));
		const pickAgent = trying.length === 1 ? trying[0] : (await vscode.window.showQuickPick(trying.map(record => ({ label: record.title, record })), { placeHolder: vscode.l10n.t("Which agent's changes") }))?.record;
		if (!pickAgent) {
			return;
		}
		const keep = { label: `$(check) ${vscode.l10n.t("Keep Changes")}`, detail: vscode.l10n.t("Make these changes yours and finish the thread. Nothing is staged or committed."), run: () => this.keep(pickAgent.id) };
		const back = { label: `$(discard) ${vscode.l10n.t("Take Back")}`, detail: vscode.l10n.t("Remove this agent's changes from your workspace. Edits you made yourself stay."), run: () => this.takeBack(pickAgent.id) };
		const open = { label: `$(comment-discussion) ${vscode.l10n.t("Open the Agent")}`, detail: vscode.l10n.t("Ask it for changes; your workspace updates when it finishes."), run: () => this.host.open(pickAgent.id) };
		const show = { label: `$(source-control) ${vscode.l10n.t("Show Changes")}`, detail: vscode.l10n.t("Source Control, where the tried files carry a T."), run: () => vscode.commands.executeCommand('workbench.view.scm') };
		const picked = await vscode.window.showQuickPick([keep, back, open, show], { title: vscode.l10n.t("Trying \"{0}\"", pickAgent.title) });
		await picked?.run();
	}
}

/** Adds what an apply reported to `problems`. */
function collect(problems: Problems, result: ApplyResult): void {
	problems.conflicts.push(...result.conflicts);
	problems.unmerged.push(...result.unmerged);
	problems.skipped.push(...result.skipped);
}

/** Files by name, for a message. */
function names(files: readonly string[]): string {
	return files.map(file => path.basename(file)).join(', ');
}

/** The ref Discard Changes saves an agent's folder under; work discarded earlier, and newer work Restore replaced, under the same name with a suffix. */
function discardRef(id: string, key: string): string {
	return `refs/geminicode/discarded/${id}${key ? `-${key.replace(/[^\w.-]+/g, '-')}` : ''}`;
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

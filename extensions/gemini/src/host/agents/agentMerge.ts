/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Merge Back, with `gemini.agents.mergeBack` set to "commit": commits an
// agent's work on its own branch and merges the branch into what its
// workspace has checked out, one repository at a time for a
// thread in several, never while the agent works and never twice at once. A
// fork whose parent works on a branch of its own asks which to merge into:
// the parent's branch, in the parent's folder, or what the workspace has.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentChanges } from '../../acp/agentChanges';
import type { AgentRecord, AgentsModel } from '../../acp/agents';
import { errorMessage } from '../../acp/errors';
import { AgentWorktree, commitAll, currentBranch, type inRepository, mergeBranch, mergeRefusal, repositoryRoot, worktreeStatus } from '../../acp/worktrees';
import type { ChatActivity } from '../chatController';
import { tildify } from '../displayText';
import { awaitCommitMessage } from '../gitActions';
import { showError } from '../errorNotice';

/** What Merge Back needs of an agent running in this window. */
interface MergingAgent {
	readonly activity: ChatActivity;
	readonly changes: Pick<AgentChanges, 'clear'>;
}

export class AgentMerge {

	/** Agents being merged back, so a second Merge waits for the first. */
	private readonly merging = new Set<string>();

	constructor(
		private readonly model: AgentsModel,
		/** The agents running in this window. */
		private readonly live: ReadonlyMap<string, MergingAgent>,
		/** Removes the agent, its folder and, with `deleteBranch`, its branch. */
		private readonly removeAgent: (id: string, deleteBranch: boolean) => Promise<void>,
		/** The extension bundle's repository lock: this class loads from dist/onDemand.js, which has its own copy of the module. */
		private readonly lock: typeof inRepository,
		/** Writes a commit message for a folder's uncommitted work; undefined when it can't. */
		private readonly writeMessage?: (folder: string) => Promise<string | undefined>,
	) { }

	/** Whether agent `id` is being merged back now. */
	isMerging(id: string): boolean {
		return this.merging.has(id);
	}

	/**
	 * Merges an agent's branch into the branch its workspace has checked out,
	 * committing its work first. A thread in several repositories merges one
	 * repository's worktree at a time: `repo`, or the one the user picks.
	 * Returns whether all of the agent's work is now merged.
	 */
	async mergeBack(id: string, repo?: string): Promise<boolean> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		if (!record || !workspace || !record.worktree) {
			return false;
		}
		if (record.repos?.length) {
			return this.mergeRepo(record, repo);
		}
		const worktree = record.worktree;
		const live = this.live.get(record.id);
		const stillWorking = () => {
			if (!live?.activity.busy) {
				return false;
			}
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" is still working. Merge back once it finishes.", record.title));
			return true;
		};
		if (stillWorking() || this.merging.has(record.id)) {
			return false;
		}
		this.merging.add(record.id);
		try {
			const checkedOut = await repositoryRoot(workspace.folder);
			if (!checkedOut) {
				throw new Error(vscode.l10n.t("{0} is no longer a Git repository.", workspace.folder));
			}
			const repository = await this.mergeTarget(record, checkedOut);
			if (!repository) {
				return false;
			}
			const merged = await this.mergeWorktree(record, repository, worktree, live, stillWorking);
			if (merged) {
				this.model.setResolved(record.id, 'merged');
				const into = await currentBranch(repository);
				const done = vscode.l10n.t("Remove Agent and Branch");
				const keep = vscode.l10n.t("Keep Working");
				// The merge is done now, not when the notice is answered, which may be never.
				void Promise.resolve(vscode.window.showInformationMessage(vscode.l10n.t("Merged {0} into {1}.", worktree.branch, into), done, keep)).then(async choice => {
					if (choice === done && this.model.agent(record.id)) {
						await this.removeAgent(record.id, true);
					}
				});
			}
			return merged;
		} finally {
			this.merging.delete(record.id);
		}
	}

	/**
	 * Where a fork's branch merges: what `checkedOut` (its workspace's
	 * repository) has, or its parent's branch in the parent's own folder, as
	 * the user picks when they differ. Undefined when dismissed, or when the
	 * parent is working (its folder must not change under its turn).
	 */
	private async mergeTarget(record: AgentRecord, checkedOut: string): Promise<string | undefined> {
		const parent = this.model.parentOf(record);
		const parentFolder = parent && this.model.folderOf(parent);
		const parentTop = parentFolder ? await repositoryRoot(parentFolder) : undefined;
		if (!parent || !parentTop || path.resolve(parentTop) === path.resolve(checkedOut)) {
			return checkedOut;
		}
		const [parentBranch, base] = await Promise.all([currentBranch(parentTop), currentBranch(checkedOut)]);
		const picked = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t("Into {0}", parentBranch), description: vscode.l10n.t("the branch of \"{0}\", which it was forked from", parent.title), folder: parentTop },
			{ label: vscode.l10n.t("Into {0}", base), description: vscode.l10n.t("what {0} has checked out", path.basename(checkedOut)), folder: checkedOut },
		], { title: vscode.l10n.t("Merge Back \"{0}\"", record.title), placeHolder: vscode.l10n.t("Which branch to merge {0} into", record.worktree?.branch ?? '') });
		if (picked?.folder === parentTop && this.live.get(parent.id)?.activity.busy) {
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" is working in that folder. Merge back once it finishes.", parent.title));
			return undefined;
		}
		return picked?.folder;
	}

	/** Merges one repository of a thread in several; returns whether every repository's work is now merged. */
	private async mergeRepo(record: AgentRecord, key: string | undefined): Promise<boolean> {
		const live = this.live.get(record.id);
		const stillWorking = () => {
			if (!live?.activity.busy) {
				return false;
			}
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" is still working. Merge back once it finishes.", record.title));
			return true;
		};
		if (stillWorking() || this.merging.has(record.id)) {
			return false;
		}
		const open = (record.repos ?? []).filter(repo => !repo.merged);
		let target = open.find(repo => repo.key === key);
		if (!target && !key) {
			if (open.length === 1) {
				target = open[0];
			} else {
				const picked = await vscode.window.showQuickPick(open.map(repo => ({ label: repo.key, description: tildify(repo.repository), repo })), { title: vscode.l10n.t("Merge Back"), placeHolder: vscode.l10n.t("Which repository's work to merge") });
				target = picked?.repo;
			}
		}
		if (!target) {
			return false;
		}
		this.merging.add(record.id);
		try {
			if (!await this.mergeWorktree(record, target.repository, target, live, stillWorking)) {
				return false;
			}
			const repos = (this.model.agent(record.id)?.repos ?? []).map(repo => repo.key === target.key ? { ...repo, merged: true } : repo);
			this.model.setRepos(record.id, repos);
			// Resolved once no repository has work left to merge.
			const left = await Promise.all(repos.filter(repo => !repo.merged).map(async repo => {
				const status = await worktreeStatus(repo, await currentBranch(repo.repository)).catch(() => undefined);
				return !!status && (status.commits > 0 || status.uncommitted > 0);
			}));
			const into = await currentBranch(target.repository).catch(() => '');
			void vscode.window.showInformationMessage(vscode.l10n.t("Merged {0} into {1} in {2}.", target.branch, into, target.key));
			return !left.some(Boolean);
		} finally {
			this.merging.delete(record.id);
		}
	}

	/** Asks, commits the worktree's work and merges its branch into `repository`'s; returns whether it merged. Reports failures itself. */
	private async mergeWorktree(record: AgentRecord, repository: string, worktree: AgentWorktree, live: MergingAgent | undefined, stillWorking: () => boolean): Promise<boolean> {
		try {
			const refusal = await mergeRefusal(repository);
			if (refusal) {
				void vscode.window.showWarningMessage(refusal === 'detached'
					? vscode.l10n.t("{0} has no branch checked out, so {1} cannot be merged into it. Check out a branch first.", path.basename(repository), worktree.branch)
					: vscode.l10n.t("{0} is in the middle of a {1}. Finish or abort it before merging {2}.", path.basename(repository), refusal, worktree.branch));
				return false;
			}
			const into = await currentBranch(repository);
			const status = await worktreeStatus(worktree, into);
			if (!status.uncommitted && !status.commits) {
				void vscode.window.showInformationMessage(vscode.l10n.t("{0} has nothing to merge into {1}.", worktree.branch, into));
				return false;
			}
			// Written from the uncommitted work while the user reads the question.
			const written = status.uncommitted ? this.writeMessage?.(worktree.folder).catch(() => undefined) : undefined;
			const detail = [
				status.commits === 1 ? vscode.l10n.t("1 commit") : status.commits ? vscode.l10n.t("{0} commits", status.commits) : undefined,
				status.uncommitted === 1 ? vscode.l10n.t("1 changed file not committed yet; it is committed first, with a message written from the change (or \"{0}\")", record.title)
					: status.uncommitted ? vscode.l10n.t("{0} changed files not committed yet; they are committed first, with a message written from the changes (or \"{1}\")", status.uncommitted, record.title) : undefined,
			].filter(Boolean).join('\n');
			const merge = vscode.l10n.t("Merge");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Merge {0} into {1}?", worktree.branch, into), { modal: true, detail }, merge) !== merge) {
				return false;
			}
			// A turn may have started while the question was open; its edits are not done yet.
			if (stillWorking()) {
				return false;
			}
			// The commit and the merge take a turn of the repository's git lock, as worktree adds and pushes do.
			const result = await this.lock(repository, async () => {
				if (status.uncommitted) {
					await commitAll(worktree.folder, await awaitCommitMessage(written, record.title));
					// A thread in several repositories keeps the others' changes.
					live?.changes.clear(record.repos?.length ? worktree.folder : undefined);
				}
				return mergeBranch(repository, worktree.branch);
			});
			if (result.kind === 'conflicts') {
				const open = vscode.l10n.t("Open Source Control");
				const message = result.files.length === 1
					? vscode.l10n.t("{0} conflicts with {1}. Finish the merge in Source Control.", result.files[0], into)
					: vscode.l10n.t("{0} files conflict with {1}. Finish the merge in Source Control.", result.files.length, into);
				if (await vscode.window.showWarningMessage(message, open) === open) {
					await vscode.commands.executeCommand('workbench.view.scm');
				}
				return false;
			}
			return true;
		} catch (err) {
			if (/Author identity unknown|Please tell me who you are/.test(errorMessage(err))) {
				void showError(vscode.l10n.t("Could not merge {0}: Git doesn't know your name and email yet. Set them with git config --global user.name and user.email, then try again.", worktree.branch));
				return false;
			}
			void showError(vscode.l10n.t("Could not merge {0}: {1}", worktree.branch, errorMessage(err)));
			return false;
		}
	}
}

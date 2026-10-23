/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Merge Back: commits an agent's work on its own branch and merges the branch
// into what its workspace has checked out, one repository at a time for a
// thread in several, never while the agent works and never twice at once.

import * as vscode from 'vscode';
import type { AgentChanges } from '../../acp/agentChanges';
import type { AgentRecord, AgentsModel } from '../../acp/agents';
import { errorMessage } from '../../acp/errors';
import { AgentWorktree, commitAll, currentBranch, mergeBranch, repositoryRoot, worktreeStatus } from '../../acp/worktrees';
import type { ChatActivity } from '../chatController';
import { tildify } from '../displayText';

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
			const repository = await repositoryRoot(workspace.folder);
			if (!repository) {
				throw new Error(vscode.l10n.t("{0} is no longer a Git repository.", workspace.folder));
			}
			const merged = await this.mergeWorktree(record, repository, worktree, live, stillWorking);
			if (merged) {
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
			const into = await currentBranch(repository);
			const status = await worktreeStatus(worktree, into);
			if (!status.uncommitted && !status.commits) {
				void vscode.window.showInformationMessage(vscode.l10n.t("{0} has nothing to merge into {1}.", worktree.branch, into));
				return false;
			}
			const detail = [
				status.commits === 1 ? vscode.l10n.t("1 commit") : status.commits ? vscode.l10n.t("{0} commits", status.commits) : undefined,
				status.uncommitted === 1 ? vscode.l10n.t("1 changed file not committed yet; it is committed first as \"{0}\"", record.title)
					: status.uncommitted ? vscode.l10n.t("{0} changed files not committed yet; they are committed first as \"{1}\"", status.uncommitted, record.title) : undefined,
			].filter(Boolean).join('\n');
			const merge = vscode.l10n.t("Merge");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Merge {0} into {1}?", worktree.branch, into), { modal: true, detail }, merge) !== merge) {
				return false;
			}
			// A turn may have started while the question was open; its edits are not done yet.
			if (stillWorking()) {
				return false;
			}
			if (status.uncommitted) {
				await commitAll(worktree.folder, record.title);
				// A thread in several repositories keeps the others' changes.
				live?.changes.clear(record.repos?.length ? worktree.folder : undefined);
			}
			const result = await mergeBranch(repository, worktree.branch);
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
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not merge {0}: Git doesn't know your name and email yet. Set them with git config --global user.name and user.email, then try again.", worktree.branch));
				return false;
			}
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not merge {0}: {1}", worktree.branch, errorMessage(err)));
			return false;
		}
	}
}

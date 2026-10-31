/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Taking agents out of this window: ending an agent's session (stop),
// Remove and its dialogs (forks, unreviewed changes, an agent's own branch),
// Remove's Archive, removing a workspace from the list, and the removal the
// team flows, Merge Back and Clean Up share (`removeAgentAndWorktree`).

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentRecord, AgentsModel } from '../../acp/agents';
import { errorMessage } from '../../acp/errors';
import type { CheckpointStore } from '../../acp/checkpointStore';
import type { TranscriptStore } from '../../acp/transcriptStore';
import { AgentWorktree, removeThreadFolder, removeWorktree, repositoryRoot, worktreeStatus } from '../../acp/worktrees';
import type { AgentNotifier } from '../agentNotifier';
import type { AgentTerminals } from '../agentTerminals';
import type { ReviewController } from '../reviewController';
import type { CommitSettler } from '../commitSettler';
import { tildify } from '../displayText';
import type { Projects } from '../projects';
import type { AgentsView } from '../agentsView';
import type { AgentFeatures } from './agentFeatures';
import type { AgentTabs } from './agentTabs';
import type { AgentTree, AgentTreeNode } from './agentTree';
import type { LiveAgent } from './agentStart';

/** What removing, archiving and stopping agents reach into the Agents pane for. */
export interface AgentRemovalHost {
	readonly model: AgentsModel;
	/** The agents running in this window; a stopped agent leaves. */
	readonly live: Map<string, LiveAgent>;
	readonly tree: Pick<AgentTree, 'view'>;
	readonly projects: Pick<Projects, 'detach' | 'threadRemoved'>;
	readonly notifier: Pick<AgentNotifier, 'clear'>;
	readonly transcripts: Pick<TranscriptStore, 'load' | 'save' | 'delete'>;
	readonly checkpointFiles: Pick<CheckpointStore, 'delete'>;
	readonly terminals: Pick<AgentTerminals, 'closeAgent'>;
	readonly review: Pick<ReviewController, 'refresh'>;
	readonly settler: Pick<CommitSettler, 'update'>;
	/** The pane's own surface: what activate sets on it (the browser, the team tools, the index), read when an agent goes. */
	readonly view: Pick<AgentsView, 'browser' | 'teamTools' | 'index'>;
	/** The agents' Files pages, once loaded, and Try in Workspace, loaded once first needed. */
	readonly features: Pick<AgentFeatures, 'loadedAgentFiles' | 'tries'>;
	/** The agents' tabs: a stopped agent's leaves the Changes view. */
	readonly tabs: Pick<AgentTabs, 'unfocus'>;
}

export class AgentRemoval {

	constructor(private readonly host: AgentRemovalHost) { }

	/** Removes the agent, its worktree folder and, with `deleteBranch`, its branch. */
	async removeAgentAndWorktree(id: string, deleteBranch: boolean): Promise<void> {
		const host = this.host;
		// Its work tried in the user's checkout stays theirs or is taken back first, as they say.
		if (host.model.agent(id)?.tried?.state === 'trying' && !await host.features.tries.beforeRemove(id)) {
			return;
		}
		// What Discard Changes saved of its folder goes with it.
		if (host.model.agent(id)?.worktree) {
			await host.features.tries.forget(id);
		}
		const record = host.model.agent(id);
		const workspace = record && host.model.workspace(record.workspaceId);
		this.stop(id, false);
		if (record) {
			this.forkGone(record);
			host.projects.threadRemoved(record);
		}
		host.model.removeAgent(id);
		void host.transcripts.delete(id);
		void host.checkpointFiles.delete(id);
		host.view.browser?.closeAgent(id);
		host.features.loadedAgentFiles?.close(id);
		host.terminals.closeAgent(id);
		host.view.teamTools?.forgetAgent(id);
		host.view.index?.forgetAgent(id);
		if (record?.worktree && record.repos?.length) {
			await removeThreadFolder(record.repos, record.worktree.folder, deleteBranch).catch(err =>
				vscode.window.showWarningMessage(vscode.l10n.t("The agent was removed, but its folder {0} could not be: {1}", tildify(record.worktree!.folder), errorMessage(err))));
		} else if (record?.worktree && workspace) {
			const repository = await repositoryRoot(workspace.folder) ?? workspace.folder;
			await removeWorktree(repository, record.worktree, deleteBranch).catch(err =>
				vscode.window.showWarningMessage(vscode.l10n.t("The agent was removed, but its folder {0} could not be: {1}", tildify(record.worktree!.folder), errorMessage(err))));
		}
		if (record?.worktree) {
			// The worktree is gone, and its index with it.
			void host.view.index?.remove(record.worktree.cwd).catch(() => undefined);
		}
	}

	/** The fork's card in its parent's chat says it was removed. */
	private forkGone(record: AgentRecord): void {
		const parent = this.host.model.parentOf(record);
		if (parent) {
			this.host.live.get(parent.id)?.controller.forkRemoved(record.id);
		}
	}

	async removeAgent(node: AgentTreeNode | undefined): Promise<void> {
		const host = this.host;
		node ??= host.tree.view.selection[0];
		if (node?.kind !== 'agent') {
			return;
		}
		// Its forks go too, or stay as agents of their own, as the user says.
		const forks = host.model.forksOf(node.record.id);
		if (forks.length) {
			const keep = vscode.l10n.t("Keep the Forks");
			const removeToo = vscode.l10n.t("Remove the Forks Too");
			const choice = await vscode.window.showWarningMessage(
				forks.length === 1 ? vscode.l10n.t("\"{0}\" has a fork, \"{1}\". Remove it too?", node.record.title, forks[0].title) : vscode.l10n.t("\"{0}\" has {1} forks. Remove them too?", node.record.title, forks.length),
				{ modal: true, detail: vscode.l10n.t("Kept forks stay as agents of their own, with their branches and conversations. Each fork removed asks about its own branch.") },
				keep, removeToo);
			if (!choice) {
				return;
			}
			if (choice === removeToo) {
				for (const fork of forks) {
					const folder = host.model.folderOf(fork);
					if (folder) {
						await this.removeAgent({ kind: 'agent', record: fork, folder });
					}
				}
			}
		}
		const remove = vscode.l10n.t("Remove");
		const worktree = host.model.agent(node.record.id)?.worktree;
		if (worktree) {
			await this.removeWorktreeAgent(node.record, worktree);
			return;
		}
		// Its change list goes with it, so name what still waits for Keep or Undo.
		const unreviewed = (host.live.get(node.record.id)?.changes.files ?? (await host.transcripts.load(node.record.id)).changes).map(file => path.basename(file.path));
		const names = unreviewed.length > 5 ? `${unreviewed.slice(0, 5).join(', ')}, …` : unreviewed.join(', ');
		const detail = unreviewed.length === 1 ? vscode.l10n.t("1 file still has changes to review: {0}.", names)
			: unreviewed.length ? vscode.l10n.t("{0} files still have changes to review: {1}.", unreviewed.length, names) : undefined;
		const archive = vscode.l10n.t("Archive");
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove the agent \"{0}\"? This deletes its conversation and undo history.", node.record.title), { modal: true, detail }, archive, remove);
		if (answer === archive) {
			this.archiveAgent(node.record.id);
		} else if (answer === remove) {
			this.stop(node.record.id, false);
			this.forkGone(node.record);
			host.projects.threadRemoved(node.record);
			host.model.removeAgent(node.record.id);
			void host.transcripts.delete(node.record.id);
			void host.checkpointFiles.delete(node.record.id);
			host.view.browser?.closeAgent(node.record.id);
			host.features.loadedAgentFiles?.close(node.record.id);
			host.terminals.closeAgent(node.record.id);
			host.view.teamTools?.forgetAgent(node.record.id);
			host.view.index?.forgetAgent(node.record.id);
		}
	}

	/**
	 * Remove's Archive: the agent leaves the pane's list and Home for its
	 * workspace's Archived row, keeping its chat, undo history and branch.
	 * Its session ends, with the chat saved; opening it brings it back.
	 */
	archiveAgent(id: string): void {
		this.stop(id, true);
		this.host.model.archive(id);
	}

	private async removeWorktreeAgent(record: AgentRecord, worktree: AgentWorktree): Promise<void> {
		const workspace = this.host.model.workspace(record.workspaceId);
		const repository = workspace && await repositoryRoot(workspace.folder);
		// A thread in several repositories: each one's work, by name.
		const parts: { readonly key?: string; readonly worktree: AgentWorktree }[] = record.repos?.length ? record.repos.map(repo => ({ key: repo.key, worktree: repo })) : repository ? [{ worktree }] : [];
		const statuses = await Promise.all(parts.map(part => worktreeStatus(part.worktree, part.worktree.base).catch(() => undefined)));
		const unsaved = parts.map((part, i) => {
			const status = statuses[i];
			const text = [
				status?.commits === 1 ? vscode.l10n.t("1 commit not in {0}", part.worktree.base) : status?.commits ? vscode.l10n.t("{0} commits not in {1}", status.commits, part.worktree.base) : undefined,
				status?.uncommitted === 1 ? vscode.l10n.t("1 uncommitted changed file") : status?.uncommitted ? vscode.l10n.t("{0} uncommitted changed files", status.uncommitted) : undefined,
			].filter(Boolean).join(', ');
			return text && part.key ? `${part.key}: ${text}` : text;
		}).filter(Boolean).join('; ');
		const detail = unsaved
			? vscode.l10n.t("Its branch {0} has {1}. Deleting the branch loses them; keeping it leaves the branch in your repository.", worktree.branch, unsaved)
			: vscode.l10n.t("Its branch {0} has no work of its own.", worktree.branch);
		const deleteBranch = vscode.l10n.t("Remove and Delete Branch");
		const keepBranch = vscode.l10n.t("Remove, Keep Branch");
		const archive = vscode.l10n.t("Archive");
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove the agent \"{0}\" and its folder?", record.title), { modal: true, detail }, archive, deleteBranch, keepBranch);
		if (answer === archive) {
			this.archiveAgent(record.id);
		} else if (answer) {
			await this.removeAgentAndWorktree(record.id, answer === deleteBranch);
		}
	}

	async removeWorkspace(node: AgentTreeNode | undefined): Promise<void> {
		const host = this.host;
		if (node?.kind !== 'workspace' || !node.record) {
			return;
		}
		const remove = vscode.l10n.t("Remove");
		const count = host.model.agentsIn(node.record.id).length;
		const message = count
			? vscode.l10n.t("Remove {0} and its {1} agents from the list? The folder itself is not changed.", path.basename(node.folder), count)
			: vscode.l10n.t("Remove {0} from the list? The folder itself is not changed.", path.basename(node.folder));
		const branches = host.model.agentsIn(node.record.id).filter(a => a.worktree).length;
		const detail = branches ? vscode.l10n.t("Agents on their own branches keep their branches and folders in ~/.geminicode/worktrees. To delete those, remove the agents first.") : undefined;
		if (await vscode.window.showWarningMessage(message, { modal: true, detail }, remove) === remove) {
			for (const agent of host.model.removeWorkspace(node.record.id)) {
				this.stop(agent.id, false);
				void host.transcripts.delete(agent.id);
				void host.checkpointFiles.delete(agent.id);
				host.view.browser?.closeAgent(agent.id);
				host.features.loadedAgentFiles?.close(agent.id);
				host.terminals.closeAgent(agent.id);
				host.view.teamTools?.forgetAgent(agent.id);
				host.view.index?.forgetAgent(agent.id);
			}
		}
	}

	/** Ends the agent's session in this window and closes its tab; with `save`, keeps its conversation for later. */
	stop(id: string, save: boolean): void {
		const host = this.host;
		const live = host.live.get(id);
		if (!live) {
			return;
		}
		host.live.delete(id);
		host.projects.detach(id);
		host.notifier.clear(id);
		// Saved already unless a save is pending or a turn runs.
		if (save && (live.saveTimer !== undefined || live.activity.busy)) {
			void host.transcripts.save(id, { items: live.controller.conversation, changes: live.changes.files });
		}
		clearTimeout(live.saveTimer);
		host.tabs.unfocus(id);
		live.panel?.dispose();
		void live.session.cancel();
		vscode.Disposable.from(...live.disposables).dispose();
		live.controller.dispose();
		live.changes.dispose();
		live.session.dispose();
		host.review.refresh();
		host.settler.update();
	}
}

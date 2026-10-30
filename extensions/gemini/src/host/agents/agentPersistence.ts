/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Agents pane saves and cleans up: the agent list (to its record
// store, shared with every window, else to global state), each agent's
// conversation and checkpoints, the checkpoints of merged threads, and what
// Settings' Clean Up may remove from storage.

import * as vscode from 'vscode';
import type { AgentChanges } from '../../acp/agentChanges';
import { AgentsModel, mergedThreads } from '../../acp/agents';
import type { AgentsStore } from '../../acp/agentsStore';
import { errorMessage } from '../../acp/errors';
import { TranscriptStore } from '../../acp/transcriptStore';
import { CheckpointStore } from '../../acp/checkpointStore';
import type { CleanupItem, WorktreeCandidate } from '../../acp/storageUsage';
import { cleanupWorktrees } from '../../acp/worktreeCleanup';
import { AgentWorktree, inRepository, removeWorktree, repositoryRoot } from '../../acp/worktrees';
import type { ChatActivity, ChatController } from '../chatController';
import { background } from '../background';

/** Where the agent list was kept before the record store; still written when a window closes, for a downgrade. */
export const storageKey = 'gemini.agents';

/** How long after a turn ends its conversation is saved, so quick turns write once. */
const saveDelayMs = 1_000;
/** The longest a change waits to be saved while updates keep coming, so a crash mid-reply loses little. */
const saveMaxWaitMs = 10_000;

/** What saving needs of an agent running in this window. */
export interface SavedLiveAgent {
	readonly controller: Pick<ChatController, 'conversation'>;
	readonly changes: Pick<AgentChanges, 'files'>;
	readonly activity: ChatActivity;
	/** A pending save of the conversation. */
	saveTimer?: ReturnType<typeof setTimeout>;
	/** When the oldest change not yet saved happened, so a long reply is saved while it streams. */
	unsavedSince?: number;
}

/** What saving and Clean Up ask of the Agents pane. */
export interface AgentPersistenceHost {
	log(message: string): void;
	/** Whether agent `id` runs in this window or is being merged, so Clean Up leaves its worktree. */
	running(id: string): boolean;
	/** Whether agent `id` is a reviewer with a merge request review. */
	reviewing(id: string): boolean;
	/** Removes the agent, its worktree folder and, with `deleteBranch`, its branch. */
	removeAgent(id: string, deleteBranch: boolean): Promise<void>;
}

export class AgentPersistence implements vscode.Disposable {

	/** Where the list is saved, shared with every window; undefined when it could not be read. */
	readonly store: AgentsStore | undefined;
	/** Whether this window said that saving failed; it says so once. */
	private warnedSaveFailed = false;
	/** Merged threads whose checkpoints were dropped in this window. */
	private readonly droppedCheckpoints = new Set<string>();
	/** Each agent's conversation as shown, so its tab looks the same after a reload. */
	readonly transcripts: TranscriptStore;
	/** Each agent's checkpoints, for Undo and Rewind after a reload. */
	readonly checkpointFiles: CheckpointStore;
	private persistTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly context: Pick<vscode.ExtensionContext, 'globalStorageUri' | 'globalState'>,
		private readonly model: AgentsModel,
		store: AgentsStore | undefined,
		/** The agents running in this window. */
		private readonly live: ReadonlyMap<string, SavedLiveAgent>,
		private readonly host: AgentPersistenceHost,
	) {
		this.store = store;
		if (this.store) {
			this.store.log = message => this.host.log(message);
		}
		const saveFailed = (err: unknown) => this.saveFailed(err);
		this.transcripts = new TranscriptStore(vscode.Uri.joinPath(context.globalStorageUri, 'agents').fsPath, saveFailed);
		this.checkpointFiles = new CheckpointStore(vscode.Uri.joinPath(context.globalStorageUri, 'checkpoints').fsPath, saveFailed);
	}

	/** Saving the agent list goes to the main process; once a second is plenty. */
	persistSoon(): void {
		this.persistTimeout ??= setTimeout(() => this.persist(), 1000);
	}

	/** Saves what changed in the list: to the record store, each changed record on its own, else to global state. */
	persist(): Thenable<void> {
		clearTimeout(this.persistTimeout);
		this.persistTimeout = undefined;
		if (!this.store) {
			return this.context.globalState.update(storageKey, this.model.stored());
		}
		background('Dropping merged threads\' checkpoints', this.dropMergedCheckpoints());
		return this.store.save(this.model);
	}

	/** Removes the saved checkpoints of threads merged back: their work is in the repository, and Undo has nothing left to do. */
	async dropMergedCheckpoints(): Promise<void> {
		const merged = new Set(mergedThreads(this.model.snapshot().agents));
		// A thread opened again keeps the checkpoints of its new turns until it is merged again.
		for (const id of this.droppedCheckpoints) {
			if (!merged.has(id)) {
				this.droppedCheckpoints.delete(id);
			}
		}
		const ids = [...merged].filter(id => !this.droppedCheckpoints.has(id));
		if (!ids.length) {
			return;
		}
		ids.forEach(id => this.droppedCheckpoints.add(id));
		await Promise.all((await this.checkpointFiles.savedOf(ids)).map(id => this.checkpointFiles.delete(id)));
	}

	/** A chat or its checkpoints could not be saved: logged every time, and said once per window. */
	private saveFailed(err: unknown): void {
		this.host.log(`Saving a chat failed: ${errorMessage(err)}`);
		if (!this.warnedSaveFailed) {
			this.warnedSaveFailed = true;
			void vscode.window.showWarningMessage(vscode.l10n.t("GeminiCode couldn't save chats: {0}", errorMessage(err)));
		}
	}

	scheduleSave(id: string, live: SavedLiveAgent): void {
		clearTimeout(live.saveTimer);
		const now = Date.now();
		live.unsavedSince ??= now;
		const delay = Math.max(0, Math.min(saveDelayMs, live.unsavedSince + saveMaxWaitMs - now));
		live.saveTimer = setTimeout(() => {
			live.saveTimer = undefined;
			live.unsavedSince = undefined;
			void this.transcripts.save(id, { items: live.controller.conversation, changes: live.changes.files });
		}, delay);
	}

	/**
	 * Saves every open agent's conversation and the agent list, and resolves
	 * once they are written; for deactivate, so a reply that ended just before
	 * a reload or quit is kept.
	 */
	async saveAll(): Promise<void> {
		for (const [id, live] of this.live) {
			if (live.saveTimer !== undefined || live.activity.busy) {
				clearTimeout(live.saveTimer);
				live.saveTimer = undefined;
				void this.transcripts.save(id, { items: live.controller.conversation, changes: live.changes.files });
			}
		}
		const list = this.persistTimeout ? this.persist() : undefined;
		await Promise.all([this.transcripts.flush(), this.checkpointFiles.flush(), list, this.store?.flush()]);
		// Kept in global state too, where an earlier version of GeminiCode reads it.
		if (this.store) {
			await this.context.globalState.update(storageKey, this.model.stored());
		}
	}

	/** Every agent's id, and the threads merged back, for Settings' Clean Up. */
	storageAgents(): { readonly all: ReadonlySet<string>; readonly merged: ReadonlySet<string> } {
		const records = this.model.snapshot().agents;
		return { all: new Set(records.map(record => record.id)), merged: new Set(mergedThreads(records)) };
	}

	/** The worktrees Settings' Clean Up may offer: merged threads', ended reviews' and removed agents', none in use here. */
	storageWorktrees(): Promise<WorktreeCandidate[]> {
		return cleanupWorktrees({
			records: this.model.snapshot().agents,
			repositoryOf: async record => {
				const workspace = this.model.workspace(record.workspaceId);
				return workspace && (await repositoryRoot(workspace.folder) ?? workspace.folder);
			},
			running: id => this.host.running(id),
			reviewing: id => this.host.reviewing(id),
		});
	}

	/**
	 * Removes a worktree Clean Up listed, keeping its branch: an ended
	 * review's goes with its reviewer agent (Remove Reviewer and Checkout);
	 * a merged thread's comes back from its branch when the thread is opened.
	 */
	async removeStorageWorktree(repository: string, worktree: AgentWorktree, item: CleanupItem): Promise<void> {
		if (item.reason === 'reviewWorktree' && item.agent && this.model.agent(item.agent)) {
			return this.host.removeAgent(item.agent, true);
		}
		if (item.agent && this.live.has(item.agent)) {
			throw new Error(vscode.l10n.t("Its agent is running."));
		}
		await inRepository(repository, () => removeWorktree(repository, worktree, false));
	}

	/** A save still pending when the window closes is written now; the stores themselves are disposed with the pane. */
	dispose(): void {
		if (this.persistTimeout) {
			void this.persist();
		}
	}
}

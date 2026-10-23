/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fork Agent, from the Agents pane's side: makes the fork's branch (from its
// parent's folder, with the parent's uncommitted changes) or lets it share
// the parent's folder, writes its copy of the parent's session where the CLI
// keeps the fork's folder's sessions, and starts it on that session with its
// parent's conversation in its chat. The chat prepares what the fork starts
// with (`src/host/chat/chatFork.ts`).

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentsModel } from '../../acp/agents';
import { branchNameFrom, isValidBranchName } from '../../acp/branchNames';
import { forkNote } from '../../acp/chatTurns';
import { registeredChatsFolder } from '../../acp/cliSessions';
import { errorMessage } from '../../acp/errors';
import { writeSessionCopy } from '../../acp/sessionSnapshot';
import { AgentWorktree, currentBranch, freeBranchName, mainRepository, removeWorktree, repositoryRoot, unfinishedOperation } from '../../acp/worktrees';
import type { ForkAction } from '../chatProtocol';
import type { ChatController } from '../chatController';
import type { AgentService } from '../agentService';
import type { ChatForker, ForkStart } from '../chat/chatOptions';
import type { AgentSession } from '../agentSession';
import type { AgentWorktrees } from './agentWorktrees';

/** What a fork needs of an agent running in this window. */
interface ForkingAgent {
	readonly session: AgentSession;
	readonly controller: ChatController;
}

/** What making forks may ask of the Agents pane. */
export interface ForksHost {
	start(record: ReturnType<AgentsModel['addFork']>, folder: string): ForkingAgent;
	open(id: string): Promise<void>;
	pickModel(id: string, model: string): void;
	mergeBack(id: string): Promise<boolean>;
}

export class AgentForks {

	constructor(
		private readonly model: AgentsModel,
		private readonly service: Pick<AgentService, 'runtime' | 'ensureReady' | 'writeLog'>,
		private readonly worktrees: AgentWorktrees,
		private readonly live: ReadonlyMap<string, ForkingAgent>,
		private readonly host: ForksHost,
	) { }

	/** The fork hook for agent `id`'s chat. */
	forkerFor(id: string): ChatForker {
		return {
			place: () => this.place(id),
			start: start => this.start(id, start),
			action: (agent, action) => this.action(agent, action),
		};
	}

	/** Whether agent `id`'s folder is in Git, its branch, and a free name for a fork's branch. */
	private async place(id: string): Promise<{ readonly git: boolean; readonly branch?: string; readonly forkBranch: string; readonly ownBranch: boolean }> {
		const record = this.model.agent(id);
		const folder = record && this.model.folderOf(record);
		const repository = folder ? await repositoryRoot(folder) : undefined;
		if (!record || !folder || !repository) {
			return { git: false, forkBranch: '', ownBranch: false };
		}
		const branch = await currentBranch(repository).catch(() => undefined);
		const main = await mainRepository(repository);
		// A fork of an agent on its own branch is named after that branch; otherwise the dialog names it after the fork.
		const named = record.worktree ? `${record.worktree.branch}-fork` : branchNameFrom(vscode.l10n.t("{0} (fork)", record.title));
		return { git: true, ...(branch ? { branch } : {}), forkBranch: await freeBranchName([main], named), ownBranch: !!record.worktree };
	}

	/** Makes agent `parentId`'s fork, opens it and sends it its first message. */
	private async start(parentId: string, start: ForkStart): Promise<void> {
		const parent = this.model.agent(parentId);
		const parentFolder = parent && this.model.folderOf(parent);
		if (!parent || !parentFolder) {
			throw new Error(vscode.l10n.t("The agent is no longer here."));
		}
		const { request } = start;
		let worktree: AgentWorktree | undefined;
		if (request.ownBranch) {
			worktree = await this.makeBranch(parentFolder, request.branch);
		}
		// A fork without a branch of its own works where its parent does, without owning that folder.
		const workspace = this.model.workspace(parent.workspaceId);
		const sharedFolder = !worktree && workspace && path.resolve(parentFolder) !== path.resolve(workspace.folder) ? parentFolder : undefined;
		const folder = worktree?.cwd ?? parentFolder;
		let sessionId: string | undefined;
		try {
			if (start.messages) {
				await this.register(folder);
				sessionId = await writeSessionCopy(folder, start.messages);
			}
		} catch (err) {
			if (worktree) {
				await removeWorktree(await mainRepository(parentFolder), worktree, true).catch(() => undefined);
			}
			throw err;
		}
		const fork = this.model.addFork(parent, request.title, sharedFolder ? { sharedFolder } : {}, worktree, sessionId);
		const parentClient = this.live.get(parentId)?.session.client;
		// The parent's model and mode, unless the dialog picked another model.
		const modelId = request.model ?? parentClient?.settings.model?.currentId;
		if (modelId) {
			this.host.pickModel(fork.id, modelId);
		}
		const live = this.host.start(fork, folder);
		const mode = parentClient?.settings.mode?.currentId;
		if (mode && mode !== 'default') {
			live.session.client.setModeOnNextSession(mode);
		}
		live.controller.startFork(start.items, sessionId, { parent: parent.id, title: parent.title, context: request.context });
		if (start.conversation?.length) {
			live.controller.carryConversation(parent.title, start.conversation);
		}
		live.controller.addContext(forkNote(parent.title, parentFolder, folder, worktree?.branch));
		await this.host.open(fork.id);
		start.onStarted(fork.id, worktree?.branch);
		this.service.writeLog(`Forked "${parent.title}" as "${fork.title}" (${request.context}${worktree ? `, on ${worktree.branch}` : ', in the same folder'}).`);
		if (request.message?.trim()) {
			void live.controller.send(request.message.trim());
		}
	}

	/** The fork's branch, from its parent's folder; the name asked for, or a free one like it. */
	private async makeBranch(parentFolder: string, named: string | undefined): Promise<AgentWorktree> {
		if (!await repositoryRoot(parentFolder)) {
			throw new Error(vscode.l10n.t("{0} is not in a Git repository, so the fork can't have its own branch.", path.basename(parentFolder)));
		}
		const operation = await unfinishedOperation(parentFolder);
		if (operation) {
			throw new Error(vscode.l10n.t("The agent's folder is in the middle of a {0}. Finish or abort it first, or fork into the same folder.", operation));
		}
		const name = named?.trim();
		if (name && !isValidBranchName(name)) {
			throw new Error(vscode.l10n.t("{0} is not a valid branch name.", name));
		}
		const main = await mainRepository(parentFolder);
		return this.worktrees.makeFrom(parentFolder, await freeBranchName([main], name || 'gemini/fork'));
	}

	/**
	 * Has the CLI register `folder`, as it does when it first opens a session
	 * there, so a copy of a session written where it keeps the folder's
	 * sessions is found; the session opened for that is closed again.
	 */
	private async register(folder: string): Promise<void> {
		if (await registeredChatsFolder(folder)) {
			return;
		}
		await this.service.ensureReady();
		const runtime = this.service.runtime;
		const opened = await runtime.newSession(folder, [], `fork:${folder}`);
		if (opened.agent.agentCapabilities?.sessionCapabilities?.close) {
			void opened.connection.close(opened.session.sessionId).catch(() => undefined);
		}
		if (!await registeredChatsFolder(folder)) {
			throw new Error(vscode.l10n.t("The Gemini CLI did not take up the fork's folder."));
		}
	}

	/** A fork card's button, in its parent's chat. */
	private action(agent: string, action: ForkAction): void {
		if (!this.model.agent(agent)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("That fork was removed."));
			return;
		}
		switch (action) {
			case 'open':
				void this.host.open(agent);
				break;
			case 'merge':
				void this.host.mergeBack(agent).catch(err => vscode.window.showErrorMessage(errorMessage(err)));
				break;
		}
	}
}

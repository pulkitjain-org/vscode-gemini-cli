/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fork Agent, from the Agents pane's side: makes the fork's branch (from its
// parent's folder, with the parent's uncommitted changes) or lets it share
// the parent's folder, writes its copy of the parent's session where the CLI
// keeps the fork's folder's sessions, and starts it on that session with its
// parent's conversation in its chat. The chat prepares what the fork starts
// with (`src/host/chat/chatFork.ts`). A fork of a project's thread is a new
// thread of that project (Fork Thread), always on a branch of its own: two
// threads in one folder would change the same files.
//
// Move to its own branch takes the same path with the whole session: a new
// agent on a new branch from the agent's folder, with its uncommitted
// changes, opened in place of the agent, which is then archived. Its
// decisions are in `src/acp/moveToBranch.ts`.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentChanges } from '../../acp/agentChanges';
import type { AgentProjectRole, AgentRecord, AgentsModel } from '../../acp/agents';
import { branchDefaults } from '../branchDefaults';
import { branchNameFrom, isValidBranchName } from '../../acp/branchNames';
import { forkedItems, forkNote } from '../../acp/chatTurns';
import { readSessionMessages, registeredChatsFolder } from '../../acp/cliSessions';
import { errorMessage } from '../../acp/errors';
import { MoveChoice, moveBranchName, moveChoices, moveNote, MoveRefusal, moveRefusal, moveSteps } from '../../acp/moveToBranch';
import { writeSessionCopy } from '../../acp/sessionSnapshot';
import { AgentWorktree, currentBranch, freeBranchName, mainRepository, removeWorktree, repositoryRoot, unfinishedOperation } from '../../acp/worktrees';
import type { ForkAction } from '../chatProtocol';
import type { ForkContext } from '../../acp/chatTranscript';
import type { ChatController } from '../chatController';
import type { AgentService } from '../agentService';
import type { ChatForker, ForkStart } from '../chat/chatOptions';
import type { AgentSession } from '../agentSession';
import type { AgentWorktrees } from './agentWorktrees';
import { showError } from '../errorNotice';
import { deleteFile, replaceFileText } from '../workspaceFileSystem';

/** What a fork needs of an agent running in this window. */
interface ForkingAgent {
	readonly session: AgentSession;
	readonly controller: ChatController;
	/** The files its tools edited, which Move and undo here puts back. */
	readonly changes: AgentChanges;
}

/** What making forks may ask of the Agents pane. */
export interface ForksHost {
	start(record: ReturnType<AgentsModel['addFork']>, folder: string): ForkingAgent;
	open(id: string): Promise<void>;
	/** Starts agent `id`'s session in this window without a tab, when it has none; undefined when it is gone. */
	ensureLive(id: string): ForkingAgent | undefined;
	pickModel(id: string, model: string): void;
	mergeBack(id: string): Promise<boolean>;
	/** Remove's Archive: the agent leaves the list for Archived, keeping its chat and branch. */
	archive(id: string): void;
	/** Links the repository's ignored rules into a thread's new folder, as a new thread gets them. */
	linkThreadRules(repository: string, folder: string): Promise<void>;
	/** A fork of a project's thread started: it joins the project; one given only the conversation gets the project's notes too. */
	threadForked(fork: AgentRecord, parent: AgentRecord, context: ForkContext): Promise<void>;
}

/** How a new agent is made from another's session: a fork beside it, or the agent moved to its own branch. */
type StartKind = 'fork' | 'move';

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
	private async place(id: string): Promise<{ readonly git: boolean; readonly branch?: string; readonly forkBranch: string; readonly ownBranch: boolean; readonly branchOnly?: boolean }> {
		const record = this.model.agent(id);
		const folder = record && this.model.folderOf(record);
		if (record?.repos?.length) {
			throw new Error(vscode.l10n.t("A thread that works in several repositories can't be forked yet. Start a new thread from the project chat instead."));
		}
		const repository = folder ? await repositoryRoot(folder) : undefined;
		if (!record || !folder || !repository) {
			return { git: false, forkBranch: '', ownBranch: false };
		}
		const branch = await currentBranch(repository).catch(() => undefined);
		const main = await mainRepository(repository);
		// A fork of an agent on its own branch is named after that branch; otherwise the dialog names it after the fork.
		const named = record.worktree ? `${record.worktree.branch}-fork` : branchNameFrom(vscode.l10n.t("{0} (fork)", record.title), branchDefaults(repository).prefix);
		return { git: true, ...(branch ? { branch } : {}), forkBranch: await freeBranchName([main], named), ownBranch: !!record.worktree, ...(record.project?.role === 'thread' ? { branchOnly: true } : {}) };
	}

	/**
	 * Move to its own branch, from the agent's row or its tab: after a dialog,
	 * the agent's whole session goes to a new agent on a new branch from its
	 * folder, with the folder's uncommitted changes, opened in its place; the
	 * agent is archived, its changes here undone first when so chosen.
	 */
	async moveToBranch(id: string | undefined): Promise<void> {
		const record = id ? this.model.agent(id) : undefined;
		const folder = record && this.model.folderOf(record);
		const git = !!folder && !!await repositoryRoot(folder);
		const live = record && git ? this.host.ensureLive(record.id) : undefined;
		const refusal = moveRefusal(record, { git, busy: !!live?.controller.running });
		if (refusal || !record || !folder || !live) {
			void vscode.window.showInformationMessage(refusalText(refusal ?? 'gone'));
			return;
		}
		// Its saved chat and change list may still be on their way in.
		await live.controller.whenRestored;
		const undoable = live.changes.files.filter(file => file.original !== undefined).length;
		const choices = moveChoices(undoable);
		const buttons = choices.map(choice => ({ title: choice === 'move' ? vscode.l10n.t("Move") : vscode.l10n.t("Move and undo here"), choice }));
		const detail = [
			vscode.l10n.t("The chat and your uncommitted changes move to a new branch in a worktree of their own. The changes stay in this checkout too."),
			...choices.includes('moveAndUndo') ? [vscode.l10n.t("Move and undo here also puts back the {0} files the agent changed in this checkout, once they are on the new branch.", undoable)] : [],
		].join('\n\n');
		const picked = await vscode.window.showWarningMessage(vscode.l10n.t("Move \"{0}\" to its own branch?", record.title), { modal: true, detail }, ...buttons);
		if (!picked) {
			return;
		}
		try {
			await this.runMove(record, folder, live, picked.choice);
		} catch (err) {
			void showError(vscode.l10n.t("Couldn't move \"{0}\" to its own branch: {1}", record.title, errorMessage(err)));
		}
	}

	/** The move's steps, in the order `moveSteps` gives. */
	private async runMove(record: AgentRecord, folder: string, live: ForkingAgent, choice: MoveChoice): Promise<void> {
		for (const step of moveSteps(choice)) {
			switch (step) {
				case 'move': {
					const state = live.session.client.state;
					const sessionId = state.kind === 'ready' ? state.savedSessionId : record.sessionId;
					const saved = sessionId ? await readSessionMessages(live.session.client.cwd, sessionId) : undefined;
					const items = forkedItems(live.controller.conversation);
					if (!saved || !items) {
						throw new Error(vscode.l10n.t("The Gemini CLI has no saved session for this chat yet."));
					}
					const branch = await freeBranchName([await mainRepository(folder)], moveBranchName(record.title, branchDefaults(folder).prefix));
					await this.start(record.id, { request: { title: record.title, context: 'whole', ownBranch: true, branch }, messages: saved.messages, items, onStarted: () => undefined }, 'move');
					break;
				}
				case 'undo':
					await this.undoHere(live);
					break;
				case 'archive':
					this.host.archive(record.id);
					break;
			}
		}
	}

	/** Undo All for the agent's changes in this checkout: files it created go, the rest get their text from before its first edit. */
	private async undoHere(live: ForkingAgent): Promise<void> {
		for (const file of live.changes.files.filter(file => file.original !== undefined)) {
			try {
				const next = file.created ? '' : file.original!;
				if (file.created) {
					await deleteFile(file.path);
				} else {
					await replaceFileText(file.path, next, true);
				}
				live.changes.keep(file.path, next, next);
			} catch (err) {
				void showError(vscode.l10n.t("Could not undo the changes to {0}: {1}", path.basename(file.path), errorMessage(err)));
			}
		}
	}

	/** Makes agent `parentId`'s fork (or, with `kind` move, the agent it moves to), opens it and sends it its first message. */
	private async start(parentId: string, start: ForkStart, kind: StartKind = 'fork'): Promise<void> {
		const parent = this.model.agent(parentId);
		const parentFolder = parent && this.model.folderOf(parent);
		if (!parent || !parentFolder) {
			throw new Error(vscode.l10n.t("The agent is no longer here."));
		}
		const { request } = start;
		const thread = parent.project?.role === 'thread' ? parent.project : undefined;
		if (thread && (!request.ownBranch || parent.repos?.length)) {
			throw new Error(vscode.l10n.t("A thread's fork is a new thread, so it needs a branch of its own."));
		}
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
			if (thread && worktree) {
				const workspaceFolder = this.model.workspace(parent.workspaceId)?.folder;
				if (workspaceFolder) {
					await this.host.linkThreadRules(workspaceFolder, worktree.cwd);
				}
			}
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
		const project: AgentProjectRole | undefined = thread && { role: 'thread', coordinator: thread.coordinator, byCoordinator: false };
		// A moved agent is one of its own, not listed under the one it came from, which is archived.
		const fork = kind === 'move' ? this.addMoved(parent, request.title, worktree, sessionId) : this.model.addFork(parent, request.title, sharedFolder ? { sharedFolder } : {}, worktree, sessionId, project);
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
		if (kind === 'move') {
			// The same chat carries on; no line about a fork.
			live.controller.restore(start.items, sessionId);
			live.controller.addContext(moveNote(parentFolder, folder, worktree?.branch ?? ''));
		} else {
			live.controller.startFork(start.items, sessionId, { parent: parent.id, title: parent.title, context: request.context });
			if (start.conversation?.length) {
				live.controller.carryConversation(parent.title, start.conversation);
			}
			live.controller.addContext(forkNote(parent.title, parentFolder, folder, worktree?.branch));
		}
		if (thread) {
			await this.host.threadForked(this.model.agent(fork.id) ?? fork, parent, request.context);
		}
		await this.host.open(fork.id);
		start.onStarted(fork.id, worktree?.branch);
		this.service.writeLog(kind === 'move'
			? `Moved "${parent.title}" to its own branch ${worktree?.branch}.`
			: `Forked "${parent.title}" as "${fork.title}" (${request.context}${worktree ? `, on ${worktree.branch}` : ', in the same folder'}).`);
		if (request.message?.trim()) {
			void live.controller.send(request.message.trim());
		}
	}

	/** The agent a move makes: in the same workspace, on its branch and session, with the title kept. */
	private addMoved(parent: AgentRecord, title: string, worktree: AgentWorktree | undefined, sessionId: string | undefined): AgentRecord {
		const agent = this.model.addAgent(parent.workspaceId, title, worktree);
		if (sessionId) {
			this.model.setSessionId(agent.id, sessionId);
		}
		// Named after the agent it came from, so the first prompt doesn't rename it.
		this.model.rename(agent.id, title);
		return this.model.agent(agent.id) ?? agent;
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
		return this.worktrees.makeFrom(parentFolder, await freeBranchName([main], name || `${branchDefaults(parentFolder).prefix}fork`));
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
				void this.host.mergeBack(agent).catch(err => showError(errorMessage(err)));
				break;
		}
	}
}

/** Why the agent can't move to its own branch, for the user. */
function refusalText(refusal: MoveRefusal): string {
	switch (refusal) {
		case 'gone':
			return vscode.l10n.t("Select an agent to move to its own branch.");
		case 'project':
			return vscode.l10n.t("A project chat has no code of its own to move: move one of its threads instead.");
		case 'repos':
			return vscode.l10n.t("A thread that works in several repositories is on branches of its own already.");
		case 'ownBranch':
			return vscode.l10n.t("The agent is on a branch of its own already.");
		case 'noGit':
			return vscode.l10n.t("The agent's folder is not in a Git repository, so it can't have its own branch.");
		case 'busy':
			return vscode.l10n.t("Wait for the agent to finish its turn, or stop it, before moving it to its own branch.");
	}
}

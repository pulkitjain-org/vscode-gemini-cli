/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every way of starting an agent: New Agent (on its own branch or not), a
// task from Agent Home, the team flows, the browser's New Agent dialog and
// Review My Changes. Each adds the agent to the list and opens its tab.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Attachment } from '../../acp/attachments';
import type { AgentRecord, AgentsModel } from '../../acp/agents';
import { isModeAllowed } from '../../acp/adminPolicy';
import { branchNameFrom, isValidBranchName } from '../../acp/branchNames';
import { errorMessage } from '../../acp/errors';
import { reviewRequest, workingChanges } from '../../acp/reviewPrompt';
import { AgentWorktree, repositoryRoot } from '../../acp/worktrees';
import type { AgentSession } from '../agentSession';
import type { ChatController } from '../chatController';
import { configSection, getApprovalPolicy } from '../configuration';
import { tildify } from '../displayText';
import { knownModelList, sessionModel, sessionModelList } from '../modelPreference';
import type { HomeMode } from '../panelProtocol';
import type { AgentTree, AgentTreeNode } from './agentTree';
import type { AgentWorktrees } from './agentWorktrees';
import { showError } from '../errorNotice';

/** What starting an agent needs of the Agents pane. */
export interface AgentStartsHost {
	/** Starts the agent's session in this window, so it opens in the mode set on it before its tab opens. */
	start(record: AgentRecord, folder: string): { readonly session: Pick<AgentSession, 'client' | 'ensureReady'>; readonly controller: Pick<ChatController, 'send' | 'addAttachments'> };
	/** Opens the agent's tab, starting its session if it has none. */
	open(id: string): Promise<void>;
	/** The model agent `id`'s first session starts on. */
	pickModel(id: string, model: string): void;
}

export class AgentStarts {

	constructor(
		private readonly model: AgentsModel,
		private readonly worktrees: AgentWorktrees,
		private readonly tree: Pick<AgentTree, 'workspaceNodes' | 'workspaces'>,
		/** The agents running in this window. */
		private readonly live: ReadonlyMap<string, { readonly session: Pick<AgentSession, 'client'> }>,
		private readonly host: AgentStartsHost,
	) { }

	/**
	 * Starts an agent in a workspace. With `ownBranch` (or the setting), it
	 * works on a new branch in its own worktree; unset falls back to the
	 * workspace folder outside a Git repository.
	 */
	async newAgent(node: AgentTreeNode | undefined, ownBranch?: boolean): Promise<string | undefined> {
		const folder = node?.kind === 'workspace' ? node.folder : node?.kind === 'agent' ? this.model.workspace(node.record.workspaceId)?.folder : await this.pickFolder();
		if (!folder) {
			return undefined;
		}
		let worktree: AgentWorktree | undefined;
		if (ownBranch ?? vscode.workspace.getConfiguration(configSection).get<boolean>('agents.ownBranch', false)) {
			const repository = await repositoryRoot(folder);
			if (repository) {
				worktree = await this.worktrees.ask(repository, folder);
				if (!worktree) {
					return undefined;
				}
			} else if (ownBranch) {
				void showError(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
				return undefined;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		await this.host.open(agent.id);
		return agent.id;
	}

	/** Starts an agent in `folder` (on its own branch, named after the prompt, with `ownBranch`) and sends it `text`. */
	/** Returns whether the agent started; when not, the user has been told why. */
	async startWithPrompt(folder: string, text: string, ownBranch: boolean, mode: string, attachments: readonly Attachment[]): Promise<boolean> {
		let worktree: AgentWorktree | undefined;
		if (ownBranch) {
			worktree = await this.worktrees.makeFree(folder, branchNameFrom(text));
			if (!worktree) {
				return false;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		// Started here, so its session opens in the mode picked.
		const live = this.host.start(agent, worktree?.cwd ?? folder);
		// Default too, picked over `gemini.agents.defaultMode`.
		live.session.client.setModeOnNextSession(mode);
		await this.host.open(agent.id);
		// Not awaited: send resolves when the whole turn ends, and the agent has started now.
		void live.controller.send(text, attachments);
		return true;
	}

	/**
	 * Starts an agent for the team flows (src/host/teamFlows.ts), named
	 * `title`: in `worktree` when given (a review or a release merge), else on
	 * a new branch `branch` from `folder`, else in `folder` itself. Sends
	 * `text` unless it is empty. Resolves with its id; undefined when its
	 * branch could not be made (the user has been told).
	 */
	async startTeamAgent(options: { readonly folder: string; readonly title: string; readonly text: string; readonly branch?: string; readonly worktree?: AgentWorktree; readonly mode?: string }): Promise<string | undefined> {
		let worktree = options.worktree;
		if (!worktree && options.branch) {
			worktree = await this.worktrees.makeFree(options.folder, options.branch);
			if (!worktree) {
				return undefined;
			}
		}
		const workspace = this.model.addWorkspace(options.folder);
		const agent = this.model.addAgent(workspace.id, options.title, worktree);
		// Named by the flow, so the first prompt doesn't rename it.
		this.model.rename(agent.id, options.title);
		const live = this.host.start(agent, worktree?.cwd ?? options.folder);
		if (options.mode) {
			live.session.client.setModeOnNextSession(options.mode);
		}
		await this.host.open(agent.id);
		if (options.text.trim()) {
			void live.controller.send(options.text);
		}
		return agent.id;
	}

	/**
	 * The browser's New Agent: one popup (`_gemini.newAgentDialog`, drawn by
	 * GeminiCode's workbench) asks where the agent works, on its own branch or
	 * not, its model and mode, and optionally what it should do. Then the agent
	 * starts with its tab open. `page` names the branch by default. Resolves
	 * with the agent and its task, or undefined when the user cancels.
	 */
	async newAgentFor(page: string): Promise<{ readonly id: string; readonly title: string; readonly task?: string } | undefined> {
		// The models the agent offers come with a session; any running agent's list will do, else the last list any session sent.
		const offered = [...this.live.values()].find(live => live.session.client.settings.model?.available.length)?.session.client.settings.model?.available;
		const models = offered ? sessionModelList(offered) : knownModelList();
		const places = await this.tree.workspaces();
		const choice = await vscode.commands.executeCommand<{ folder: string; ownBranch: boolean; branch?: string; model?: string; mode: string; task?: string } | undefined>('_gemini.newAgentDialog', {
			page,
			folders: places.map(place => ({ folder: place.folder, label: path.basename(place.folder) || place.folder, description: tildify(place.folder), git: place.git })),
			models: models.map(model => ({ id: model.id, name: model.name })),
			...(models.length ? { defaultModel: sessionModel(models) } : {}),
			modes: startModes().filter(mode => isModeAllowed(getApprovalPolicy(), mode.id)),
			branchPlaceholder: branchNameFrom(page),
		});
		if (!choice || typeof choice.folder !== 'string' || !path.isAbsolute(choice.folder)) {
			return undefined;
		}
		const { folder, ownBranch, model } = choice;
		const mode = typeof choice.mode === 'string' ? choice.mode : 'default';
		let worktree: AgentWorktree | undefined;
		if (ownBranch) {
			worktree = await this.worktrees.makeFree(folder, choice.branch && isValidBranchName(choice.branch) ? choice.branch : branchNameFrom(page));
			if (!worktree) {
				return undefined;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		if (model) {
			this.host.pickModel(agent.id, model);
		}
		const live = this.host.start(agent, worktree?.cwd ?? folder);
		// Default too, picked over `gemini.agents.defaultMode`.
		live.session.client.setModeOnNextSession(mode);
		await this.host.open(agent.id);
		return { id: agent.id, title: agent.title, ...(choice.task ? { task: choice.task } : {}) };
	}

	/**
	 * "Review my changes": starts an agent in Plan mode, so it reads but does
	 * not edit, with the repository's uncommitted diff attached.
	 */
	async reviewChanges(source?: { readonly rootUri?: vscode.Uri }): Promise<void> {
		const folder = source?.rootUri?.fsPath ?? await reviewFolder();
		if (!folder) {
			return;
		}
		const repository = await repositoryRoot(folder);
		if (!repository) {
			void showError(vscode.l10n.t("{0} is not in a Git repository, so there are no changes to review.", path.basename(folder)));
			return;
		}
		let changes;
		try {
			changes = await workingChanges(repository);
		} catch (err) {
			void showError(vscode.l10n.t("Could not read the changes: {0}", errorMessage(err)));
			return;
		}
		if (!changes.diff.trim() && !changes.untracked.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t("{0} has no uncommitted changes to review.", path.basename(repository)));
			return;
		}
		const request = reviewRequest(changes);
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("Review my changes"));
		this.model.rename(agent.id, agent.title);
		// Started here, so it opens its session in Plan mode.
		const live = this.host.start(agent, folder);
		live.session.client.setModeOnNextSession('plan');
		await this.host.open(agent.id);
		try {
			await live.session.ensureReady();
		} catch {
			// Sending shows why the agent could not start.
		}
		const client = live.session.client;
		if (client.state.kind === 'ready' && client.settings.mode?.currentId !== 'plan') {
			// Without Plan mode (an older CLI, or turned off by policy) the reviewer could edit files; let the user choose.
			void vscode.window.showWarningMessage(vscode.l10n.t("Plan mode isn't available, so the reviewer could change files. Pick a mode in its chat, then ask it to review the attached diff."));
			await live.controller.addAttachments(request.attachments);
			return;
		}
		await live.controller.send(request.text, request.attachments);
	}

	/** Add Workspace: a folder the user picks, with a new agent in it. */
	async addWorkspace(): Promise<void> {
		const folder = await chooseFolder();
		if (folder) {
			const workspace = this.model.addWorkspace(folder);
			await this.host.open(this.model.addAgent(workspace.id, vscode.l10n.t("New agent")).id);
		}
	}

	private async pickFolder(): Promise<string | undefined> {
		const workspaces = this.tree.workspaceNodes();
		if (workspaces.length === 1) {
			return workspaces[0].folder;
		}
		const addWorkspace = vscode.l10n.t("Add Workspace...");
		const picks: (vscode.QuickPickItem & { folder?: string })[] = [
			...workspaces.map(w => ({ label: path.basename(w.folder), description: tildify(w.folder), folder: w.folder })),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: `$(new-folder) ${addWorkspace}` },
		];
		const pick = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t("New Agent"), placeHolder: vscode.l10n.t("Which workspace should the agent work in?") });
		if (!pick) {
			return undefined;
		}
		return pick.folder ?? chooseFolder();
	}
}

/** The approval modes a new agent can start in, in the order the chat lists them. */
export function startModes(): HomeMode[] {
	return [
		{ id: 'default', name: vscode.l10n.t("Default"), description: vscode.l10n.t("Asks before changes") },
		{ id: 'autoEdit', name: vscode.l10n.t("Auto Edit"), description: vscode.l10n.t("Edits without asking") },
		{ id: 'plan', name: vscode.l10n.t("Plan"), description: vscode.l10n.t("Read-only") },
	];
}

/** A folder the user picks to add as a workspace; undefined when dismissed. */
export async function chooseFolder(): Promise<string | undefined> {
	const [uri] = await vscode.window.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		openLabel: vscode.l10n.t("Add Workspace"), title: vscode.l10n.t("Add a workspace for agents"),
	}) ?? [];
	return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/** The folder of the active editor, else the only open folder, else the one the user picks. */
async function reviewFolder(): Promise<string | undefined> {
	const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (active || folders.length <= 1) {
		return (active ?? folders[0])?.uri.fsPath;
	}
	return (await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t("Review the changes in which folder?") }))?.uri.fsPath;
}

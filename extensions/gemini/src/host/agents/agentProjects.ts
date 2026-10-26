/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's side of Projects: starting a project and its
// threads (each on a new branch in its own worktree, or across several
// repositories in a folder of its own), the trust and rules their folders
// need, and Clean Up of merged threads' folders.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentClient } from '../../acp/agentClient';
import { AgentRecord, AgentsModel, freeTitle, ThreadRepo, WorkspaceRecord } from '../../acp/agents';
import { branchNameFrom, isValidBranchName } from '../../acp/branchNames';
import { errorMessage } from '../../acp/errors';
import { threadMemoryContext, threadPrompt, type ThreadRequest } from '../../acp/projectHub';
import { linkCoordinatorRules, linkThreadRules, ruleEntries, ruleFolders } from '../../acp/projectRules';
import { savedRepoCount, type ProjectRepo } from '../../acp/projectStore';
import { foldersTrusted } from '../../acp/trustedFolders';
import { AgentWorktree, branchExists, coordinatorHome, createWorktreeAt, currentBranch, folderSize, freeBranchName, freeFolder, inRepository, pathExists, projectFolders, removeThreadFolder, removeWorktree, repositoryRoot, threadGuide, threadsHome, worktreeStatus, writeThreadGuide } from '../../acp/worktrees';
import type { AgentService } from '../agentService';
import type { ChatActivity, ChatController } from '../chatController';
import { configSection } from '../configuration';
import { formatBytes, tildify } from '../displayText';
import { projectsEnabled, type Projects, type ThreadSetup } from '../projects';
import type { AgentMerge } from './agentMerge';
import { chooseFolder } from './agentStarts';
import type { AgentTree, AgentTreeNode } from './agentTree';
import type { AgentWorktrees } from './agentWorktrees';
import { showError } from '../errorNotice';

/** What starting and cleaning up project agents needs of the Agents pane. */
export interface AgentProjectsHost {
	/** Starts an agent's session in this window, without a tab. */
	start(record: AgentRecord, folder: string): { readonly session: { readonly client: Pick<AgentClient, 'setModeOnNextSession'> }; readonly controller: Pick<ChatController, 'addContext'> };
	/** Ends an agent's session in this window; with `save`, keeps its conversation for later. */
	stop(id: string, save: boolean): void;
	/** Opens the agent's tab. */
	open(id: string): Promise<void>;
	/** Starts the agent's session without a tab, when it has none in this window. */
	ensureLive(id: string): void;
	/** Redraws the list, or agent `id`'s row. */
	refresh(id?: string): void;
	/** The model agent `id`'s first session starts on. */
	pickModel(id: string, model: string): void;
	/** Removes the agent, its folder and, with `deleteBranch`, its branch. */
	removeAgent(id: string, deleteBranch: boolean): Promise<void>;
}

export class AgentProjects {

	/** Threads whose worktree setup still runs; they get their brief when it ends. */
	private readonly settingUp = new Set<string>();

	constructor(
		private readonly model: AgentsModel,
		private readonly service: Pick<AgentService, 'writeLog' | 'restartWhenIdle' | 'trustFolder' | 'runtime'>,
		private readonly projects: Pick<Projects, 'ready' | 'sendBrief'>,
		private readonly worktrees: AgentWorktrees,
		private readonly merge: Pick<AgentMerge, 'isMerging'>,
		/** The agents running in this window. */
		private readonly live: ReadonlyMap<string, { readonly activity: ChatActivity }>,
		private readonly tree: Pick<AgentTree, 'workspaceNodes'>,
		private readonly host: AgentProjectsHost,
	) { }

	/** Whether thread `id`'s worktree setup still runs. */
	isSettingUp(id: string): boolean {
		return this.settingUp.has(id);
	}

	/** Starts a project: a coordinator agent in a Git workspace, whose chat is the project chat. */
	async newProject(node: AgentTreeNode | undefined): Promise<void> {
		if (!projectsEnabled()) {
			const enable = vscode.l10n.t("Turn On");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Projects are turned off in Settings. Turn them on?"), enable) !== enable) {
				return;
			}
			await vscode.workspace.getConfiguration(configSection).update('projects.enabled', true, vscode.ConfigurationTarget.Global);
		}
		const folder = node?.kind === 'workspace' ? node.folder : node?.kind === 'agent' ? this.model.workspace(node.record.workspaceId)?.folder : await this.pickProjectFolder();
		if (!folder) {
			return;
		}
		const repository = await repositoryRoot(folder);
		if (!repository) {
			void showError(vscode.l10n.t("{0} is not in a Git repository. A project's threads each work on their own branch, so a project needs one.", path.basename(folder)));
			return;
		}
		if (!await this.ensureProjectTrust(folder)) {
			return;
		}
		// No other questions: the project chat opens at once, named after its repository; Rename changes it.
		const workspace = this.model.addWorkspace(folder);
		const taken = new Set(this.model.snapshot().agents.filter(a => a.project?.role === 'coordinator').map(a => a.title));
		const title = freeTitle(path.basename(repository), taken);
		const agent = this.model.addAgent(workspace.id, title, undefined, undefined, { role: 'coordinator' });
		this.model.rename(agent.id, title);
		await this.host.open(agent.id);
	}

	/**
	 * Starts one of a project's threads: a new agent on a new branch in its own
	 * worktree, sent its brief at once. Its tab opens only when the user opens it.
	 */
	async startThread(coordinatorId: string, request: ThreadRequest, setup: ThreadSetup = {}): Promise<string> {
		const coordinator = this.model.agent(coordinatorId);
		const workspace = coordinator && this.model.workspace(coordinator.workspaceId);
		if (!workspace) {
			throw new Error(vscode.l10n.t("The project is gone."));
		}
		const prefixed = setup.branchPrefix !== undefined ? branchNameFrom(request.title, setup.branchPrefix) : undefined;
		const named = request.branch && isValidBranchName(request.branch) ? request.branch
			: prefixed && isValidBranchName(prefixed) ? prefixed : branchNameFrom(request.title);
		if (setup.repos?.length) {
			return this.startMultiRepoThread(coordinatorId, workspace, request, setup, named, setup.repos);
		}
		const repository = await repositoryRoot(workspace.folder);
		if (!repository) {
			throw new Error(vscode.l10n.t("{0} is not in a Git repository, so a thread can't have its own branch.", path.basename(workspace.folder)));
		}
		const worktree = await this.worktrees.addThreadWorktree(repository, named, workspace.folder);
		let agentId: string | undefined;
		try {
			await this.linkRules(workspace.folder, worktree.cwd, 'thread');
			const agent = this.model.addAgent(workspace.id, request.title, worktree, request.id, {
				role: 'thread', coordinator: coordinatorId, byCoordinator: request.byCoordinator,
				...(request.planFirst ? { planFirst: true } : {}),
				...(request.track ? { track: request.track } : {}),
			});
			agentId = agent.id;
			this.model.rename(agent.id, request.title);
			if (request.model) {
				this.host.pickModel(agent.id, request.model);
			}
			await this.projects.ready();
			const live = this.host.start(this.model.agent(agent.id) ?? agent, worktree.cwd);
			if (request.planFirst) {
				live.session.client.setModeOnNextSession('plan');
			}
			this.host.refresh();
			// The agent starts while the repository's setup runs, and gets its brief
			// when setup ends; the caller (the coordinator's start_thread) doesn't wait.
			if (setup.memory) {
				live.controller.addContext(threadMemoryContext(setup.memory));
			}
			this.briefAfterSetup(agent.id, threadPrompt(request.brief, request.planFirst), request.byCoordinator ? 'coordinator' : undefined, this.worktrees.setUpThread(repository, worktree));
			return agent.id;
		} catch (err) {
			// Nothing points at the worktree any more: remove it with its branch.
			if (agentId) {
				this.host.stop(agentId, false);
				this.model.removeAgent(agentId);
			}
			void removeWorktree(repository, worktree, true).catch(() => undefined);
			throw err;
		}
	}

	/** The add_repo tool: another of the project's repositories, as a new worktree on the thread's branch in its folder. */
	async addThreadRepo(id: string, repo: ProjectRepo, memory: string | undefined): Promise<string> {
		const record = this.model.agent(id);
		const coordinator = record?.project?.role === 'thread' ? record.project.coordinator : undefined;
		if (!record?.worktree || !record.repos?.length || !coordinator) {
			throw new Error('This thread works in one repository\'s worktree and can\'t add another. Report that the work needs a thread across repositories.');
		}
		const { folder, branch } = record.worktree;
		if (record.repos.some(each => each.key === repo.key)) {
			return `${repo.key}/ is already in your folder.`;
		}
		const made = await inRepository(repo.folder, async () => {
			if (await branchExists(repo.folder, branch)) {
				throw new Error(`${repo.key} already has a branch named ${branch}.`);
			}
			return createWorktreeAt(repo.folder, branch, path.join(folder, repo.key));
		});
		const added: ThreadRepo = { ...made, key: repo.key, repository: repo.folder };
		await this.linkRules(repo.folder, made.folder, 'thread');
		const repos = [...this.model.agent(id)?.repos ?? record.repos, added];
		this.model.setRepos(id, repos);
		await writeThreadGuide(folder, threadGuide(repos, branch, memory));
		const command = await this.worktrees.setupCommand(repo.folder).catch(() => undefined);
		if (command) {
			void this.worktrees.setUpThread(repo.folder, added, command);
		}
		return `Added ${repo.key}/ to your folder, on the branch ${branch}.${command ? ' Its setup script is running in the background, so packages may not be installed yet.' : ''}`;
	}

	/** "Undo thread": asks, then removes the thread with its folder and branch. */
	async undoThread(id: string): Promise<boolean> {
		const record = this.model.agent(id);
		if (!record) {
			return false;
		}
		const undo = vscode.l10n.t("Undo Thread");
		const detail = record.worktree
			? vscode.l10n.t("Its branch {0} and its folder are deleted, with any work on them.", record.worktree.branch)
			: undefined;
		if (await vscode.window.showWarningMessage(vscode.l10n.t("Undo the thread \"{0}\"?", record.title), { modal: true, detail }, undo) !== undo) {
			return false;
		}
		await this.host.removeAgent(id, true);
		return true;
	}

	/**
	 * The user is about to open a thread (the pointer is on its card or row, or
	 * the keyboard picked it): its session starts now, so its chat is ready
	 * when it opens. A thread already running, or whose folder was cleaned up, waits.
	 */
	prepareThread(id: string): void {
		if (!this.live.has(id)) {
			void this.resumeThread(id);
		}
	}

	/**
	 * Starts a project thread's agent without a tab, as its project opens;
	 * skipped when its worktree is gone. A thread whose brief was never sent
	 * (the window closed during its setup) runs its setup again and then gets it.
	 */
	async resumeThread(id: string): Promise<void> {
		const record = this.model.agent(id);
		const folder = record && this.model.folderOf(record);
		if (!folder || (!this.live.has(id) && !await pathExists(folder))) {
			return;
		}
		if (!this.live.has(id)) {
			this.host.ensureLive(id);
			this.host.refresh(id);
		}
		const pending = record.project?.role === 'thread' ? record.project.pending : undefined;
		if (pending?.brief && !this.settingUp.has(id) && this.live.has(id)) {
			this.briefAfterSetup(id, pending.brief, pending.from, this.setUpAgain(record));
		}
	}

	/**
	 * Project Settings' Clean Up: removes merged threads' worktree folders
	 * (with their node_modules and builds) that hold nothing unmerged. Their
	 * branches, chats and records stay, so each thread can still be opened,
	 * and its folder comes back from its branch when it is.
	 */
	async cleanUpMerged(coordinatorId: string): Promise<void> {
		const threads = this.model.threadsOf(coordinatorId).filter(thread => thread.project?.role === 'thread' && thread.project.resolved && thread.worktree
			&& !this.live.get(thread.id)?.activity.busy && !this.merge.isMerging(thread.id) && !this.settingUp.has(thread.id));
		type Folder = { readonly thread: AgentRecord; readonly repository: string; readonly worktree: AgentWorktree; readonly size: number };
		const { found, kept } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Looking at merged threads' folders...") }, async () => {
			const found: Folder[] = [];
			let kept = 0;
			for (const thread of threads) {
				for (const { repository, worktree } of await this.worktrees.threadWorktrees(thread)) {
					if (!await pathExists(worktree.folder)) {
						continue;
					}
					// Only a folder whose every change is merged into what its repository has checked out.
					const into = await currentBranch(repository).catch(() => undefined);
					const status = into ? await worktreeStatus(worktree, into).catch(() => undefined) : undefined;
					if (status && !status.uncommitted && !status.commits) {
						found.push({ thread, repository, worktree, size: await folderSize(worktree.folder) });
					} else {
						kept++;
					}
				}
			}
			return { found, kept };
		});
		const keptNote = kept === 1 ? vscode.l10n.t("1 folder has work that isn't merged yet, so it stays.") : kept ? vscode.l10n.t("{0} folders have work that isn't merged yet, so they stay.", kept) : '';
		if (!found.length) {
			void vscode.window.showInformationMessage([vscode.l10n.t("No merged thread's folder to clean up."), keptNote].filter(Boolean).join(' '));
			return;
		}
		const size = formatBytes(found.reduce((sum, folder) => sum + folder.size, 0));
		const remove = vscode.l10n.t("Remove Folders");
		const detail = [vscode.l10n.t("Each thread keeps its branch and chat. Its folder comes back from the branch when you open the thread again."), keptNote].filter(Boolean).join('\n\n');
		const question = found.length === 1 ? vscode.l10n.t("Remove 1 merged thread's folder, freeing {0}?", size) : vscode.l10n.t("Remove {0} merged threads' folders, freeing {1}?", found.length, size);
		if (await vscode.window.showWarningMessage(question, { modal: true, detail }, remove) !== remove) {
			return;
		}
		let removed = 0;
		let freed = 0;
		const failed: string[] = [];
		for (const folder of found) {
			// A turn may have started while the question was open.
			if (this.live.get(folder.thread.id)?.activity.busy) {
				continue;
			}
			// An idle thread's session runs in the folder: it ends, with its chat saved, and reopens with the folder.
			this.host.stop(folder.thread.id, true);
			try {
				await removeWorktree(folder.repository, folder.worktree, false);
				removed++;
				freed += folder.size;
			} catch (err) {
				failed.push(`${tildify(folder.worktree.folder)}: ${errorMessage(err)}`);
			}
		}
		this.host.refresh();
		if (failed.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Removed {0} folders. Could not remove {1}", removed, failed.join('; ')));
		} else {
			void vscode.window.showInformationMessage(removed === 1 ? vscode.l10n.t("Removed 1 folder, freeing {0}.", formatBytes(freed)) : vscode.l10n.t("Removed {0} folders, freeing {1}.", removed, formatBytes(freed)));
		}
	}

	/**
	 * Gives a project agent's folder the repository's own rules and skills
	 * (projectRules.ts): a coordinator's empty folder its context files, a
	 * thread's worktree all those the repository ignores. Never stops the
	 * agent starting.
	 */
	async linkRules(folder: string, into: string, role: 'coordinator' | 'thread'): Promise<void> {
		try {
			const entries = await ruleEntries(folder, path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'settings.json'));
			// The coordinator gets the context files only: skills, commands and the repository's MCP servers would pull it into doing the work.
			const linked = role === 'coordinator' ? await linkCoordinatorRules(folder, into, entries.filter(name => !ruleFolders.includes(name)), ruleFolders) : await linkThreadRules(folder, into, entries);
			if (linked.length) {
				this.service.writeLog(`Linked ${linked.join(', ')} from ${folder} into ${into}`);
			}
		} catch (err) {
			this.service.writeLog(`Could not link the project's rules into ${into}: ${errorMessage(err)}`);
		}
	}

	/**
	 * A coordinator whose session has no project tools (Projects.ensureTools):
	 * asks to trust the project's folders when they aren't, which restarts the
	 * agent; when they are, the agent started before they were, so it restarts
	 * once no agent is working. The coordinator's session reopens with the
	 * tools either way. False when the user declines.
	 */
	async reloadProjectTools(coordinatorId: string): Promise<boolean> {
		const record = this.model.agent(coordinatorId);
		const folder = record && this.model.workspace(record.workspaceId)?.folder;
		if (!folder) {
			return false;
		}
		const repository = await repositoryRoot(folder) ?? folder;
		const threads = await savedRepoCount(coordinatorHome(coordinatorId)) > 1;
		if (await foldersTrusted(projectFolders(repository, threads), process.env)) {
			this.service.restartWhenIdle('restarting so the coordinator gets the project\'s tools');
			return true;
		}
		return this.ensureProjectTrust(folder, threads);
	}

	/**
	 * A project works through its own MCP server, and the Gemini CLI loads MCP
	 * servers only in folders it trusts, so a project needs its repository and
	 * its threads' worktrees trusted. Asks when either isn't, and once trusted,
	 * waits for the agent's restart (unless a turn holds it up) so the next
	 * session has the tools. False when the user declines.
	 */
	async ensureProjectTrust(folder: string, threads = false): Promise<boolean> {
		const repository = await repositoryRoot(folder) ?? folder;
		const folders = projectFolders(repository, threads);
		if (await foldersTrusted(folders, process.env)) {
			return true;
		}
		const trust = vscode.l10n.t("Trust Folder");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Trust {0}'s project folders?", path.basename(repository)),
			{
				modal: true,
				detail: threads
					? vscode.l10n.t("A project's coordinator and threads work through GeminiCode's project tools, which the Gemini CLI loads only in trusted folders: {0}, where coordinators run, and {1} and {2}, where threads check out their branches. Trusting the threads' folders also lets the Gemini CLI load the repositories' own Gemini settings and MCP servers there, which can run programs. The Gemini CLI remembers the choice, including in the terminal.", tildify(folders[0]), tildify(folders[1]), tildify(folders[2]))
					: vscode.l10n.t("A project's coordinator and threads work through GeminiCode's project tools, which the Gemini CLI loads only in trusted folders: {0}, where coordinators run, and {1}, where threads check out their branches. Trusting the threads' folder also lets the Gemini CLI load the repository's own Gemini settings and MCP servers there, which can run programs. The Gemini CLI remembers the choice, including in the terminal.", tildify(folders[0]), tildify(folders[1])),
			},
			trust);
		if (choice !== trust) {
			return false;
		}
		const runtime = this.service.runtime;
		let waits: boolean;
		try {
			waits = await this.service.trustFolder(...folders);
		} catch (err) {
			void showError(vscode.l10n.t("Could not trust {0}: {1}", path.basename(repository), errorMessage(err)));
			return false;
		}
		if (waits) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Folder trusted. The project's tools arrive when the agent restarts, once no agent is working."));
			return true;
		}
		await new Promise<void>(resolve => {
			const done = () => {
				clearTimeout(timer);
				listener.dispose();
				resolve();
			};
			const timer = setTimeout(done, 30_000);
			const listener = runtime.onDidChangeState(state => {
				if (state.kind === 'ready' || state.kind === 'error') {
					done();
				}
			});
		});
		return true;
	}

	/**
	 * Sends a new thread its brief (`prompt`) once `setup` ends; meanwhile
	 * notes for it wait. The brief is kept on the thread's record until it is
	 * sent, so a window closed during setup sends it when the thread resumes.
	 */
	private briefAfterSetup(id: string, prompt: string, from: 'coordinator' | undefined, setup: Promise<unknown>): void {
		this.settingUp.add(id);
		const pending = this.model.agent(id)?.project;
		this.model.setThreadPending(id, { ...pending?.role === 'thread' ? pending.pending : {}, brief: prompt, ...from ? { from } : {} });
		void setup.then(async () => {
			this.settingUp.delete(id);
			if (this.model.agent(id) && this.live.get(id)) {
				// Resolves once the brief is sent or queued, not when its turn ends.
				await this.projects.sendBrief(id, prompt, from).catch(() => undefined);
				const now = this.model.agent(id)?.project;
				if (now?.role === 'thread' && now.pending?.brief === prompt) {
					this.model.setThreadPending(id, { ...now.pending, brief: undefined });
				}
			}
		});
	}

	/** Runs a thread's setup again, in each of its worktrees: one cut short by a closed window may have left them half set up. */
	private async setUpAgain(record: AgentRecord): Promise<void> {
		if (record.repos?.length) {
			await Promise.all(record.repos.filter(repo => !repo.merged).map(repo => this.worktrees.setUpThread(repo.repository, repo)));
			return;
		}
		const workspace = this.model.workspace(record.workspaceId);
		if (record.worktree && workspace) {
			await this.worktrees.setUpThread(await repositoryRoot(workspace.folder) ?? workspace.folder, record.worktree);
		}
	}

	/**
	 * A thread in several of the project's repositories: one folder of its own
	 * (~/.geminicode/threads/<project>/<branch>) with a worktree of each, all on
	 * one new branch, and a GEMINI.md that says which folder is which and holds
	 * the project's memory. The agent runs in that folder.
	 */
	private async startMultiRepoThread(coordinatorId: string, workspace: WorkspaceRecord, request: ThreadRequest, setup: ThreadSetup, named: string, repos: readonly ProjectRepo[]): Promise<string> {
		// Its folder must be trusted for the project's tools to load there.
		if (!await this.ensureProjectTrust(workspace.folder, true)) {
			throw new Error(vscode.l10n.t("A thread across repositories needs its folder trusted."));
		}
		// Threads started together take turns, so they can't pick the same branch or folder: the project's
		// threads under its own key (their folders), and every repository's git lock (their branches).
		const made = await this.worktrees.inTurn(`threads:${coordinatorId}`, () => inRepository(repos.map(repo => repo.folder), async () => {
			const branch = await freeBranchName(repos.map(repo => repo.folder), named);
			const folder = await freeFolder(threadsHome(coordinatorId), branch);
			await fs.promises.mkdir(folder, { recursive: true });
			const results = await Promise.allSettled(repos.map(repo => createWorktreeAt(repo.folder, branch, path.join(folder, repo.key))));
			const worktrees: ThreadRepo[] = results.flatMap((result, i) => result.status === 'fulfilled' ? [{ ...result.value, key: repos[i].key, repository: repos[i].folder }] : []);
			const failed = results.find(result => result.status === 'rejected');
			if (failed) {
				await removeThreadFolder(worktrees, folder, true).catch(() => undefined);
				throw failed.reason;
			}
			return { branch, folder, worktrees };
		}));
		const worktree: AgentWorktree = { folder: made.folder, cwd: made.folder, branch: made.branch, base: made.worktrees[0].base };
		let agentId: string | undefined;
		try {
			await Promise.all(made.worktrees.map(each => this.linkRules(each.repository, each.folder, 'thread')));
			await writeThreadGuide(made.folder, threadGuide(made.worktrees, made.branch, setup.memory));
			const agent = this.model.addAgent(workspace.id, request.title, worktree, request.id, {
				role: 'thread', coordinator: coordinatorId, byCoordinator: request.byCoordinator,
				...(request.planFirst ? { planFirst: true } : {}),
				...(request.track ? { track: request.track } : {}),
			});
			agentId = agent.id;
			this.model.setRepos(agent.id, made.worktrees);
			this.model.rename(agent.id, request.title);
			if (request.model) {
				this.host.pickModel(agent.id, request.model);
			}
			await this.projects.ready();
			const live = this.host.start(this.model.agent(agent.id) ?? agent, made.folder);
			if (request.planFirst) {
				live.session.client.setModeOnNextSession('plan');
			}
			this.host.refresh();
			this.briefAfterSetup(agent.id, threadPrompt(request.brief, request.planFirst), request.byCoordinator ? 'coordinator' : undefined, Promise.all(made.worktrees.map(each => this.worktrees.setUpThread(each.repository, each))));
			return agent.id;
		} catch (err) {
			if (agentId) {
				this.host.stop(agentId, false);
				this.model.removeAgent(agentId);
			}
			void removeThreadFolder(made.worktrees, made.folder, true).catch(() => undefined);
			throw err;
		}
	}

	/** Where a new project works: a workspace the list knows, or any folder. */
	private async pickProjectFolder(): Promise<string | undefined> {
		const choose = vscode.l10n.t("Choose a Folder...");
		const picks: (vscode.QuickPickItem & { folder?: string })[] = [
			...this.tree.workspaceNodes().map(w => ({ label: `$(folder) ${path.basename(w.folder)}`, description: tildify(w.folder), folder: w.folder })),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: `$(folder-opened) ${choose}` },
		];
		const pick = await vscode.window.showQuickPick(picks, {
			title: vscode.l10n.t("New Project"),
			placeHolder: vscode.l10n.t("Which folder should the project work in? It must be in a Git repository, as each thread gets its own branch."),
		});
		if (!pick) {
			return undefined;
		}
		return pick.folder ?? chooseFolder();
	}
}

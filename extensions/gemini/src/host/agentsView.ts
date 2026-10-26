/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, ChangeTotals } from '../acp/agentChanges';
import { attentionChange } from '../acp/attention';
import { branchNameFrom } from '../acp/branchNames';
import { agentFolder, AgentRecord, AgentsModel, AgentsSnapshot } from '../acp/agents';
import { coordinatorModel } from '../acp/projectHub';
import { savedRepoCount } from '../acp/projectStore';
import type { Attachment } from '../acp/attachments';
import { FolderFileIndex } from '../acp/folderFiles';
import { errorMessage } from '../acp/errors';
import type { SessionChoice } from '../acp/sessionSettings';
import { TranscriptStore } from '../acp/transcriptStore';
import { CheckpointStore } from '../acp/checkpointStore';
import { AgentWorktree, coordinatorHome, removeThreadFolder, removeWorktree, repositoryRoot, worktreeStatus } from '../acp/worktrees';
import { AgentNotifier } from './agentNotifier';
import { AgentTerminals } from './agentTerminals';
import { AgentService } from './agentService';
import { AgentSession } from './agentSession';
import { ChangesSource, ChangesView } from './changesView';
import type { AgentStateKind } from './panelProtocol';
import { ReviewController } from './reviewController';
import { CommitSettler } from './commitSettler';
import type { BrowserTools } from './browserTools';
import type { TeamConnections } from './teamConnections';
import type { WorkspaceIndex } from './workspaceIndex';
import { toolChipsFor } from './toolChips';
import { ChatActivity, ChatController, ChatEnhancer, ChatTerminal, ChatWorkspace, FileSearch, openChatAsMarkdown } from './chatController';
import { configSection } from './configuration';
import { tildify } from './displayText';
import { Projects, projectsEnabled } from './projects';
export { relativeTime } from './displayText';
import { DiffPreview } from './diffPreview';
import { agentColumn, agentsColumn, closeAgentFiles } from './editorPlacement';
import { sessionModel } from './modelPreference';
import type { UsageMeter } from './usageMeter';
import { WorkspaceFileIndex } from './workspaceFiles';
import { AgentIndicators } from './agents/agentIndicators';
import { AgentMerge } from './agents/agentMerge';
import { AgentProjects } from './agents/agentProjects';
import { AgentForks } from './agents/agentForks';
import { AgentStarts } from './agents/agentStarts';
import { agentState, AgentTree, AgentTreeNode, WorkspaceSummary } from './agents/agentTree';
import { AgentWorktrees } from './agents/agentWorktrees';
import { spareDelayMs, SpareSession } from './agents/spareSession';
export { startModes } from './agents/agentStarts';
export type { WorkspaceSummary } from './agents/agentTree';

const agentPanelType = 'gemini.agent';
const storageKey = 'gemini.agents';

/** One agent, as Agent Home and the title bar show it. */
export interface AgentSummary {
	readonly id: string;
	readonly title: string;
	/** The workspace it belongs to. */
	readonly folder: string;
	readonly state: AgentStateKind;
	/** A plain status line, such as "Needs you: Shell npm test". */
	readonly status: string;
	readonly changes?: ChangeTotals;
	readonly worktree?: AgentWorktree;
	readonly updatedAt: number;
	/** Its part in a project, while Projects are on; a coordinator also has its thread count. */
	readonly project?: { readonly role: 'coordinator'; readonly threads: number } | { readonly role: 'thread' };
}

/** An agent with a live session in this window. */
interface LiveAgent {
	readonly session: AgentSession;
	readonly controller: ChatController;
	/** The files this agent's tools edited. */
	readonly changes: AgentChanges;
	panel?: vscode.WebviewPanel;
	/** A turn finished while its tab was not in front. */
	unread: boolean;
	activity: ChatActivity;
	/** A pending save of the conversation. */
	saveTimer?: ReturnType<typeof setTimeout>;
	/** When the oldest change not yet saved happened, so a long reply is saved while it streams. */
	unsavedSince?: number;
	/** The icon file its tab shows (its state, or Gemini's or Jira's at rest); unset until set. */
	tabIcon?: string;
	readonly disposables: vscode.Disposable[];
}

/** How long after a turn ends its conversation is saved, so quick turns write once. */
const saveDelayMs = 1_000;
/** The longest a change waits to be saved while updates keep coming, so a crash mid-reply loses little. */
const saveMaxWaitMs = 10_000;

/**
 * The Agents pane: workspaces, the agents under each, and an editor tab per
 * agent that reuses the chat. Every agent is a session on the one shared agent
 * process, so a new agent is ready in tens of milliseconds once the agent runs.
 * This class owns the agents running in this window (their sessions, chats and
 * tabs) and their saved state; the list, the window's indicators, the spare
 * session, worktrees, Merge Back, Projects and the ways of starting an agent
 * are modules in `./agents/`.
 */
export class AgentsView implements vscode.Disposable {

	private readonly model: AgentsModel;
	/** Each agent's conversation as shown, so its tab looks the same after a reload. */
	private readonly transcripts: TranscriptStore;
	/** Each agent's checkpoints, for Undo and Rewind after a reload. */
	private readonly checkpointFiles: CheckpointStore;
	private readonly live = new Map<string, LiveAgent>();
	/** The model an agent's first session starts on, picked in the New thread dialog or the browser's New Agent. */
	private readonly threadModels = new Map<string, string>();
	private readonly changesView: ChangesView;
	/** Keep and Undo on each agent change, in the files themselves. */
	readonly review: ReviewController;
	/** Takes committed files out of each agent's changes to review. */
	private readonly settler: CommitSettler;
	/** The agent whose tab was last in front; the Changes view shows it. */
	private focusedId: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly tree: AgentTree;
	private readonly notifier = new AgentNotifier();
	private readonly indicators: AgentIndicators;
	private readonly spare: SpareSession;
	private readonly worktrees: AgentWorktrees;
	private readonly merge: AgentMerge;
	private readonly projectAgents: AgentProjects;
	private readonly starts: AgentStarts;
	private readonly forks: AgentForks;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	/** Set while the extension shuts down, when closing agent tabs must not close their files. */
	private disposing = false;

	/** Agents, their states or their workspaces changed. */
	private readonly onDidChangeAgentsEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeAgents = this.onDidChangeAgentsEmitter.event;
	/** The agent whose changes show changed; Agents mode's Changes panel follows it. */
	private readonly onDidFocusEmitter = new vscode.EventEmitter<ChangesSource | undefined>();
	readonly onDidFocus = this.onDidFocusEmitter.event;
	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	/** What the pending refresh redraws: the whole tree, or just these agents' rows. */
	private refreshAll = false;
	private readonly refreshRows = new Set<string>();
	/** Each agent's page in the GeminiCode browser; set once the extension has made it. */
	browser: BrowserTools | undefined;
	/** The team's tools (Jira, GitLab, SonarQube, Snyk, Figma), for every agent's session; set by activate. */
	teamTools: TeamConnections | undefined;
	/** The merge request review a reviewer agent works on, for its chat's chip, and opening it; set by activate. */
	reviewChip: ((agentId: string) => { readonly label: string; readonly tip: string } | undefined) | undefined;
	openReview: ((agentId: string) => void) | undefined;
	/** The index of each agent's folder and its attached docs, for every agent's session; set by activate. */
	index: WorkspaceIndex | undefined;
	/** Today's quota, for the chats' usage popover. */
	usage: UsageMeter | undefined;
	/** One direct request to the quick model, for drafting a project's memory; set once the extension has made it. */
	direct: ((request: { readonly system: string; readonly prompt: string }) => Promise<string | undefined>) | undefined;
	private persistTimeout: ReturnType<typeof setTimeout> | undefined;
	/** Projects: coordinators and their threads. */
	private readonly projects: Projects;
	/** Each agent's terminals, and the last command of every terminal. */
	readonly terminals = new AgentTerminals();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly service: AgentService,
		private readonly diffPreview: DiffPreview,
		private readonly workspaceFiles: WorkspaceFileIndex,
		private readonly enhancer: ChatEnhancer,
	) {
		this.model = new AgentsModel(context.globalState.get<AgentsSnapshot>(storageKey));
		this.transcripts = new TranscriptStore(vscode.Uri.joinPath(context.globalStorageUri, 'agents').fsPath);
		this.checkpointFiles = new CheckpointStore(vscode.Uri.joinPath(context.globalStorageUri, 'checkpoints').fsPath);
		this.tree = new AgentTree(this.model, this.live);
		this.changesView = new ChangesView(id => this.live.get(id)?.changes);
		this.worktrees = new AgentWorktrees(this.model);
		this.merge = new AgentMerge(this.model, this.live, (id, deleteBranch) => this.removeAgentAndWorktree(id, deleteBranch));
		this.projects = new Projects({
			record: id => this.model.agent(id),
			workspaceFolder: id => {
				const record = this.model.agent(id);
				return record && this.model.workspace(record.workspaceId)?.folder;
			},
			threadsOf: id => this.model.threadsOf(id),
			controller: id => this.ensureLive(id)?.controller,
			activity: id => this.live.get(id)?.activity,
			startThread: (id, request, setup) => this.projectAgents.startThread(id, request, setup),
			addRepo: (thread, repo, memory) => this.projectAgents.addThreadRepo(thread, repo, memory),
			open: id => this.open(id),
			stopTurn: id => this.stopTurn(id),
			mergeBack: (id, repo) => this.merge.mergeBack(id, repo),
			changedFiles: id => this.live.get(id)?.changes.files,
			rename: (id, title) => this.renameAgent(id, title),
			trustThreads: async id => {
				const record = this.model.agent(id);
				const folder = record && this.model.workspace(record.workspaceId)?.folder;
				return !!folder && this.projectAgents.ensureProjectTrust(folder, true);
			},
			reloadProjectTools: id => this.projectAgents.reloadProjectTools(id),
			log: message => this.service.writeLog(message),
			sessionServers: id => this.live.get(id)?.session.client.openedMcpServers,
			reopenSession: async id => this.live.get(id)?.session.client.reopen(),
			mcpProblem: name => this.service.mcpProblems.find(problem => problem.server === name && problem.severity === 'error')?.message,
			direct: request => this.direct?.(request) ?? Promise.resolve(undefined),
			openChanges: id => this.openChanges(id),
			undoThread: id => this.projectAgents.undoThread(id),
			resume: id => this.projectAgents.resumeThread(id),
			prepare: id => this.projectAgents.prepareThread(id),
			restoreFolder: id => this.worktrees.restoreFolder(id),
			savedConversation: async id => this.live.get(id)?.controller.conversation ?? (await this.transcripts.load(id)).items,
			cleanUpMerged: id => this.projectAgents.cleanUpMerged(id),
			settingUp: id => this.projectAgents.isSettingUp(id),
			setResolved: (id, resolved) => this.model.setThreadResolved(id, resolved),
		}, String(context.extension.packageJSON.version ?? '0'));
		// What the modules that start, stop and remove agents may ask of this view.
		const host = {
			start: (record: AgentRecord, folder: string) => this.start(record, folder),
			stop: (id: string, save: boolean) => this.stop(id, save),
			open: (id: string) => this.open(id),
			ensureLive: (id: string) => void this.ensureLive(id),
			refresh: (id?: string) => this.refresh(id),
			pickModel: (id: string, model: string) => void this.threadModels.set(id, model),
			removeAgent: (id: string, deleteBranch: boolean) => this.removeAgentAndWorktree(id, deleteBranch),
		};
		this.projectAgents = new AgentProjects(this.model, this.service, this.projects, this.worktrees, this.merge, this.live, this.tree, host);
		this.starts = new AgentStarts(this.model, this.worktrees, this.tree, this.live, host);
		this.forks = new AgentForks(this.model, this.service, this.worktrees, this.live, {
			start: (record, folder) => this.start(record, folder),
			open: id => this.open(id),
			pickModel: (id, model) => void this.threadModels.set(id, model),
			// A forked thread's card merges it as a thread, so it is resolved once merged.
			mergeBack: async id => {
				if (this.model.agent(id)?.project?.role !== 'thread') {
					return this.merge.mergeBack(id);
				}
				await this.projects.mergeThread(id);
				return true;
			},
			linkThreadRules: (repository, folder) => this.projectAgents.linkRules(repository, folder, 'thread'),
			threadForked: (fork, parent, context) => this.projects.threadForked(fork, parent, context),
		});
		this.spare = new SpareSession(this.service, {
			servers: folder => [...this.browser?.spareServers() ?? [], ...this.teamTools?.spareServers() ?? [], ...this.index?.spareServers(folder) ?? []],
			serving: () => [!!this.browser?.serving, !!this.teamTools?.serving, !!this.index?.serving],
		});
		this.review = new ReviewController(() => [...this.live.entries()].map(([id, live]) => ({ id, title: vscode.l10n.t("the agent \"{0}\"", this.model.agent(id)?.title ?? ''), changes: live.changes })));
		this.settler = new CommitSettler(() => [...this.live.values()].map(live => live.changes), message => this.service.writeLog(message));
		this.indicators = new AgentIndicators(context.extensionUri, this.model, this.live, this.tree.view, this.notifier);
		this.disposables.push(
			this.tree,
			this.notifier,
			this.terminals,
			this.changesView,
			this.review,
			this.settler,
			this.worktrees,
			this.onDidChangeAgentsEmitter,
			this.onDidFocusEmitter,
			this.model.onDidChange(() => {
				this.persistSoon();
				this.refresh();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration(`${configSection}.notifications`) || e.affectsConfiguration(`${configSection}.projects.enabled`)) && this.refresh()),
			// Relative times go stale; refresh them only while the pane is visible.
			this.tree.view.onDidChangeVisibility(e => this.setRefreshing(e.visible)),
			// A thread picked with the keyboard is likely opened next: its session starts now, so the chat is ready by then.
			this.tree.view.onDidChangeSelection(e => {
				const node = e.selection[0];
				if (node?.kind === 'agent' && node.record.project?.role === 'thread') {
					this.projectAgents.prepareThread(node.record.id);
				}
			}),
			vscode.commands.registerCommand('gemini.agents.newAgent', (node?: AgentTreeNode) => this.starts.newAgent(node)),
			vscode.commands.registerCommand('gemini.agents.newAgentOnBranch', (node?: AgentTreeNode) => this.starts.newAgent(node, true)),
			vscode.commands.registerCommand('gemini.agents.mergeBack', (node?: AgentTreeNode) => node?.kind === 'agent' && this.merge.mergeBack(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.fork', (node?: AgentTreeNode) => this.fork(node)),
			vscode.commands.registerCommand('gemini.reviewChanges', (source?: { readonly rootUri?: vscode.Uri }) => this.starts.reviewChanges(source)),
			vscode.commands.registerCommand('gemini.agents.addWorkspace', () => this.starts.addWorkspace()),
			// From the keyboard (⌘↓ on a Mac, where Return renames as in Finder) it opens the selected agent.
			vscode.commands.registerCommand('gemini.agents.open', (id?: string) => {
				const selected = this.tree.view.selection[0];
				const target = typeof id === 'string' ? id : selected?.kind === 'agent' ? selected.record.id : undefined;
				return target && this.open(target);
			}),
			vscode.commands.registerCommand('gemini.agents.openTerminal', (node?: AgentTreeNode) => this.openTerminal(node?.kind === 'agent' ? node.record.id : this.activeAgentId())),
			vscode.commands.registerCommand('gemini.agents.openChanges', (node?: AgentTreeNode) => node?.kind === 'agent' && this.openChanges(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.rename', (node?: AgentTreeNode) => this.rename(node)),
			vscode.commands.registerCommand('gemini.agents.openAsMarkdown', (node?: AgentTreeNode) => node?.kind === 'agent' && this.openAsMarkdown(node.record.id)),
			// From the palette or a key: the agent in front.
			vscode.commands.registerCommand('gemini.agents.stop', (node?: AgentTreeNode) => {
				const id = node?.kind === 'agent' ? node.record.id : this.activeAgentId();
				return id && this.stopTurn(id);
			}),
			vscode.commands.registerCommand('gemini.agents.focusChat', () => this.focusChat()),
			vscode.commands.registerCommand('gemini.agents.cycleMode', () => this.chatInFront()?.cycleMode()),
			vscode.commands.registerCommand('gemini.agents.switchModel', () => this.chatInFront()?.pickModel()),
			vscode.commands.registerCommand('gemini.agents.remove', (node?: AgentTreeNode) => this.removeAgent(node)),
			vscode.commands.registerCommand('gemini.agents.removeWorkspace', (node?: AgentTreeNode) => this.removeWorkspace(node)),
			vscode.commands.registerCommand('gemini.projects.new', (node?: AgentTreeNode) => this.projectAgents.newProject(node)),
			// The Projects section's +: the same command, drawn as a plus.
			vscode.commands.registerCommand('gemini.projects.add', (node?: AgentTreeNode) => this.projectAgents.newProject(node)),
			vscode.commands.registerCommand('gemini.projects.newThread', (node?: AgentTreeNode) => node?.kind === 'agent' && this.projects.openNewThread(node.record.id)),
			vscode.commands.registerCommand('gemini.projects.settings', (node?: AgentTreeNode) => node?.kind === 'agent' && this.projects.openSettingsOf(node.record.id)),
			this.projects,
		);
		this.setRefreshing(this.tree.view.visible);
		// A spare session for the first agent, opened once the agent process is up (the warm-up starts it).
		const folder = this.likelyFolder();
		if (folder) {
			this.prepareStart(folder, spareDelayMs);
		}
	}

	/** Opens agent `id`'s conversation as Markdown; one not running in this window is read from its saved file. */
	async openAsMarkdown(id: string): Promise<void> {
		const record = this.model.agent(id);
		const live = this.live.get(id);
		const items = live ? live.controller.conversation : (await this.transcripts.load(id)).items;
		await openChatAsMarkdown(record?.title ?? vscode.l10n.t("Agent"), items, live ? await agentColumn(id, live.panel) : undefined);
	}

	/** An agent's name, for questions about it. */
	agentTitle(id: string): string | undefined {
		return this.model.agent(id)?.title;
	}

	/** The last checks run for agent `id`, in a line; saved with the agent, so they outlast a restart. */
	checkResult(id: string): string | undefined {
		return this.model.agent(id)?.checks?.summary;
	}

	setCheckResult(id: string, summary: string): void {
		this.model.setChecks(id, summary);
	}

	/** The agent whose tab is in front, if any. */
	activeAgentId(): string | undefined {
		for (const [id, agent] of this.live) {
			if (agent.panel?.active) {
				return id;
			}
		}
		return undefined;
	}

	/** The chat of the agent whose tab is in front, else the one last in front. */
	private chatInFront(): ChatController | undefined {
		const id = this.activeAgentId() ?? this.focusedId;
		return id ? this.live.get(id)?.controller : undefined;
	}

	/** Puts the cursor in the message box of the agent in front (or last in front), opening its tab; with no agent yet, starts one. */
	private async focusChat(): Promise<void> {
		const id = this.activeAgentId() ?? (this.focusedId && this.model.agent(this.focusedId) ? this.focusedId : undefined);
		if (!id) {
			await vscode.commands.executeCommand('gemini.agents.newAgent');
			return;
		}
		await this.open(id);
		this.live.get(id)?.controller.focusComposer();
	}

	/** Shows each running chat's branch and chips again, as after a review changed. */
	refreshChats(): void {
		for (const agent of this.live.values()) {
			agent.controller.refreshGit();
		}
	}

	/** Agent `id`'s chat, when the agent runs in this window. */
	controllerOf(id: string): ChatController | undefined {
		return this.live.get(id)?.controller;
	}

	/**
	 * The chat that Add to Chat and the chat commands act on: the agent tab in
	 * front, else the running agent used last (shown), else, with `orNew`, a
	 * new agent the user starts. Undefined when there is none.
	 */
	async chatFor(orNew: boolean): Promise<ChatController | undefined> {
		const front = this.activeController();
		if (front) {
			return front;
		}
		const running = this.summaries().find(agent => agent.state !== 'stopped' && agent.project?.role !== 'coordinator');
		if (running) {
			await this.open(running.id);
			return this.controllerOf(running.id);
		}
		if (!orNew) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
			return undefined;
		}
		const started = await this.starts.newAgent(undefined);
		return started ? this.controllerOf(started) : undefined;
	}

	/** The chat in the agent tab that is in front, if any. */
	activeController(): ChatController | undefined {
		for (const agent of this.live.values()) {
			if (agent.panel?.active) {
				return agent.controller;
			}
		}
		return undefined;
	}

	/** Every agent, newest first. */
	summaries(): AgentSummary[] {
		const summaries: AgentSummary[] = [];
		const projects = projectsEnabled();
		for (const workspace of this.model.workspaces) {
			for (const record of this.model.agentsIn(workspace.id)) {
				const live = this.live.get(record.id);
				const state = agentState(live);
				const changes = live?.changes.totals ?? record.changes;
				summaries.push({
					id: record.id, title: record.title, folder: workspace.folder, state: state.kind, status: state.status,
					...(changes?.files ? { changes } : {}), ...(record.worktree ? { worktree: record.worktree } : {}), updatedAt: record.updatedAt,
					...(projects && record.project?.role === 'coordinator' ? { project: { role: 'coordinator', threads: this.model.threadsOf(record.id).length } } : {}),
					...(projects && record.project?.role === 'thread' && this.model.coordinatorOf(record) ? { project: { role: 'thread' } } : {}),
				});
			}
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** The workspaces a new agent can start in: the open folders first. */
	workspaces(): Promise<WorkspaceSummary[]> {
		return this.tree.workspaces();
	}

	/** Keeps a spare session open in `folder` for the next agent started there, such as while the user types a task on Agent Home. */
	prepareStart(folder: string, delayMs = 0): void {
		this.spare.prepare(folder, delayMs);
	}

	/** Opens the spare session again when the servers a new session would get change. */
	refreshSpare(): void {
		this.spare.refresh();
	}

	/** Starts an agent in `folder` (on its own branch, named after the prompt, with `ownBranch`) and sends it `text`. */
	/** Returns whether the agent started; when not, the user has been told why. */
	startWithPrompt(folder: string, text: string, ownBranch: boolean, mode: string, attachments: readonly Attachment[]): Promise<boolean> {
		return this.starts.startWithPrompt(folder, text, ownBranch, mode, attachments);
	}

	/** Starts an agent for the team flows, named `title`; resolves with its id, or undefined when its branch could not be made. */
	startTeamAgent(options: { readonly folder: string; readonly title: string; readonly text: string; readonly branch?: string; readonly worktree?: AgentWorktree; readonly mode?: string }): Promise<string | undefined> {
		return this.starts.startTeamAgent(options);
	}

	/** Where an agent works (its worktree's folder, or its workspace), and its own branch when it has one. */
	agentPlace(id: string): { readonly folder: string; readonly cwd: string; readonly branch?: string; readonly title: string } | undefined {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		return record && workspace ? { folder: workspace.folder, cwd: agentFolder(record, workspace.folder), title: record.title, ...(record.worktree ? { branch: record.worktree.branch } : {}) } : undefined;
	}

	/** The browser's New Agent: asks where and how the agent works, then starts it with its tab open. */
	newAgentFor(page: string): Promise<{ readonly id: string; readonly title: string; readonly task?: string } | undefined> {
		return this.starts.newAgentFor(page);
	}

	/** "Review my changes": starts an agent in Plan mode with the repository's uncommitted diff attached. */
	reviewChanges(source?: { readonly rootUri?: vscode.Uri }): Promise<void> {
		return this.starts.reviewChanges(source);
	}

	/** Merges an agent's branch into the branch its workspace has checked out; returns whether all of its work is now merged. */
	mergeBack(id: string, repo?: string): Promise<boolean> {
		return this.merge.mergeBack(id, repo);
	}

	/** Stops the agent's current turn. */
	stopTurn(id: string): void {
		void this.live.get(id)?.session.cancel();
	}

	/**
	 * Every tool call, edit and status change asks for a refresh; doing them
	 * together once per frame keeps a busy turn from redrawing the tree,
	 * Home, the title bar and the tabs dozens of times.
	 */
	private refresh(agentId?: string): void {
		if (agentId === undefined) {
			this.refreshAll = true;
		} else {
			this.refreshRows.add(agentId);
		}
		this.refreshTimeout ??= setTimeout(() => {
			this.refreshTimeout = undefined;
			this.refreshNow();
		}, 16);
	}

	/** Saving the agent list goes to the main process; once a second is plenty. */
	private persistSoon(): void {
		this.persistTimeout ??= setTimeout(() => this.persist(), 1000);
	}

	private persist(): Thenable<void> {
		clearTimeout(this.persistTimeout);
		this.persistTimeout = undefined;
		return this.context.globalState.update(storageKey, this.model.snapshot());
	}

	private refreshNow(): void {
		const rows = this.refreshAll ? undefined : [...this.refreshRows];
		this.refreshAll = false;
		this.refreshRows.clear();
		this.tree.redraw(rows);
		this.tree.updateClock();
		this.indicators.updateBadge();
		this.indicators.updateTitleBar(this.summaries());
		this.indicators.updateTabs();
		this.onDidChangeAgentsEmitter.fire();
	}

	private setRefreshing(visible: boolean): void {
		if (visible && !this.refreshTimer) {
			this.refreshTimer = setInterval(() => this.refresh(), 60_000);
		} else if (!visible && this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.tree.updateClock();
	}

	/** Where the next agent most likely starts: where the last one did, else the first open folder. */
	private likelyFolder(): string | undefined {
		const last = [...this.model.snapshot().agents].filter(a => !a.worktree).sort((a, b) => b.createdAt - a.createdAt)[0];
		const folder = last && this.model.workspace(last.workspaceId)?.folder;
		return folder ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
	}

	/** Removes the agent, its worktree folder and, with `deleteBranch`, its branch. */
	private async removeAgentAndWorktree(id: string, deleteBranch: boolean): Promise<void> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		this.stop(id, false);
		if (record) {
			this.forkGone(record);
			this.projects.threadRemoved(record);
		}
		this.model.removeAgent(id);
		void this.transcripts.delete(id);
		void this.checkpointFiles.delete(id);
		this.browser?.closeAgent(id);
		this.terminals.closeAgent(id);
		this.teamTools?.forgetAgent(id);
		this.index?.forgetAgent(id);
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
			void this.index?.remove(record.worktree.cwd).catch(() => undefined);
		}
	}

	/** Opens the agent's tab, starting its session if it has none in this window. */
	async open(id: string): Promise<void> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		if (!record || !workspace) {
			return;
		}
		let live = this.live.get(id);
		if (!live) {
			const folder = agentFolder(record, workspace.folder);
			// A merged thread's folder may have been cleaned up: it comes back from its branch.
			if (record.worktree && !await this.worktrees.restoreFolder(id)) {
				void vscode.window.showErrorMessage(vscode.l10n.t("The folder of \"{0}\"'s branch, {1}, no longer exists.", record.title, tildify(record.worktree.folder)));
				return;
			}
			if (record.project && projectsEnabled()) {
				// Its session gets the project's tools, so their server must listen first, in a folder the CLI trusts.
				await this.projects.ready();
				const coordinatorId = record.project.role === 'coordinator' ? record.id : record.project.coordinator;
				await this.projectAgents.ensureProjectTrust(workspace.folder, !!record.repos?.length || await savedRepoCount(coordinatorHome(coordinatorId)) > 1);
				if (record.project.role === 'coordinator') {
					await this.projectAgents.linkRules(workspace.folder, coordinatorHome(record.id), 'coordinator');
				}
			}
			live = this.live.get(id) ?? this.startSaved(record, folder);
		}
		live.unread = false;
		this.notifier.clear(id);
		// Beside the other agents, never in one agent's side group.
		const viewColumn = live.panel ? undefined : await agentsColumn();
		if (live.panel) {
			live.panel.reveal();
		} else {
			const panel = vscode.window.createWebviewPanel(agentPanelType, record.title, viewColumn ?? vscode.ViewColumn.Active, {
				enableScripts: true,
				// Switching tabs then costs no re-render of a long conversation.
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			});
			panel.iconPath = this.indicators.tabIcon(id, this.indicators.restingTabIcon(id));
			live.panel = panel;
			// A disposed panel throws on `.webview`, so keep the webview for detaching.
			const webview = panel.webview;
			live.controller.attach(webview);
			panel.onDidChangeViewState(e => {
				live.controller.setHidden(!e.webviewPanel.visible);
				if (e.webviewPanel.active) {
					this.focus(id);
					this.tree.revealAgent(id);
					this.notifier.clear(id);
					// Switching to an agent or thread puts the cursor where the user types.
					live.controller.focusComposer();
				}
				if (e.webviewPanel.active && live.unread) {
					live.unread = false;
					this.refresh(id);
				}
			});
			panel.onDidDispose(() => {
				if (live.panel === panel) {
					live.panel = undefined;
					live.tabIcon = undefined;
				}
				// A reopened tab is a new editor without the description, so send the tabs again.
				this.indicators.tabClosed();
				live.controller.detach(webview);
				// Closing the tab or removing the agent closes its files; quitting keeps them for next time.
				if (!this.disposing) {
					closeAgentFiles(id);
				}
			});
		}
		this.focus(id);
		this.refresh();
	}

	/** Starts an agent's session in this window, showing its saved chat first. */
	private startSaved(record: AgentRecord, folder: string): LiveAgent {
		// A saved chat shows first; its session reopens, replaying the whole history, once it is on screen.
		const saved = record.updatedAt !== record.createdAt;
		const live = this.start(record, folder, saved && !!record.sessionId);
		if (saved) {
			// Read while the tab opens; the agent reopens its session meanwhile.
			const restored = Promise.all([this.transcripts.load(record.id), this.checkpointFiles.load(record.id)]).then(([stored, checkpoints]) => {
				// The agent may have been stopped while the file was read.
				if (this.live.get(record.id) !== live) {
					return;
				}
				live.controller.restore(stored.items, record.sessionId);
				live.controller.restoreCheckpoints(checkpoints);
				live.changes.restore(stored.changes);
			});
			// A prompt sent meanwhile, such as a note from the coordinator, waits: sent first, it would keep the saved chat from showing, and the next save would drop it.
			live.controller.holdPrompts(restored);
		}
		return live;
	}

	/** An agent's live chat, started without a tab when it has none in this window; for a project's threads. */
	private ensureLive(id: string): LiveAgent | undefined {
		const live = this.live.get(id);
		const record = this.model.agent(id);
		const folder = record && this.model.folderOf(record);
		if (live || !record || !folder) {
			return live;
		}
		const started = this.startSaved(record, folder);
		// Reopened without a tab, its session opens now rather than when shown.
		started.session.open();
		return started;
	}

	/** Opens the agent's changes in the multi-diff editor, starting it to read them if needed. */
	async openChanges(id: string): Promise<void> {
		// The agent's tab in front first: its changes go in its own side group, which shows only with it, so never beside Home.
		await this.open(id);
		const source = this.changesSource(id);
		if (source) {
			await this.changesView.openAll(source);
		}
	}

	private focus(id: string): void {
		this.focusedId = id;
		const source = this.changesSource(id);
		this.changesView.show(source);
		this.onDidFocusEmitter.fire(source);
	}

	/** The agent whose changes show: the one whose tab was last in front. */
	get focusedSource(): ChangesSource | undefined {
		return this.focusedId ? this.changesSource(this.focusedId) : undefined;
	}

	private changesSource(id: string): ChangesSource | undefined {
		const live = this.live.get(id);
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		return live && workspace ? {
			agentId: id, title: record.title, folder: agentFolder(record, workspace.folder), changes: live.changes,
			editorColumn: () => agentColumn(id, live.panel),
			focusEditors: async () => { await agentColumn(id, live.panel, true); },
			busy: () => live.activity.busy,
			...(record.worktree ? { branch: record.worktree.branch, mergeBack: async () => { await this.merge.mergeBack(id); } } : { commit: () => live.controller.commit() }),
		} : undefined;
	}

	/** A coordinator runs on the model picked in its chat, else Flash; a thread on the model picked for it, once; others on the user's choice. */
	private preferredModel(record: AgentRecord): ((available: readonly SessionChoice[]) => string | undefined) | undefined {
		const picked = this.threadModels.get(record.id);
		if (picked) {
			this.threadModels.delete(record.id);
			return available => available.some(choice => choice.id === picked) ? picked : sessionModel(available);
		}
		if (projectsEnabled() && record.project?.role === 'coordinator') {
			return available => {
				const project = this.model.agent(record.id)?.project;
				const picked = project?.role === 'coordinator' ? project.model : undefined;
				return picked && available.some(choice => choice.id === picked) ? picked : coordinatorModel(available.map(choice => choice.id));
			};
		}
		return undefined;
	}

	private start(record: AgentRecord, folder: string, openLater = false): LiveAgent {
		const project = projectsEnabled() ? record.project : undefined;
		// A coordinator's session runs in its own empty folder (coordinatorHome); its chat still belongs to the workspace.
		const cwd = project?.role === 'coordinator' ? coordinatorHome(record.id) : folder;
		// An agent's worktree starts from a copy of its workspace's index; a coordinator has no code to index.
		const indexServers = () => cwd === folder ? this.index?.mcpServersFor(record.id, folder, record.worktree ? this.model.workspace(record.workspaceId)?.folder : undefined) ?? [] : [];
		const servers = () => [...this.browser?.mcpServersFor(record.id, folder) ?? [], ...this.teamTools?.mcpServersFor(record.id, folder) ?? [], ...indexServers(), ...project ? this.projects.mcpServersFor(this.model.agent(record.id) ?? record) : []];
		const session = new AgentSession(this.service, cwd, record.sessionId, servers, openLater, {
			// A project agent's session needs the project's server, which a spare never has, listening before it opens:
			// a session opened without it, as from a restored tab or a thread warmed at project open, never gets the tools.
			// A coordinator's own folder has to exist before its session opens there.
			...(project ? { beforeOpen: async () => { if (cwd !== folder) { await fs.promises.mkdir(cwd, { recursive: true }); } await this.projects.ready(); } } : { spareKey: () => this.spare.key(folder) }),
			onDidOpenSession: servers => {
				this.browser?.bindSession(record.id, folder, servers);
				this.teamTools?.bindSession(record.id, folder, servers);
				this.index?.bindSession(record.id, folder, servers);
				// Refill, for the next agent, which most likely starts in the same folder; not in an agent's own worktree.
				if (!this.model.agent(record.id)?.worktree) {
					this.prepareStart(folder, spareDelayMs);
				}
			},
		}, this.preferredModel(record));
		session.permissions.confirmOnly = request => !!this.teamTools?.isConfirmCall(request);
		session.permissions.answerAtOnce = request => (project ? this.projects.instantAnswer(this.model.agent(record.id) ?? record, request) : undefined)
			?? this.teamTools?.instantAnswer(request);
		// A folder outside the window lists its files from its index once that is built, else from git.
		const files: FileSearch = isOpenFolder(folder) ? this.workspaceFiles : new FolderFileIndex(folder, undefined, () => this.index?.files(folder) ?? Promise.resolve(undefined));
		const changes = new AgentChanges(folder);
		const workspace = (): ChatWorkspace | undefined => {
			const workspace = this.model.workspace(record.workspaceId);
			const current = this.model.agent(record.id) ?? record;
			// A coordinator of a project with several repositories shows each; a thread across them, its worktree of each.
			const threadRepos = current.repos?.filter(repo => !repo.merged).map(repo => ({ name: repo.key, folder: repo.cwd }));
			const repos = current.project?.role === 'coordinator' && projectsEnabled() ? this.projects.repoFolders(current.id) : threadRepos && threadRepos.length > 1 ? threadRepos : undefined;
			return workspace && { folder: workspace.folder, cwd: folder, worktree: !!current.worktree, ...(repos ? { repos } : {}) };
		};
		const live: LiveAgent = {
			session,
			changes,
			controller: new ChatController(this.context.extensionUri, session, this.diffPreview, files, {
				reveal: preserveFocus => this.reveal(record.id, preserveFocus),
				isShown: () => this.live.get(record.id)?.panel?.visible === true,
				onDidPickModel: modelId => this.model.setCoordinatorModel(record.id, modelId),
				editorColumn: () => agentColumn(record.id, this.live.get(record.id)?.panel),
				enhancer: this.enhancer,
				indexContext: draft => this.index?.contextFor(folder, draft) ?? Promise.resolve(undefined),
				// Not for a coordinator, which runs in an empty folder without the index.
				indexHint: () => cwd === folder ? this.index?.hint(folder) : undefined,
				usage: () => this.usage,
				toolChips: () => this.teamTools && toolChipsFor(this.teamTools),
				review: () => this.reviewChip?.(record.id),
				openReview: () => this.openReview?.(record.id),
				openMergeRequest: () => void vscode.commands.executeCommand('gemini.team.openMergeRequest', record.id),
				title: () => this.model.agent(record.id)?.title ?? record.title,
				// A coordinator splits work into threads instead; a thread's fork is a new thread (Fork Thread).
				...(record.project?.role === 'coordinator' ? {} : { fork: this.forks.forkerFor(record.id) }),
				...(project?.role === 'coordinator' ? { project: this.projects.chatProject(record.id) } : {}),
				...(project?.role === 'thread' ? {
					parentProject: {
						name: () => this.model.agent(project.coordinator)?.title ?? '',
						open: () => void this.open(project.coordinator),
					},
				} : {}),
				savedSessions: {
					inUse: () => new Set(this.model.snapshot().agents.flatMap(a => a.id !== record.id && a.sessionId ? [a.sessionId] : [])),
				},
				saveCheckpoints: stored => void this.checkpointFiles.save(record.id, stored),
				sharedPage: {
					current: () => this.browser?.sharedPage(record.id) ?? Promise.resolve(undefined),
					stop: () => this.browser?.stopSharing(record.id) ?? Promise.resolve(),
					reveal: () => this.browser?.revealSharedPage(record.id) ?? Promise.resolve(false),
				},
				workspace,
				terminal: this.chatTerminal(record.id, workspace, project?.role === 'coordinator'),
				git: {
					folder: () => folder,
					// An agent on its own branch commits there with Merge Back, not from the chat.
					...(record.worktree ? { ownBranch: record.worktree.branch } : {
						commit: {
							files: () => changes.files.map(file => file.path),
							onDidChange: listener => changes.onDidChange(listener),
							suggestion: () => {
								const title = this.model.agent(record.id)?.title ?? record.title;
								return { branch: branchNameFrom(title), message: title };
							},
							// Committed changes are no longer the agent's to review.
							committed: () => changes.clear(),
						},
					}),
				},
			}),
			unread: false,
			activity: { busy: false, needsPermission: false },
			disposables: [],
		};
		live.disposables.push(
			live.controller.onDidChangeActivity(activity => {
				if (live.activity.busy && !activity.busy && !live.panel?.active) {
					live.unread = true;
				}
				const change = attentionChange(live.activity, activity);
				if (change) {
					this.notifier.notify(record.id, change, this.model.agent(record.id)?.title ?? record.title, () => void this.open(record.id));
				}
				if (!activity.busy) {
					this.scheduleSave(record.id, live);
					if (live.activity.busy) {
						this.index?.agentTurnEnded(folder);
					}
				}
				const before = live.activity;
				live.activity = activity;
				if (project) {
					this.projects.threadActivity(this.model.agent(record.id) ?? record, before, activity);
				}
				this.refresh(record.id);
			}),
			session.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.model.setSessionId(record.id, state.savedSessionId);
				}
			}),
			live.controller.onDidEditFiles(diffs => {
				changes.record(diffs);
				this.index?.agentEdited(folder, diffs.map(diff => diff.path));
			}),
			changes.onDidChange(() => {
				this.review.refreshSoon();
				this.settler.update();
				this.model.setChanges(record.id, changes.totals);
				if (project) {
					this.projects.threadChanged(this.model.agent(record.id) ?? record);
				}
				this.scheduleSave(record.id, live);
				this.refresh();
			}),
			live.controller.onDidRestoreSession(title => {
				this.model.recordRestore(record.id, title);
				const name = this.model.agent(record.id)?.title;
				if (live.panel && name) {
					live.panel.title = name;
				}
				this.scheduleSave(record.id, live);
			}),
			live.controller.onDidSendPrompt(text => {
				this.model.recordPrompt(record.id, text);
				const title = this.model.agent(record.id)?.title;
				if (live.panel && title) {
					live.panel.title = title;
				}
			}),
			session.onDidChangeStatus(() => this.refresh(record.id)),
		);
		this.live.set(record.id, live);
		if (project) {
			this.projects.attach(record);
		}
		return live;
	}

	/**
	 * Run on the agent's replies: its folder, or each repository of a thread or
	 * project, in the agent's own terminals. A coordinator's Run always asks:
	 * its repositories are the user's own checkouts.
	 */
	private chatTerminal(id: string, workspace: () => ChatWorkspace | undefined, coordinator: boolean): ChatTerminal {
		const several = () => (workspace()?.repos?.length ?? 0) > 1;
		return {
			places: () => {
				const current = workspace();
				return current?.repos?.length ? current.repos : current ? [{ name: path.basename(current.cwd), folder: current.cwd }] : [];
			},
			alwaysAsk: coordinator,
			run: (place, command, fresh) => this.terminals.run(id, this.terminalName(id, place.name, several()), place.folder, command, fresh),
			insert: (place, command) => this.terminals.insert(id, this.terminalName(id, place.name, several()), place.folder, command),
		};
	}

	/** An agent's terminal: "fix-login · Gemini", or "thread · api" for one of its several repositories. */
	private terminalName(id: string, place: string, several: boolean): string {
		const title = this.model.agent(id)?.title ?? vscode.l10n.t("Agent");
		return several ? vscode.l10n.t("{0} \u00b7 {1}", title, place) : vscode.l10n.t("{0} \u00b7 Gemini", title);
	}

	/** Open Terminal: the agent's terminal in its folder, or in each of a thread's repositories. */
	private openTerminal(id: string | undefined): void {
		const record = id ? this.model.agent(id) : undefined;
		const workspace = record && this.model.workspace(record.workspaceId);
		if (!id || !record || !workspace) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
			return;
		}
		const repos = record.repos?.filter(repo => !repo.merged);
		const folder = agentFolder(record, workspace.folder);
		const places = repos && repos.length > 1 ? repos.map(repo => ({ name: repo.key, folder: repo.cwd })) : [{ name: path.basename(folder), folder }];
		for (const place of places) {
			this.terminals.open(id, this.terminalName(id, place.name, places.length > 1), place.folder);
		}
	}

	private scheduleSave(id: string, live: LiveAgent): void {
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

	private async reveal(id: string, preserveFocus: boolean): Promise<void> {
		const live = this.live.get(id);
		if (live?.panel) {
			live.panel.reveal(undefined, preserveFocus);
		} else {
			await this.open(id);
		}
	}

	private async rename(node: AgentTreeNode | undefined): Promise<void> {
		node ??= this.tree.view.selection[0];
		if (node?.kind !== 'agent') {
			return;
		}
		const title = await vscode.window.showInputBox({ title: vscode.l10n.t("Rename Agent"), value: node.record.title, validateInput: v => v.trim() ? undefined : vscode.l10n.t("Enter a name.") });
		if (title?.trim()) {
			this.renameAgent(node.record.id, title.trim());
		}
	}

	private renameAgent(id: string, title: string): void {
		this.model.rename(id, title);
		const panel = this.live.get(id)?.panel;
		if (panel) {
			panel.title = title;
		}
		if (this.focusedId === id) {
			this.focus(id);
		}
	}

	/** Fork Agent, from the agent's row or the Command Palette: the Fork dialog opens in the agent's chat. */
	private async fork(node: AgentTreeNode | undefined): Promise<void> {
		const selected = node ?? this.tree.view.selection[0];
		const id = selected?.kind === 'agent' ? selected.record.id : this.activeAgentId();
		const record = id ? this.model.agent(id) : undefined;
		if (!id || !record) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Select an agent to fork."));
			return;
		}
		if (record.project?.role === 'coordinator') {
			void vscode.window.showInformationMessage(vscode.l10n.t("A project chat can't be forked: fork one of its threads, or start a new thread from the project chat."));
			return;
		}
		await this.open(id);
		await this.live.get(id)?.controller.openFork();
	}

	/** The fork's card in its parent's chat says it was removed. */
	private forkGone(record: AgentRecord): void {
		const parent = this.model.parentOf(record);
		if (parent) {
			this.live.get(parent.id)?.controller.forkRemoved(record.id);
		}
	}

	private async removeAgent(node: AgentTreeNode | undefined): Promise<void> {
		node ??= this.tree.view.selection[0];
		if (node?.kind !== 'agent') {
			return;
		}
		// Its forks go too, or stay as agents of their own, as the user says.
		const forks = this.model.forksOf(node.record.id);
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
					const folder = this.model.folderOf(fork);
					if (folder) {
						await this.removeAgent({ kind: 'agent', record: fork, folder });
					}
				}
			}
		}
		const remove = vscode.l10n.t("Remove");
		const worktree = this.model.agent(node.record.id)?.worktree;
		if (worktree) {
			await this.removeWorktreeAgent(node.record, worktree);
			return;
		}
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove the agent \"{0}\"? Its conversation is closed.", node.record.title), { modal: true }, remove);
		if (answer === remove) {
			this.stop(node.record.id, false);
			this.forkGone(node.record);
			this.projects.threadRemoved(node.record);
			this.model.removeAgent(node.record.id);
			void this.transcripts.delete(node.record.id);
			void this.checkpointFiles.delete(node.record.id);
			this.browser?.closeAgent(node.record.id);
			this.terminals.closeAgent(node.record.id);
			this.teamTools?.forgetAgent(node.record.id);
			this.index?.forgetAgent(node.record.id);
		}
	}

	private async removeWorktreeAgent(record: AgentRecord, worktree: AgentWorktree): Promise<void> {
		const workspace = this.model.workspace(record.workspaceId);
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
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove the agent \"{0}\" and its folder?", record.title), { modal: true, detail }, deleteBranch, keepBranch);
		if (answer) {
			await this.removeAgentAndWorktree(record.id, answer === deleteBranch);
		}
	}

	private async removeWorkspace(node: AgentTreeNode | undefined): Promise<void> {
		if (node?.kind !== 'workspace' || !node.record) {
			return;
		}
		const remove = vscode.l10n.t("Remove");
		const count = this.model.agentsIn(node.record.id).length;
		const message = count
			? vscode.l10n.t("Remove {0} and its {1} agents from the list? The folder itself is not changed.", path.basename(node.folder), count)
			: vscode.l10n.t("Remove {0} from the list? The folder itself is not changed.", path.basename(node.folder));
		const branches = this.model.agentsIn(node.record.id).filter(a => a.worktree).length;
		const detail = branches ? vscode.l10n.t("Agents on their own branches keep their branches and folders in ~/.geminicode/worktrees. To delete those, remove the agents first.") : undefined;
		if (await vscode.window.showWarningMessage(message, { modal: true, detail }, remove) === remove) {
			for (const agent of this.model.removeWorkspace(node.record.id)) {
				this.stop(agent.id, false);
				void this.transcripts.delete(agent.id);
				void this.checkpointFiles.delete(agent.id);
				this.browser?.closeAgent(agent.id);
				this.terminals.closeAgent(agent.id);
				this.teamTools?.forgetAgent(agent.id);
				this.index?.forgetAgent(agent.id);
			}
		}
	}

	/** Ends the agent's session in this window and closes its tab; with `save`, keeps its conversation for later. */
	private stop(id: string, save: boolean): void {
		const live = this.live.get(id);
		if (!live) {
			return;
		}
		this.live.delete(id);
		this.projects.detach(id);
		this.notifier.clear(id);
		// Saved already unless a save is pending or a turn runs.
		if (save && (live.saveTimer !== undefined || live.activity.busy)) {
			void this.transcripts.save(id, { items: live.controller.conversation, changes: live.changes.files });
		}
		clearTimeout(live.saveTimer);
		if (this.focusedId === id) {
			this.focusedId = undefined;
			this.changesView.show(undefined);
			this.onDidFocusEmitter.fire(undefined);
		}
		live.panel?.dispose();
		void live.session.cancel();
		vscode.Disposable.from(...live.disposables).dispose();
		live.controller.dispose();
		live.changes.dispose();
		live.session.dispose();
		this.review.refresh();
		this.settler.update();
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
		await Promise.all([this.transcripts.flush(), list]);
	}

	dispose(): void {
		this.disposing = true;
		for (const id of [...this.live.keys()]) {
			this.stop(id, true);
		}
		this.setRefreshing(false);
		this.spare.dispose();
		clearTimeout(this.refreshTimeout);
		if (this.persistTimeout) {
			void this.persist();
		}
		this.model.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

function isOpenFolder(folder: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === folder);
}

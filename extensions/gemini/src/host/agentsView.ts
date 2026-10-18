/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, ChangeTotals, formatCounts } from '../acp/agentChanges';
import { agentRowMeta } from '../acp/agentRow';
import { attentionChange, waitingCount } from '../acp/attention';
import { branchNameFrom, isValidBranchName } from '../acp/branchNames';
import { AgentRecord, AgentsModel, AgentsSnapshot, isArchived, ThreadRepo, WorkspaceRecord } from '../acp/agents';
import { coordinatorModel, threadMemoryContext, threadPrompt, type ThreadRequest } from '../acp/projectHub';
import { savedRepoCount, type ProjectRepo } from '../acp/projectStore';
import { linkCoordinatorRules, linkThreadRules, ruleEntries, ruleFolders } from '../acp/projectRules';
import type { Attachment } from '../acp/attachments';
import { FolderFileIndex } from '../acp/folderFiles';
import { readGitHead } from '../acp/gitHead';
import { errorMessage } from '../acp/errors';
import { memoizeAsync } from '../acp/memoize';
import { reviewRequest, workingChanges } from '../acp/reviewPrompt';
import type { SessionChoice } from '../acp/sessionSettings';
import { TranscriptStore } from '../acp/transcriptStore';
import { CheckpointStore } from '../acp/checkpointStore';
import { folderTrustApplies, isFolderTrusted, trustedFoldersPath } from '../acp/trustedFolders';
import { AgentWorktree, allThreadsHome, branchExists, commitAll, coordinatorHome, createWorktree, createWorktreeAt, currentBranch, folderInRepository, folderSize, freeFolder, mergeBranch, removeWorktree, repositoryRoot, restoreWorktree, runWorktreeSetup, threadGuide, threadsHome, worktreeSetupCommand, projectsHome, worktreesHome, worktreeStatus, writeThreadGuide } from '../acp/worktrees';
import { supportedMcpServers } from '../acp/agentClient';
import { AgentNotifier } from './agentNotifier';
import { AgentService } from './agentService';
import { AgentSession } from './agentSession';
import { ChangesSource, ChangesView } from './changesView';
import type { AgentStateKind, HomeMode } from './panelProtocol';
import { ReviewController } from './reviewController';
import type { BrowserTools } from './browserTools';
import type { TeamConnections } from './teamConnections';
import { toolChipsFor } from './toolChips';
import { jiraKeyIn } from '../acp/jira';
import { ChatActivity, ChatController, ChatEnhancer, FileSearch, openChatAsMarkdown } from './chatController';
import { configSection, getApprovalPolicy } from './configuration';
import { formatBytes, relativeTime, tildify } from './displayText';
import { Projects, projectsEnabled, type ThreadSetup } from './projects';
export { relativeTime } from './displayText';
import { DiffPreview } from './diffPreview';
import { agentColumn, agentsColumn, closeAgentFiles } from './editorPlacement';
import { escapeMarkdown } from './markdown';
import { isModeAllowed } from '../acp/adminPolicy';
import { knownModelList, sessionModel, sessionModelList } from './modelPreference';
import type { UsageMeter } from './usageMeter';
import { WorkspaceFileIndex } from './workspaceFiles';

const agentsViewId = 'gemini.agents';
const agentPanelType = 'gemini.agent';
/** How long after the agent is ready, or a spare was taken, to open the next spare: out of the way of the start itself. */
const spareDelayMs = 1500;
const storageKey = 'gemini.agents';
/** Agent tab icons end in #gemini-agent=<id>; GeminiCode's workbench matches tabs on it (gemini.contribution.ts). */
const agentTabFragment = 'gemini-agent=';

/** A workspace row: one the user added, or a folder open in this window. */
interface WorkspaceNode {
	readonly kind: 'workspace';
	readonly folder: string;
	/** Unset for an open folder that has no agents yet. */
	readonly record?: WorkspaceRecord;
	readonly current: boolean;
}

interface AgentNode {
	readonly kind: 'agent';
	readonly record: AgentRecord;
	readonly folder: string;
}

/** The list's two sections: projects (with Projects on) and agents, each with its own +. */
interface SectionNode {
	readonly kind: 'section';
	readonly section: 'projects' | 'agents';
}

/** What an empty section says, in place of its rows. */
interface MessageNode {
	readonly kind: 'message';
	readonly section: 'projects' | 'agents';
}

/** A blank row that keeps the two sections apart. */
interface GapNode {
	readonly kind: 'gap';
}

/** A project's threads merged over a week ago, collapsed under one row so a long-running project's list stays short. */
interface ArchiveNode {
	readonly kind: 'archive';
	readonly coordinator: AgentRecord;
	readonly folder: string;
	readonly count: number;
}

type Node = SectionNode | MessageNode | GapNode | WorkspaceNode | AgentNode | ArchiveNode;

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

/** A workspace agents can start in. */
export interface WorkspaceSummary {
	readonly folder: string;
	/** In a Git repository, so an agent can have its own branch. */
	readonly git: boolean;
	/** Open in this window. */
	readonly current: boolean;
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
 */
export class AgentsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {

	private readonly model: AgentsModel;
	/** Each agent's conversation as shown, so its tab looks the same after a reload. */
	private readonly transcripts: TranscriptStore;
	/** Each agent's checkpoints, for Undo and Rewind after a reload. */
	private readonly checkpointFiles: CheckpointStore;
	private readonly live = new Map<string, LiveAgent>();
	/** Agents being merged back, so a second Merge waits for the first. */
	private readonly merging = new Set<string>();
	/** Threads whose worktree setup still runs; they get their brief when it ends. */
	private readonly settingUp = new Set<string>();
	/** Threads whose cleaned-up folders are being put back, so two callers share one `git worktree add`. */
	private readonly restoringFolders = new Map<string, Promise<boolean>>();
	/** The last worktree being added in each repository, so threads started together take turns. */
	private readonly worktreeQueue = new Map<string, Promise<void>>();
	/** The model an agent's first session starts on, picked in the New thread dialog or the browser's New Agent. */
	private readonly threadModels = new Map<string, string>();
	private readonly changesView: ChangesView;
	/** Keep and Undo on each agent change, in the files themselves. */
	readonly review: ReviewController;
	/** The agent whose tab was last in front; the Changes view shows it. */
	private focusedId: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly tree: vscode.TreeView<Node>;
	private readonly notifier = new AgentNotifier();
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	/** Ticks working agents' clocks once a second while the pane shows one. */
	private clockTimer: ReturnType<typeof setInterval> | undefined;
	/** Set while the extension shuts down, when closing agent tabs must not close their files. */
	private disposing = false;
	/** The agent rows last handed to the tree, so a clock tick redraws just those rows. */
	private readonly agentNodes = new Map<string, AgentNode>();
	/** Output of worktree setup scripts, made the first time one runs. */
	private setupOutput: vscode.OutputChannel | undefined;
	/** Branch names are read from `.git/HEAD`; kept for a few seconds so a refresh reads each folder once. */
	private readonly branchOf = memoizeAsync(readGitHead, { ttlMs: 5_000, maxEntries: 100 });

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	/** Agents, their states or their workspaces changed. */
	private readonly onDidChangeAgentsEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeAgents = this.onDidChangeAgentsEmitter.event;
	/** The agent whose changes show changed; Agents mode's Changes panel follows it. */
	private readonly onDidFocusEmitter = new vscode.EventEmitter<ChangesSource | undefined>();
	readonly onDidFocus = this.onDidFocusEmitter.event;
	/** The pills last sent to the title bar, to send only changes. */
	private lastStatus = '';
	private lastTabs = '';
	private refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	/** What the pending refresh redraws: the whole tree, or just these agents' rows. */
	private refreshAll = false;
	private readonly refreshRows = new Set<string>();
	/** Each agent's page in the GeminiCode browser; set once the extension has made it. */
	browser: BrowserTools | undefined;
	/** The team's tools (Jira, GitLab, SonarQube, Snyk, Figma), for every agent's session; set by activate. */
	teamTools: TeamConnections | undefined;
	/** Today's quota, for the chats' usage popover. */
	usage: UsageMeter | undefined;
	/** One direct request to the quick model, for drafting a project's memory; set once the extension has made it. */
	direct: ((request: { readonly system: string; readonly prompt: string }) => Promise<string | undefined>) | undefined;
	private persistTimeout: ReturnType<typeof setTimeout> | undefined;
	/** Projects (preview): coordinators and their threads. */
	private readonly projects: Projects;
	/** The folder the spare session is kept for, and the wait for the agent to be ready to open it. */
	private spare: { folder: string; waiting?: { dispose(): void }; timer?: ReturnType<typeof setTimeout> } | undefined;

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
		this.tree = vscode.window.createTreeView(agentsViewId, { treeDataProvider: this, showCollapseAll: false });
		this.changesView = new ChangesView(id => this.live.get(id)?.changes);
		this.projects = new Projects({
			record: id => this.model.agent(id),
			workspaceFolder: id => {
				const record = this.model.agent(id);
				return record && this.model.workspace(record.workspaceId)?.folder;
			},
			threadsOf: id => this.model.threadsOf(id),
			controller: id => this.ensureLive(id)?.controller,
			activity: id => this.live.get(id)?.activity,
			startThread: (id, request, setup) => this.startThread(id, request, setup),
			addRepo: (thread, repo, memory) => this.addThreadRepo(thread, repo, memory),
			open: id => this.open(id),
			stopTurn: id => this.stopTurn(id),
			mergeBack: (id, repo) => this.mergeBack(id, repo),
			changedFiles: id => this.live.get(id)?.changes.files,
			rename: (id, title) => this.renameAgent(id, title),
			trustThreads: async id => {
				const record = this.model.agent(id);
				const folder = record && this.model.workspace(record.workspaceId)?.folder;
				return !!folder && this.ensureProjectTrust(folder, true);
			},
			reloadProjectTools: id => this.reloadProjectTools(id),
			log: message => this.service.writeLog(message),
			sessionServers: id => this.live.get(id)?.session.client.openedMcpServers,
			reopenSession: async id => this.live.get(id)?.session.client.reopen(),
			mcpProblem: name => this.service.mcpProblems.find(problem => problem.server === name && problem.severity === 'error')?.message,
			direct: request => this.direct?.(request) ?? Promise.resolve(undefined),
			openChanges: id => this.openChanges(id),
			undoThread: id => this.undoThread(id),
			resume: id => this.resumeThread(id),
			prepare: id => this.prepareThread(id),
			restoreFolder: id => this.restoreFolder(id),
			savedConversation: async id => this.live.get(id)?.controller.conversation ?? (await this.transcripts.load(id)).items,
			cleanUpMerged: id => this.cleanUpMerged(id),
			settingUp: id => this.settingUp.has(id),
			setResolved: (id, resolved) => this.model.setThreadResolved(id, resolved),
		}, String(context.extension.packageJSON.version ?? '0'));
		this.review = new ReviewController(() => [...this.live.entries()].map(([id, live]) => ({ title: vscode.l10n.t("the agent \"{0}\"", this.model.agent(id)?.title ?? ''), changes: live.changes })));
		this.disposables.push(
			this.tree,
			this.notifier,
			this.changesView,
			this.review,
			this.onDidChangeTreeDataEmitter,
			this.onDidChangeAgentsEmitter,
			this.onDidFocusEmitter,
			this.model.onDidChange(() => {
				this.persistSoon();
				this.refresh();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration(`${configSection}.notifications`) || e.affectsConfiguration(`${configSection}.projects.enabled`)) && this.refresh()),
			// Relative times go stale; refresh them only while the pane is visible.
			this.tree.onDidChangeVisibility(e => this.setRefreshing(e.visible)),
			// A thread picked with the keyboard is likely opened next: its session starts now, so the chat is ready by then.
			this.tree.onDidChangeSelection(e => {
				const node = e.selection[0];
				if (node?.kind === 'agent' && node.record.project?.role === 'thread') {
					this.prepareThread(node.record.id);
				}
			}),
			vscode.commands.registerCommand('gemini.agents.newAgent', (node?: Node) => this.newAgent(node)),
			vscode.commands.registerCommand('gemini.agents.newAgentOnBranch', (node?: Node) => this.newAgent(node, true)),
			vscode.commands.registerCommand('gemini.agents.mergeBack', (node?: Node) => node?.kind === 'agent' && this.mergeBack(node.record.id)),
			vscode.commands.registerCommand('gemini.reviewChanges', (source?: { readonly rootUri?: vscode.Uri }) => this.reviewChanges(source)),
			vscode.commands.registerCommand('gemini.agents.addWorkspace', () => this.addWorkspace()),
			// From the keyboard (⌘↓ on a Mac, where Return renames as in Finder) it opens the selected agent.
			vscode.commands.registerCommand('gemini.agents.open', (id?: string) => {
				const selected = this.tree.selection[0];
				const target = typeof id === 'string' ? id : selected?.kind === 'agent' ? selected.record.id : undefined;
				return target && this.open(target);
			}),
			vscode.commands.registerCommand('gemini.agents.openChanges', (node?: Node) => node?.kind === 'agent' && this.openChanges(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.rename', (node?: Node) => this.rename(node)),
			vscode.commands.registerCommand('gemini.agents.openAsMarkdown', (node?: Node) => node?.kind === 'agent' && this.openAsMarkdown(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.stop', (node?: Node) => node?.kind === 'agent' && this.stopTurn(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.remove', (node?: Node) => this.removeAgent(node)),
			vscode.commands.registerCommand('gemini.agents.removeWorkspace', (node?: Node) => this.removeWorkspace(node)),
			vscode.commands.registerCommand('gemini.projects.new', (node?: Node) => this.newProject(node)),
			// The Projects section's +: the same command, drawn as a plus.
			vscode.commands.registerCommand('gemini.projects.add', (node?: Node) => this.newProject(node)),
			vscode.commands.registerCommand('gemini.projects.newThread', (node?: Node) => node?.kind === 'agent' && this.projects.openNewThread(node.record.id)),
			vscode.commands.registerCommand('gemini.projects.settings', (node?: Node) => node?.kind === 'agent' && this.projects.openSettingsOf(node.record.id)),
			this.projects,
		);
		this.setRefreshing(this.tree.visible);
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
		const started = await this.newAgent(undefined);
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

	// --- Tree

	getTreeItem(node: Node): Promise<vscode.TreeItem> | vscode.TreeItem {
		switch (node.kind) {
			case 'section':
				return this.sectionItem(node);
			case 'message':
				return this.messageItem(node);
			case 'gap':
				return gapItem();
			case 'workspace':
				return this.workspaceItem(node);
			case 'agent':
				return this.agentItem(node);
			case 'archive':
				return this.archiveItem(node);
		}
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			const agents: SectionNode = { kind: 'section', section: 'agents' };
			return projectsEnabled() ? [{ kind: 'section', section: 'projects' }, { kind: 'gap' }, agents] : [agents];
		}
		if (node.kind === 'section') {
			const rows: Node[] = node.section === 'projects' ? this.projectNodes() : this.workspaceNodes();
			return rows.length ? rows : [{ kind: 'message', section: node.section }];
		}
		if (node.kind === 'workspace' && node.record) {
			return this.agentsOf(node.record.id).map(record => {
				const agent: AgentNode = { kind: 'agent', record, folder: record.worktree?.cwd ?? node.folder };
				this.agentNodes.set(record.id, agent);
				return agent;
			});
		}
		if (node.kind === 'agent' && node.record.project?.role === 'coordinator') {
			const now = Date.now();
			const threads = this.model.threadsOf(node.record.id);
			// A thread running in this window stays in the list, even if it was merged long ago.
			const archived = threads.filter(record => isArchived(record, now) && !this.live.has(record.id));
			const rows: Node[] = threads.filter(record => !archived.includes(record)).map(record => this.threadNode(record, node.folder));
			if (archived.length) {
				rows.push({ kind: 'archive', coordinator: node.record, folder: node.folder, count: archived.length });
			}
			return rows;
		}
		if (node.kind === 'archive') {
			const now = Date.now();
			// Most recently merged first: the one most likely looked for.
			return this.model.threadsOf(node.coordinator.id)
				.filter(record => isArchived(record, now) && !this.live.has(record.id))
				.sort((a, b) => resolvedAt(b) - resolvedAt(a))
				.map(record => this.threadNode(record, node.folder));
		}
		return [];
	}

	/** A row's parent, so the list can reveal and highlight the agent, project or thread whose tab is in front. */
	getParent(node: Node): Node | undefined {
		const projects = projectsEnabled();
		switch (node.kind) {
			case 'workspace':
				return { kind: 'section', section: 'agents' };
			case 'archive':
				return this.agentNodes.get(node.coordinator.id) ?? { kind: 'agent', record: node.coordinator, folder: node.folder };
			case 'agent': {
				const { record } = node;
				if (projects && record.project?.role === 'coordinator') {
					return { kind: 'section', section: 'projects' };
				}
				const coordinator = projects && record.project?.role === 'thread' ? this.model.coordinatorOf(record) : undefined;
				if (coordinator) {
					const folder = this.model.workspace(coordinator.workspaceId)?.folder ?? node.folder;
					return this.agentNodes.get(coordinator.id) ?? { kind: 'agent', record: coordinator, folder };
				}
				const workspace = this.model.workspace(record.workspaceId);
				if (!workspace) {
					return undefined;
				}
				const current = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === workspace.folder);
				return { kind: 'workspace', folder: workspace.folder, record: workspace, current };
			}
			default:
				return undefined;
		}
	}

	/** Highlights the row of agent `id` (its tab came to the front), without taking focus from the chat. */
	private revealInList(id: string): void {
		const node = this.agentNodes.get(id);
		if (node && this.tree.visible && this.tree.selection[0] !== node) {
			void Promise.resolve(this.tree.reveal(node, { select: true, focus: false, expand: false })).catch(() => undefined);
		}
	}

	private threadNode(record: AgentRecord, folder: string): AgentNode {
		const agent: AgentNode = { kind: 'agent', record, folder: record.worktree?.cwd ?? folder };
		this.agentNodes.set(record.id, agent);
		return agent;
	}

	private archiveItem(node: ArchiveNode): vscode.TreeItem {
		const item = new vscode.TreeItem(vscode.l10n.t("Archived"), vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `archive:${node.coordinator.id}`;
		item.description = String(node.count);
		item.iconPath = new vscode.ThemeIcon('archive');
		item.tooltip = vscode.l10n.t("Threads merged over a week ago. Each keeps its chat and branch: open one to pick it up again.");
		item.contextValue = 'archive';
		return item;
	}

	/** A workspace's own agents; projects and their threads are in the Projects section while it shows. */
	private agentsOf(workspaceId: string): AgentRecord[] {
		const projects = projectsEnabled();
		return this.model.agentsIn(workspaceId).filter(record => record.project?.role === 'thread'
			? !this.model.coordinatorOf(record) || !projects
			: record.project?.role !== 'coordinator' || !projects);
	}

	/** Every project, newest first, whichever workspace it is in. */
	private projectNodes(): AgentNode[] {
		return this.model.snapshot().agents
			.filter(record => record.project?.role === 'coordinator')
			.sort((a, b) => b.createdAt - a.createdAt)
			.flatMap(record => {
				const folder = this.model.workspace(record.workspaceId)?.folder;
				if (!folder) {
					return [];
				}
				const agent: AgentNode = { kind: 'agent', record, folder };
				this.agentNodes.set(record.id, agent);
				return [agent];
			});
	}

	private sectionItem(node: SectionNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.section === 'projects' ? vscode.l10n.t("Projects") : vscode.l10n.t("Agents"), vscode.TreeItemCollapsibleState.Expanded);
		item.id = `section:${node.section}`;
		item.contextValue = `section.${node.section}`;
		return item;
	}

	private messageItem(node: MessageNode): vscode.TreeItem {
		const projects = node.section === 'projects';
		const item = new vscode.TreeItem(projects ? vscode.l10n.t("No projects yet") : vscode.l10n.t("No agents yet"));
		item.id = `message:${node.section}`;
		item.description = vscode.l10n.t("+ to start one");
		item.iconPath = new vscode.ThemeIcon('info');
		item.tooltip = projects
			? vscode.l10n.t("A project's coordinator splits work into threads, each an agent on its own branch. Start one on any folder in a Git repository.")
			: vscode.l10n.t("Start an agent on a folder.");
		item.command = projects
			? { command: 'gemini.projects.new', title: vscode.l10n.t("New Project") }
			: { command: 'gemini.agents.newAgent', title: vscode.l10n.t("New Agent") };
		item.contextValue = 'message';
		return item;
	}

	private workspaceNodes(): WorkspaceNode[] {
		const open = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
		const nodes: WorkspaceNode[] = open.map(folder => ({ kind: 'workspace', folder, record: this.model.workspaceFor(folder), current: true }));
		for (const record of this.model.workspaces) {
			if (!nodes.some(n => n.record?.id === record.id)) {
				nodes.push({ kind: 'workspace', folder: record.folder, record, current: false });
			}
		}
		return nodes;
	}

	private async workspaceItem(node: WorkspaceNode): Promise<vscode.TreeItem> {
		const hasAgents = !!node.record && this.agentsOf(node.record.id).length > 0;
		const item = new vscode.TreeItem(path.basename(node.folder) || node.folder, hasAgents ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// The id changes with the expander, so a workspace that gets its first agent opens.
		item.id = `workspace:${node.folder}:${hasAgents}`;
		// Just the name, as a heading over its agents; the path is in the tooltip.
		item.tooltip = tildify(node.folder);
		// Agents mode draws workspaces as headings by this icon (geminiModes.css).
		item.iconPath = new vscode.ThemeIcon('folder');
		// `.git` offers New Agent on Its Own Branch.
		const inGit = await this.branchOf(node.folder).then(Boolean, () => false);
		item.contextValue = `${node.current ? 'workspace.current' : 'workspace'}${inGit ? '.git' : ''}`;
		return item;
	}

	private async agentItem(node: AgentNode): Promise<vscode.TreeItem> {
		const { record } = node;
		const live = this.live.get(record.id);
		const coordinator = record.project?.role === 'coordinator';
		const threads = coordinator ? this.model.threadsOf(record.id).length : 0;
		const item = new vscode.TreeItem(record.title, threads ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// The id changes with the expander, so a project that gets its first thread opens.
		item.id = `agent:${record.id}${threads ? ':threads' : ''}`;
		const branch = await this.branchOf(node.folder).catch(() => undefined);
		const changes = live?.changes.totals ?? record.changes;
		const state = this.agentState(live);
		item.description = this.rowMeta(record, live, state.kind, changes);
		item.iconPath = coordinator && (state.kind === 'idle' || state.kind === 'stopped') ? new vscode.ThemeIcon('comment-discussion') : state.icon;
		const where = record.worktree
			? vscode.l10n.t("On its own branch {0}, in {1}", escapeMarkdown(record.worktree.branch), escapeMarkdown(tildify(record.worktree.folder)))
			: `${escapeMarkdown(tildify(node.folder))}${branch ? ` (${escapeMarkdown(branch)})` : ''}`;
		const counts = changes?.files ? `\n\n${escapeMarkdown(formatCounts(changes))}` : '';
		item.tooltip = new vscode.MarkdownString(`**${escapeMarkdown(record.title)}**\n\n${escapeMarkdown(state.status)}${counts}\n\n${where}`);
		item.contextValue = `${live?.activity.busy ? 'agent.busy' : 'agent'}${record.worktree ? '.worktree' : ''}${changes?.files ? '.changes' : ''}${record.project?.role === 'coordinator' ? '.project' : ''}`;
		item.command = { command: 'gemini.agents.open', title: vscode.l10n.t("Open Agent"), arguments: [record.id] };
		item.accessibilityInformation = { label: `${record.title}, ${state.status}` };
		return item;
	}

	/** The row's note after the title: the turn's clock, "waiting", lines added, or how old it is. */
	private rowMeta(record: AgentRecord, live: LiveAgent | undefined, state: AgentStateKind, changes: ChangeTotals | undefined): string {
		const meta = agentRowMeta({ state, startedAt: live?.activity.startedAt, added: changes?.added }, Date.now());
		switch (meta.kind) {
			case 'clock':
			case 'added':
				return meta.text;
			case 'waiting':
				return vscode.l10n.t("waiting");
			case 'age':
				return relativeTime(record.updatedAt, Date.now());
		}
	}

	/** Each state's icon is a dot in its colour, or a spinner while the agent works. */
	private agentState(live: LiveAgent | undefined): { kind: AgentStateKind; icon: vscode.ThemeIcon; status: string } {
		const step = live?.activity.step;
		if (live?.session.status.phase === 'error') {
			return { kind: 'error', icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground')), status: vscode.l10n.t("Needs attention") };
		}
		if (live?.activity.needsPermission) {
			return { kind: 'waiting', icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow')), status: step ? vscode.l10n.t("Needs you: {0}", step) : vscode.l10n.t("Waiting for your permission") };
		}
		if (live?.activity.busy) {
			return { kind: 'working', icon: new vscode.ThemeIcon('loading~spin'), status: step ?? vscode.l10n.t("Working") };
		}
		if (live?.unread) {
			return { kind: 'done', icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green')), status: vscode.l10n.t("Done") };
		}
		const quiet = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('descriptionForeground'));
		return live
			? { kind: 'idle', icon: quiet, status: vscode.l10n.t("Idle") }
			: { kind: 'stopped', icon: quiet, status: vscode.l10n.t("Paused \u00b7 open to continue") };
	}

	/** Every agent, newest first. */
	summaries(): AgentSummary[] {
		const summaries: AgentSummary[] = [];
		const projects = projectsEnabled();
		for (const workspace of this.model.workspaces) {
			for (const record of this.model.agentsIn(workspace.id)) {
				const live = this.live.get(record.id);
				const state = this.agentState(live);
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
	async workspaces(): Promise<WorkspaceSummary[]> {
		return Promise.all(this.workspaceNodes().map(async node => ({
			folder: node.folder, current: node.current, git: await this.branchOf(node.folder).then(Boolean, () => false),
		})));
	}

	/**
	 * Keeps a spare session open in `folder` for the next agent started there,
	 * such as while the user types a task on Agent Home, so starting it waits
	 * for no `session/new`. Every way of starting an agent takes it, and it is
	 * refilled once taken. One spare at a time: gemini-cli cannot close a
	 * session, so moving it to another folder leaves the old one in the agent.
	 */
	prepareStart(folder: string, delayMs = 0): void {
		if (this.spare?.folder !== folder) {
			this.clearSpare();
			this.spare = { folder };
		}
		const spare = this.spare;
		const runtime = this.service.runtime;
		const open = () => {
			if (this.spare !== spare || runtime.state.kind !== 'ready') {
				return;
			}
			const key = this.spareKey(folder);
			if (runtime.spareKey === key) {
				return;
			}
			runtime.prepareSession(folder, supportedMcpServers(runtime.state.agent, [...this.browser?.spareServers() ?? [], ...this.teamTools?.spareServers() ?? []]), key);
		};
		if (runtime.state.kind === 'ready') {
			clearTimeout(spare.timer);
			spare.timer = setTimeout(open, delayMs);
		}
		// Again whenever the agent restarts, since a spare belongs to the process that opened it.
		spare.waiting ??= runtime.onDidChangeState(state => {
			if (state.kind === 'ready') {
				clearTimeout(spare.timer);
				spare.timer = setTimeout(open, spareDelayMs);
			}
		});
	}

	/**
	 * Opens the spare again when the servers a new session would get change (a
	 * tool connected, the browser turned on or off), so the next agent in the
	 * folder still finds one that matches; the runtime closes the old one.
	 */
	refreshSpare(): void {
		const spare = this.spare;
		if (spare && this.service.runtime.spareKey !== undefined && this.service.runtime.spareKey !== this.spareKey(spare.folder)) {
			this.prepareStart(spare.folder, spareDelayMs);
		}
	}

	/** Matches a spare session to the agents that can take it: same folder, and the browser the same way. */
	private spareKey(folder: string): string {
		return JSON.stringify(['agent', folder, !!this.browser?.serving, !!this.teamTools?.serving]);
	}

	/** Where the next agent most likely starts: where the last one did, else the first open folder. */
	private likelyFolder(): string | undefined {
		const last = [...this.model.snapshot().agents].filter(a => !a.worktree).sort((a, b) => b.createdAt - a.createdAt)[0];
		const folder = last && this.model.workspace(last.workspaceId)?.folder;
		return folder ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
	}

	private clearSpare(): void {
		this.spare?.waiting?.dispose();
		clearTimeout(this.spare?.timer);
		this.spare = undefined;
	}

	/** Starts an agent in `folder` (on its own branch, named after the prompt, with `ownBranch`) and sends it `text`. */
	/** Returns whether the agent started; when not, the user has been told why. */
	async startWithPrompt(folder: string, text: string, ownBranch: boolean, mode: string, attachments: readonly Attachment[]): Promise<boolean> {
		let worktree: AgentWorktree | undefined;
		if (ownBranch) {
			const repository = await repositoryRoot(folder);
			if (!repository) {
				void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
				return false;
			}
			const branch = await freeBranchName([repository], branchNameFrom(text));
			try {
				worktree = await this.makeWorktree(repository, branch, folder);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
				return false;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		// Started here, so its session opens in the mode picked.
		const live = this.start(agent, worktree?.cwd ?? folder);
		if (mode !== 'default') {
			live.session.client.setModeOnNextSession(mode);
		}
		await this.open(agent.id);
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
			const repository = await repositoryRoot(options.folder);
			if (!repository) {
				void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(options.folder)));
				return undefined;
			}
			try {
				worktree = await this.makeWorktree(repository, await freeBranchName([repository], options.branch), options.folder);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
				return undefined;
			}
		}
		const workspace = this.model.addWorkspace(options.folder);
		const agent = this.model.addAgent(workspace.id, options.title, worktree);
		// Named by the flow, so the first prompt doesn't rename it.
		this.model.rename(agent.id, options.title);
		const live = this.start(agent, worktree?.cwd ?? options.folder);
		if (options.mode && options.mode !== 'default') {
			live.session.client.setModeOnNextSession(options.mode);
		}
		await this.open(agent.id);
		if (options.text.trim()) {
			void live.controller.send(options.text);
		}
		return agent.id;
	}

	/** Where an agent works (its worktree's folder, or its workspace), and its own branch when it has one. */
	agentPlace(id: string): { readonly folder: string; readonly cwd: string; readonly branch?: string; readonly title: string } | undefined {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		return record && workspace ? { folder: workspace.folder, cwd: record.worktree?.cwd ?? workspace.folder, title: record.title, ...(record.worktree ? { branch: record.worktree.branch } : {}) } : undefined;
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
		const places = await this.workspaces();
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
			const repository = await repositoryRoot(folder);
			try {
				if (!repository) {
					void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
					return undefined;
				}
				const named = choice.branch && isValidBranchName(choice.branch) ? choice.branch : branchNameFrom(page);
				worktree = await this.makeWorktree(repository, await freeBranchName([repository], named), folder);
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
				return undefined;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		if (model) {
			this.threadModels.set(agent.id, model);
		}
		const live = this.start(agent, worktree?.cwd ?? folder);
		if (mode !== 'default') {
			live.session.client.setModeOnNextSession(mode);
		}
		await this.open(agent.id);
		return { id: agent.id, title: agent.title, ...(choice.task ? { task: choice.task } : {}) };
	}

	/**
	 * "Review my changes": starts an agent in Plan mode, so it reads but does
	 * not edit, with the repository's uncommitted diff attached.
	 */
	async reviewChanges(source?: { readonly rootUri?: vscode.Uri }): Promise<void> {
		const folder = source?.rootUri?.fsPath ?? await this.reviewFolder();
		if (!folder) {
			return;
		}
		const repository = await repositoryRoot(folder);
		if (!repository) {
			void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so there are no changes to review.", path.basename(folder)));
			return;
		}
		let changes;
		try {
			changes = await workingChanges(repository);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not read the changes: {0}", errorMessage(err)));
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
		const live = this.start(agent, folder);
		live.session.client.setModeOnNextSession('plan');
		await this.open(agent.id);
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

	/** The folder of the active editor, else the only open folder, else the one the user picks. */
	private async reviewFolder(): Promise<string | undefined> {
		const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (active || folders.length <= 1) {
			return (active ?? folders[0])?.uri.fsPath;
		}
		return (await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t("Review the changes in which folder?") }))?.uri.fsPath;
	}

	/** Stops the agent's current turn. */
	stopTurn(id: string): void {
		void this.live.get(id)?.session.cancel();
	}

	/** Sends the title bar a pill for each agent that is working, waiting or done and unread. */
	private updateTitleBar(): void {
		const pills = this.summaries()
			.filter(agent => agent.state === 'working' || agent.state === 'waiting' || agent.state === 'done' || agent.state === 'error')
			.sort((a, b) => pillOrder(a.state) - pillOrder(b.state))
			.map(agent => ({ id: agent.id, title: agent.title, state: agent.state, detail: agent.status }));
		const json = JSON.stringify(pills);
		if (json !== this.lastStatus) {
			this.lastStatus = json;
			// Only GeminiCode's workbench has this command.
			void Promise.resolve(vscode.commands.executeCommand('_gemini.setAgentStatus', pills)).catch(() => undefined);
		}
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
		const rows = [...this.refreshRows].map(id => this.agentNodes.get(id));
		const all = this.refreshAll || rows.some(node => !node);
		this.refreshAll = false;
		this.refreshRows.clear();
		if (all) {
			this.agentNodes.clear();
			this.onDidChangeTreeDataEmitter.fire(undefined);
		} else {
			// Only these agents changed state: redraw their rows, not the whole tree.
			for (const node of rows) {
				this.onDidChangeTreeDataEmitter.fire(node);
			}
		}
		this.updateClock();
		this.updateBadge();
		this.updateTitleBar();
		this.updateTabs();
		this.onDidChangeAgentsEmitter.fire();
	}

	/** Each agent tab's icon shows its state, and its description its line counts. */
	private updateTabs(): void {
		const tabs: { id: string; title: string; description: string }[] = [];
		for (const [id, live] of this.live) {
			if (!live.panel) {
				continue;
			}
			const state = this.agentState(live);
			const icon = state.kind === 'idle' || state.kind === 'stopped' ? this.restingTabIcon(id) : `tabs/${state.kind}.svg`;
			if (icon !== live.tabIcon) {
				live.tabIcon = icon;
				// Tab icons draw a ThemeIcon without its colour or spin, so these are SVGs (the spinner is animated).
				live.panel.iconPath = this.tabIcon(id, icon);
			}
			const totals = live.changes.totals;
			tabs.push({ id, title: live.panel.title, description: totals.files ? `+${totals.added} \u2212${totals.removed}` : '' });
		}
		const json = JSON.stringify(tabs);
		if (json !== this.lastTabs) {
			this.lastTabs = json;
			// Only GeminiCode's workbench has this command.
			void Promise.resolve(vscode.commands.executeCommand('_gemini.setAgentTabs', tabs)).catch(() => undefined);
		}
	}

	/**
	 * An agent tab's icon. The fragment names the agent, so the workbench can
	 * tell tabs apart when two agents have the same title (the browser ignores it).
	 */
	/** A resting agent's tab icon: the Jira logo for an agent on a ticket (its title or branch names one), else Gemini's. */
	private restingTabIcon(agentId: string): string {
		const record = this.model.agent(agentId);
		return record && (jiraKeyIn(record.title) || (record.worktree && jiraKeyIn(record.worktree.branch))) ? 'tools/jira.svg' : 'gemini.svg';
	}

	private tabIcon(agentId: string, file = 'gemini.svg'): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'media', file).with({ fragment: `${agentTabFragment}${agentId}` });
	}

	/** The number of agents waiting on the user, on the pane's icon and the Dock. */
	private updateBadge(): void {
		const count = waitingCount(this.live.values());
		const tooltip = count === 1 ? vscode.l10n.t("1 agent is waiting for you") : vscode.l10n.t("{0} agents are waiting for you", count);
		if (this.tree.badge?.value !== count) {
			this.tree.badge = count ? { value: count, tooltip } : undefined;
		}
		this.notifier.setWaiting(count);
	}

	private setRefreshing(visible: boolean): void {
		if (visible && !this.refreshTimer) {
			this.refreshTimer = setInterval(() => this.refresh(), 60_000);
		} else if (!visible && this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.updateClock();
	}

	/** Agents working now (not waiting on the user), whose rows show a running clock. */
	private workingIds(): string[] {
		return [...this.live].filter(([, live]) => live.activity.busy && !live.activity.needsPermission && live.session.status.phase !== 'error').map(([id]) => id);
	}

	/** Runs the clock tick while the pane is visible and an agent works; it redraws only those rows. */
	private updateClock(): void {
		const ticking = this.tree.visible && this.workingIds().length > 0;
		if (ticking && !this.clockTimer) {
			this.clockTimer = setInterval(() => {
				for (const id of this.workingIds()) {
					const node = this.agentNodes.get(id);
					if (node) {
						this.onDidChangeTreeDataEmitter.fire(node);
					}
				}
			}, 1000);
		} else if (!ticking && this.clockTimer) {
			clearInterval(this.clockTimer);
			this.clockTimer = undefined;
		}
	}

	// --- Commands

	/**
	 * Starts an agent in a workspace. With `ownBranch` (or the setting), it
	 * works on a new branch in its own worktree; unset falls back to the
	 * workspace folder outside a Git repository.
	 */
	private async newAgent(node: Node | undefined, ownBranch?: boolean): Promise<string | undefined> {
		const folder = node?.kind === 'workspace' ? node.folder : node?.kind === 'agent' ? this.model.workspace(node.record.workspaceId)?.folder : await this.pickFolder();
		if (!folder) {
			return undefined;
		}
		let worktree: AgentWorktree | undefined;
		if (ownBranch ?? vscode.workspace.getConfiguration(configSection).get<boolean>('agents.ownBranch', false)) {
			const repository = await repositoryRoot(folder);
			if (repository) {
				worktree = await this.createWorktree(repository, folder);
				if (!worktree) {
					return undefined;
				}
			} else if (ownBranch) {
				void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
				return undefined;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		await this.open(agent.id);
		return agent.id;
	}

	/** Asks for a branch name and makes the agent's worktree; undefined when dismissed or failed (the failure is shown). */
	private async createWorktree(repository: string, folder: string): Promise<AgentWorktree | undefined> {
		const suggestion = `gemini/agent-${Math.random().toString(16).slice(2, 6)}`;
		const branch = await vscode.window.showInputBox({
			title: vscode.l10n.t("New Agent on Its Own Branch"),
			prompt: vscode.l10n.t("The agent works on this new branch, in its own copy of {0}. Merge Back brings its work into your branch.", path.basename(repository)),
			value: suggestion,
			valueSelection: [suggestion.indexOf('/') + 1, suggestion.length],
			validateInput: async value => {
				const name = value.trim();
				if (!isValidBranchName(name)) {
					return vscode.l10n.t("Enter a valid branch name.");
				}
				return await branchExists(repository, name) ? vscode.l10n.t("A branch named {0} already exists.", name) : undefined;
			},
		});
		if (!branch?.trim()) {
			return undefined;
		}
		try {
			return await this.makeWorktree(repository, branch.trim(), folder);
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
			return undefined;
		}
	}

	/**
	 * Makes the agent's worktree, then runs the repository's setup in it (`gemini.agents.worktreeSetup`,
	 * else `.gemini/worktree-setup.sh`), such as installing packages or copying .env. A failed setup is
	 * reported with its output, but the agent still starts: the branch is there either way.
	 */
	private makeWorktree(repository: string, branch: string, folder: string): Thenable<AgentWorktree> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating the agent's branch..."), cancellable: true }, async (progress, token) => {
			const worktree = await createWorktree(repository, branch, await folderInRepository(folder));
			const command = await this.setupCommand(repository);
			if (!command || token.isCancellationRequested) {
				return worktree;
			}
			progress.report({ message: vscode.l10n.t("Running the setup script...") });
			await this.runSetup(command, worktree, repository, branch, token);
			return worktree;
		});
	}

	/** The repository's setup command for a new worktree; none in an untrusted workspace. */
	private async setupCommand(repository: string): Promise<string | undefined> {
		return vscode.workspace.isTrusted
			? worktreeSetupCommand(repository, vscode.workspace.getConfiguration(configSection).get<string>('agents.worktreeSetup'))
			: undefined;
	}

	/** Runs `command` in a new worktree, with its output in an output channel; a failure is reported, never thrown. */
	private async runSetup(command: string, worktree: AgentWorktree, repository: string, branch: string, token: vscode.CancellationToken): Promise<void> {
		if (!this.setupOutput) {
			this.setupOutput = vscode.window.createOutputChannel(vscode.l10n.t("Gemini Worktree Setup"));
			this.disposables.push(this.setupOutput);
		}
		const output = this.setupOutput;
		output.appendLine(`$ ${command}    (${worktree.folder})`);
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		const code = await runWorktreeSetup(command, worktree, repository, text => output.append(text), abort.signal).finally(() => cancel.dispose());
		output.appendLine(code === 0 ? '' : vscode.l10n.t("Exited with {0}.", code));
		if (code !== 0 && !token.isCancellationRequested) {
			const show = vscode.l10n.t("Show Output");
			void vscode.window.showWarningMessage(vscode.l10n.t("The setup script for {0} failed. The agent starts anyway.", branch), show).then(choice => choice === show && output.show());
		}
	}

	/**
	 * Picks a free branch name and adds its worktree, one at a time per
	 * repository: threads started together could otherwise pick the same name.
	 */
	private addThreadWorktree(repository: string, named: string, folder: string): Promise<AgentWorktree> {
		return this.inTurn(repository, async () => createWorktree(repository, await freeBranchName([repository], named), await folderInRepository(folder)));
	}

	/** Runs `task` once the last one queued under `key` has ended. */
	private inTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.worktreeQueue.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		const tail = next.then(() => undefined, () => undefined);
		this.worktreeQueue.set(key, tail);
		void tail.then(() => {
			if (this.worktreeQueue.get(key) === tail) {
				this.worktreeQueue.delete(key);
			}
		});
		return next;
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
						await this.removeAgentAndWorktree(record.id, true);
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
	private async mergeWorktree(record: AgentRecord, repository: string, worktree: AgentWorktree, live: LiveAgent | undefined, stillWorking: () => boolean): Promise<boolean> {
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

	/** Removes the agent, its worktree folder and, with `deleteBranch`, its branch. */
	private async removeAgentAndWorktree(id: string, deleteBranch: boolean): Promise<void> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		this.stop(id, false);
		if (record) {
			this.projects.threadRemoved(record);
		}
		this.model.removeAgent(id);
		void this.transcripts.delete(id);
		void this.checkpointFiles.delete(id);
		this.browser?.closeAgent(id);
		this.teamTools?.forgetAgent(id);
		if (record?.worktree && record.repos?.length) {
			await removeThreadFolder(record.repos, record.worktree.folder, deleteBranch).catch(err =>
				vscode.window.showWarningMessage(vscode.l10n.t("The agent was removed, but its folder {0} could not be: {1}", tildify(record.worktree!.folder), errorMessage(err))));
		} else if (record?.worktree && workspace) {
			const repository = await repositoryRoot(workspace.folder) ?? workspace.folder;
			await removeWorktree(repository, record.worktree, deleteBranch).catch(err =>
				vscode.window.showWarningMessage(vscode.l10n.t("The agent was removed, but its folder {0} could not be: {1}", tildify(record.worktree!.folder), errorMessage(err))));
		}
	}

	private async pickFolder(): Promise<string | undefined> {
		const workspaces = this.workspaceNodes();
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
		return pick.folder ?? this.chooseFolder();
	}

	/** Where a new project works: a workspace the list knows, or any folder. */
	private async pickProjectFolder(): Promise<string | undefined> {
		const choose = vscode.l10n.t("Choose a Folder...");
		const picks: (vscode.QuickPickItem & { folder?: string })[] = [
			...this.workspaceNodes().map(w => ({ label: `$(folder) ${path.basename(w.folder)}`, description: tildify(w.folder), folder: w.folder })),
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
		return pick.folder ?? this.chooseFolder();
	}

	private async addWorkspace(): Promise<void> {
		const folder = await this.chooseFolder();
		if (folder) {
			const workspace = this.model.addWorkspace(folder);
			await this.open(this.model.addAgent(workspace.id, vscode.l10n.t("New agent")).id);
		}
	}

	private async chooseFolder(): Promise<string | undefined> {
		const [uri] = await vscode.window.showOpenDialog({
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
			openLabel: vscode.l10n.t("Add Workspace"), title: vscode.l10n.t("Add a workspace for agents"),
		}) ?? [];
		return uri?.scheme === 'file' ? uri.fsPath : undefined;
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
			const folder = record.worktree?.cwd ?? workspace.folder;
			// A merged thread's folder may have been cleaned up: it comes back from its branch.
			if (record.worktree && !await this.restoreFolder(id)) {
				void vscode.window.showErrorMessage(vscode.l10n.t("The folder of \"{0}\"'s branch, {1}, no longer exists.", record.title, tildify(record.worktree.folder)));
				return;
			}
			if (record.project && projectsEnabled()) {
				// Its session gets the project's tools, so their server must listen first, in a folder the CLI trusts.
				await this.projects.ready();
				const coordinatorId = record.project.role === 'coordinator' ? record.id : record.project.coordinator;
				await this.ensureProjectTrust(workspace.folder, !!record.repos?.length || await savedRepoCount(coordinatorHome(coordinatorId)) > 1);
				if (record.project.role === 'coordinator') {
					await this.linkRules(workspace.folder, coordinatorHome(record.id), 'coordinator');
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
			panel.iconPath = this.tabIcon(id, this.restingTabIcon(id));
			live.panel = panel;
			// A disposed panel throws on `.webview`, so keep the webview for detaching.
			const webview = panel.webview;
			live.controller.attach(webview);
			panel.onDidChangeViewState(e => {
				live.controller.setHidden(!e.webviewPanel.visible);
				if (e.webviewPanel.active) {
					this.focus(id);
					this.revealInList(id);
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
				this.lastTabs = '';
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

	/**
	 * The user is about to open a thread (the pointer is on its card or row, or
	 * the keyboard picked it): its session starts now, so its chat is ready
	 * when it opens. A thread already running, or whose folder was cleaned up, waits.
	 */
	private prepareThread(id: string): void {
		if (!this.live.has(id)) {
			void this.resumeThread(id);
		}
	}

	/**
	 * Puts back the worktree folders Clean Up removed from a merged thread,
	 * from its branches; resolves whether the thread has a folder to run in.
	 */
	private restoreFolder(id: string): Promise<boolean> {
		const pending = this.restoringFolders.get(id);
		if (pending) {
			return pending;
		}
		const restoring = (async () => {
			const record = this.model.agent(id);
			const workspace = record && this.model.workspace(record.workspaceId);
			if (!record || !workspace) {
				return false;
			}
			if (!record.worktree) {
				return true;
			}
			const trees = await this.threadWorktrees(record);
			const back = await Promise.all(trees.map(({ repository, worktree }) => restoreWorktree(repository, worktree).catch(() => false)));
			// A thread in several repositories runs in its own folder, which Clean Up keeps; any repository that came back is enough to work in.
			return record.repos?.length ? back.some(Boolean) && await exists(record.worktree.folder) : back.every(Boolean);
		})().finally(() => this.restoringFolders.delete(id));
		this.restoringFolders.set(id, restoring);
		return restoring;
	}

	/** Each Git worktree an agent works in, with the repository it belongs to. */
	private async threadWorktrees(record: AgentRecord): Promise<{ readonly repository: string; readonly worktree: AgentWorktree }[]> {
		if (record.repos?.length) {
			return record.repos.map(repo => ({ repository: repo.repository, worktree: repo }));
		}
		const workspace = this.model.workspace(record.workspaceId);
		if (!record.worktree || !workspace) {
			return [];
		}
		return [{ repository: await repositoryRoot(workspace.folder) ?? workspace.folder, worktree: record.worktree }];
	}

	/**
	 * Project Settings' Clean Up: removes merged threads' worktree folders
	 * (with their node_modules and builds) that hold nothing unmerged. Their
	 * branches, chats and records stay, so each thread can still be opened,
	 * and its folder comes back from its branch when it is.
	 */
	private async cleanUpMerged(coordinatorId: string): Promise<void> {
		const threads = this.model.threadsOf(coordinatorId).filter(thread => thread.project?.role === 'thread' && thread.project.resolved && thread.worktree
			&& !this.live.get(thread.id)?.activity.busy && !this.merging.has(thread.id) && !this.settingUp.has(thread.id));
		type Folder = { readonly thread: AgentRecord; readonly repository: string; readonly worktree: AgentWorktree; readonly size: number };
		const { found, kept } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Looking at merged threads' folders...") }, async () => {
			const found: Folder[] = [];
			let kept = 0;
			for (const thread of threads) {
				for (const { repository, worktree } of await this.threadWorktrees(thread)) {
					if (!await exists(worktree.folder)) {
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
			this.stop(folder.thread.id, true);
			try {
				await removeWorktree(folder.repository, folder.worktree, false);
				removed++;
				freed += folder.size;
			} catch (err) {
				failed.push(`${tildify(folder.worktree.folder)}: ${errorMessage(err)}`);
			}
		}
		this.refresh();
		if (failed.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Removed {0} folders. Could not remove {1}", removed, failed.join('; ')));
		} else {
			void vscode.window.showInformationMessage(removed === 1 ? vscode.l10n.t("Removed 1 folder, freeing {0}.", formatBytes(freed)) : vscode.l10n.t("Removed {0} folders, freeing {1}.", removed, formatBytes(freed)));
		}
	}

	/** Starts a project thread's agent without a tab, as its project opens; skipped when it runs or its worktree is gone. */
	private async resumeThread(id: string): Promise<void> {
		const record = this.model.agent(id);
		const folder = record && this.model.folderOf(record);
		if (this.live.has(id) || !folder || !await exists(folder)) {
			return;
		}
		if (this.live.has(id)) {
			// Opened while the folder was checked.
			return;
		}
		this.ensureLive(id);
		this.refresh(id);
	}

	/**
	 * Starts one of a project's threads: a new agent on a new branch in its own
	 * worktree, sent its brief at once. Its tab opens only when the user opens it.
	 */
	private async startThread(coordinatorId: string, request: ThreadRequest, setup: ThreadSetup = {}): Promise<string> {
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
		const worktree = await this.addThreadWorktree(repository, named, workspace.folder);
		let agentId: string | undefined;
		try {
			await this.linkRules(workspace.folder, worktree.cwd, 'thread');
			const agent = this.model.addAgent(workspace.id, request.title, worktree, undefined, {
				role: 'thread', coordinator: coordinatorId, byCoordinator: request.byCoordinator,
				...(request.planFirst ? { planFirst: true } : {}),
				...(request.track ? { track: request.track } : {}),
			});
			agentId = agent.id;
			this.model.rename(agent.id, request.title);
			if (request.model) {
				this.threadModels.set(agent.id, request.model);
			}
			await this.projects.ready();
			const live = this.start(this.model.agent(agent.id) ?? agent, worktree.cwd);
			if (request.planFirst) {
				live.session.client.setModeOnNextSession('plan');
			}
			this.refresh();
			// The agent starts while the repository's setup runs, and gets its brief
			// when setup ends; the caller (the coordinator's start_thread) doesn't wait.
			if (setup.memory) {
				live.controller.addContext(threadMemoryContext(setup.memory));
			}
			this.briefAfterSetup(agent.id, request, this.setUpThread(repository, worktree));
			return agent.id;
		} catch (err) {
			// Nothing points at the worktree any more: remove it with its branch.
			if (agentId) {
				this.stop(agentId, false);
				this.model.removeAgent(agentId);
			}
			void removeWorktree(repository, worktree, true).catch(() => undefined);
			throw err;
		}
	}

	/** Sends a new thread its brief once `setup` ends; meanwhile notes for it wait. */
	private briefAfterSetup(id: string, request: ThreadRequest, setup: Promise<unknown>): void {
		this.settingUp.add(id);
		void setup.then(() => {
			this.settingUp.delete(id);
			if (this.model.agent(id) && this.live.get(id)) {
				// Not awaited: send resolves when the whole turn ends.
				this.projects.sendToThread(id, threadPrompt(request.brief, request.planFirst), request.byCoordinator ? 'coordinator' : undefined);
			}
		});
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
		// Threads started together take turns, so they can't pick the same branch or folder.
		const made = await this.inTurn(`threads:${coordinatorId}`, async () => {
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
		});
		const worktree: AgentWorktree = { folder: made.folder, cwd: made.folder, branch: made.branch, base: made.worktrees[0].base };
		let agentId: string | undefined;
		try {
			await Promise.all(made.worktrees.map(each => this.linkRules(each.repository, each.folder, 'thread')));
			await writeThreadGuide(made.folder, threadGuide(made.worktrees, made.branch, setup.memory));
			const agent = this.model.addAgent(workspace.id, request.title, worktree, undefined, {
				role: 'thread', coordinator: coordinatorId, byCoordinator: request.byCoordinator,
				...(request.planFirst ? { planFirst: true } : {}),
				...(request.track ? { track: request.track } : {}),
			});
			agentId = agent.id;
			this.model.setRepos(agent.id, made.worktrees);
			this.model.rename(agent.id, request.title);
			if (request.model) {
				this.threadModels.set(agent.id, request.model);
			}
			await this.projects.ready();
			const live = this.start(this.model.agent(agent.id) ?? agent, made.folder);
			if (request.planFirst) {
				live.session.client.setModeOnNextSession('plan');
			}
			this.refresh();
			this.briefAfterSetup(agent.id, request, Promise.all(made.worktrees.map(each => this.setUpThread(each.repository, each))));
			return agent.id;
		} catch (err) {
			if (agentId) {
				this.stop(agentId, false);
				this.model.removeAgent(agentId);
			}
			void removeThreadFolder(made.worktrees, made.folder, true).catch(() => undefined);
			throw err;
		}
	}

	/** The add_repo tool: another of the project's repositories, as a new worktree on the thread's branch in its folder. */
	private async addThreadRepo(id: string, repo: ProjectRepo, memory: string | undefined): Promise<string> {
		const record = this.model.agent(id);
		const coordinator = record?.project?.role === 'thread' ? record.project.coordinator : undefined;
		if (!record?.worktree || !record.repos?.length || !coordinator) {
			throw new Error('This thread works in one repository\'s worktree and can\'t add another. Report that the work needs a thread across repositories.');
		}
		const { folder, branch } = record.worktree;
		if (record.repos.some(each => each.key === repo.key)) {
			return `${repo.key}/ is already in your folder.`;
		}
		const made = await this.inTurn(`threads:${coordinator}`, async () => {
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
		const command = await this.setupCommand(repo.folder).catch(() => undefined);
		if (command) {
			void this.setUpThread(repo.folder, added);
		}
		return `Added ${repo.key}/ to your folder, on the branch ${branch}.${command ? ' Its setup script is running in the background, so packages may not be installed yet.' : ''}`;
	}

	/** Runs the repository's setup in a thread's new worktree, behind a notification; resolves when it ends, however it ends. */
	private async setUpThread(repository: string, worktree: AgentWorktree): Promise<void> {
		const command = await this.setupCommand(repository).catch(() => undefined);
		if (!command) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Setting up the thread's branch {0}...", worktree.branch), cancellable: true },
			(_progress, token) => this.runSetup(command, worktree, repository, worktree.branch, token)).then(undefined, () => undefined);
	}

	/** "Undo thread": asks, then removes the thread with its folder and branch. */
	private async undoThread(id: string): Promise<boolean> {
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
		await this.removeAgentAndWorktree(id, true);
		return true;
	}

	/** Starts a project: a coordinator agent in a Git workspace, whose chat is the project chat. */
	private async newProject(node: Node | undefined): Promise<void> {
		if (!projectsEnabled()) {
			const enable = vscode.l10n.t("Turn On");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Projects are a preview. Turn them on?"), enable) !== enable) {
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
			void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository. A project's threads each work on their own branch, so a project needs one.", path.basename(folder)));
			return;
		}
		if (!await this.ensureProjectTrust(folder)) {
			return;
		}
		// No other questions: the project chat opens at once, named after its repository; Rename changes it.
		const workspace = this.model.addWorkspace(folder);
		const taken = new Set(this.model.snapshot().agents.filter(a => a.project?.role === 'coordinator').map(a => a.title));
		const base = path.basename(repository);
		let title = base;
		for (let n = 2; taken.has(title); n++) {
			title = `${base} ${n}`;
		}
		const agent = this.model.addAgent(workspace.id, title, undefined, undefined, { role: 'coordinator' });
		this.model.rename(agent.id, title);
		await this.open(agent.id);
	}

	/**
	 * Gives a project agent's folder the repository's own rules and skills
	 * (projectRules.ts): a coordinator's empty folder its context files, a
	 * thread's worktree all those the repository ignores. Never stops the
	 * agent starting.
	 */
	private async linkRules(folder: string, into: string, role: 'coordinator' | 'thread'): Promise<void> {
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
	private async reloadProjectTools(coordinatorId: string): Promise<boolean> {
		const record = this.model.agent(coordinatorId);
		const folder = record && this.model.workspace(record.workspaceId)?.folder;
		if (!folder) {
			return false;
		}
		const repository = await repositoryRoot(folder) ?? folder;
		const threads = await savedRepoCount(coordinatorHome(coordinatorId)) > 1;
		if (await projectFoldersTrusted(projectFolders(repository, threads))) {
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
	private async ensureProjectTrust(folder: string, threads = false): Promise<boolean> {
		const repository = await repositoryRoot(folder) ?? folder;
		const folders = projectFolders(repository, threads);
		if (await projectFoldersTrusted(folders)) {
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
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not trust {0}: {1}", path.basename(repository), errorMessage(err)));
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

	/** Opens the agent's changes in the multi-diff editor, starting it to read them if needed. */
	async openChanges(id: string): Promise<void> {
		if (!this.live.has(id)) {
			await this.open(id);
		}
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
			agentId: id, title: record.title, folder: record.worktree?.cwd ?? workspace.folder, changes: live.changes,
			editorColumn: () => agentColumn(id, live.panel),
			focusEditors: async () => { await agentColumn(id, live.panel, true); },
			busy: () => live.activity.busy,
			...(record.worktree ? { branch: record.worktree.branch, mergeBack: async () => { await this.mergeBack(id); } } : { commit: () => live.controller.commit() }),
		} : undefined;
	}

	/** A coordinator runs on Flash; a thread on the model picked for it, once; others on the user's choice. */
	private preferredModel(record: AgentRecord): ((available: readonly SessionChoice[]) => string | undefined) | undefined {
		const picked = this.threadModels.get(record.id);
		if (picked) {
			this.threadModels.delete(record.id);
			return available => available.some(choice => choice.id === picked) ? picked : sessionModel(available);
		}
		if (projectsEnabled() && record.project?.role === 'coordinator') {
			return available => coordinatorModel(available.map(choice => choice.id));
		}
		return undefined;
	}

	private start(record: AgentRecord, folder: string, openLater = false): LiveAgent {
		const project = projectsEnabled() ? record.project : undefined;
		const servers = () => [...this.browser?.mcpServersFor(record.id, folder) ?? [], ...this.teamTools?.mcpServersFor(record.id, folder) ?? [], ...project ? this.projects.mcpServersFor(this.model.agent(record.id) ?? record) : []];
		// A coordinator's session runs in its own empty folder (coordinatorHome); its chat still belongs to the workspace.
		const cwd = project?.role === 'coordinator' ? coordinatorHome(record.id) : folder;
		const session = new AgentSession(this.service, cwd, record.sessionId, servers, openLater, {
			// A project agent's session needs the project's server, which a spare never has, listening before it opens:
			// a session opened without it, as from a restored tab or a thread warmed at project open, never gets the tools.
			// A coordinator's own folder has to exist before its session opens there.
			...(project ? { beforeOpen: async () => { if (cwd !== folder) { await fs.promises.mkdir(cwd, { recursive: true }); } await this.projects.ready(); } } : { spareKey: () => this.spareKey(folder) }),
			onDidOpenSession: servers => {
				this.browser?.bindSession(record.id, folder, servers);
				this.teamTools?.bindSession(record.id, folder, servers);
				// Refill, for the next agent, which most likely starts in the same folder; not in an agent's own worktree.
				if (!this.model.agent(record.id)?.worktree) {
					this.prepareStart(folder, spareDelayMs);
				}
			},
		}, this.preferredModel(record));
		session.permissions.confirmOnly = request => !!this.teamTools?.isConfirmCall(request);
		session.permissions.answerAtOnce = request => (project ? this.projects.instantAnswer(this.model.agent(record.id) ?? record, request) : undefined)
			?? this.teamTools?.instantAnswer(request);
		const files: FileSearch = isOpenFolder(folder) ? this.workspaceFiles : new FolderFileIndex(folder);
		const changes = new AgentChanges(folder);
		const live: LiveAgent = {
			session,
			changes,
			controller: new ChatController(this.context.extensionUri, session, this.diffPreview, files, {
				reveal: preserveFocus => this.reveal(record.id, preserveFocus),
				editorColumn: () => agentColumn(record.id, this.live.get(record.id)?.panel),
				enhancer: this.enhancer,
				usage: () => this.usage,
				toolChips: () => this.teamTools && toolChipsFor(this.teamTools),
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
				workspace: () => {
					const workspace = this.model.workspace(record.workspaceId);
					const current = this.model.agent(record.id) ?? record;
					// A coordinator of a project with several repositories shows each; a thread across them, its worktree of each.
					const threadRepos = current.repos?.filter(repo => !repo.merged).map(repo => ({ name: repo.key, folder: repo.cwd }));
					const repos = current.project?.role === 'coordinator' && projectsEnabled() ? this.projects.repoFolders(current.id) : threadRepos && threadRepos.length > 1 ? threadRepos : undefined;
					return workspace && { folder: workspace.folder, cwd: folder, worktree: !!current.worktree, ...(repos ? { repos } : {}) };
				},
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
			live.controller.onDidEditFiles(diffs => changes.record(diffs)),
			changes.onDidChange(() => {
				this.review.refreshSoon();
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

	private async rename(node: Node | undefined): Promise<void> {
		node ??= this.tree.selection[0];
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

	private async removeAgent(node: Node | undefined): Promise<void> {
		node ??= this.tree.selection[0];
		if (node?.kind !== 'agent') {
			return;
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
			this.projects.threadRemoved(node.record);
			this.model.removeAgent(node.record.id);
			void this.transcripts.delete(node.record.id);
			void this.checkpointFiles.delete(node.record.id);
			this.browser?.closeAgent(node.record.id);
			this.teamTools?.forgetAgent(node.record.id);
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

	private async removeWorkspace(node: Node | undefined): Promise<void> {
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
				this.teamTools?.forgetAgent(agent.id);
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
		this.clearSpare();
		clearTimeout(this.refreshTimeout);
		clearInterval(this.clockTimer);
		if (this.persistTimeout) {
			void this.persist();
		}
		this.model.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}


async function exists(folder: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(folder));
		return true;
	} catch {
		return false;
	}
}

/** The gap between the sections: no label, and the blank icon marks it for Agents mode's styles (geminiModes.css). */
function gapItem(): vscode.TreeItem {
	const item = new vscode.TreeItem('');
	item.id = 'gap';
	item.iconPath = new vscode.ThemeIcon('blank');
	item.contextValue = 'gap';
	item.accessibilityInformation = { label: '', role: 'none' };
	return item;
}

function isOpenFolder(folder: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === folder);
}


/** Agents waiting on the user come first in the title bar, then working ones. */
function pillOrder(state: AgentStateKind): number {
	return state === 'waiting' || state === 'error' ? 0 : state === 'working' ? 1 : 2;
}

/** `branch`, or `branch-2`, `branch-3`... when taken in any of `repositories`. */
async function freeBranchName(repositories: readonly string[], branch: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? branch : `${branch}-${n}`;
		if (!(await Promise.all(repositories.map(repository => branchExists(repository, candidate)))).some(Boolean)) {
			return candidate;
		}
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

/** When a thread was merged back: kept since this version, else its last use. */
function resolvedAt(record: AgentRecord): number {
	return record.project?.role === 'thread' ? record.project.resolvedAt ?? record.updatedAt : record.updatedAt;
}

/** Removes a multi-repository thread's worktrees, then its folder, which GeminiCode made and holds nothing else of the user's. */
async function removeThreadFolder(repos: readonly ThreadRepo[], folder: string, deleteBranch: boolean): Promise<void> {
	const results = await Promise.allSettled(repos.map(repo => removeWorktree(repo.repository, repo, deleteBranch)));
	if (path.dirname(path.dirname(folder)) === allThreadsHome()) {
		await fs.promises.rm(folder, { recursive: true, force: true });
	}
	const failed = results.find(result => result.status === 'rejected');
	if (failed) {
		throw failed.reason;
	}
}

/**
 * The folders a project needs trusted: the coordinators' own, which hold
 * nothing; the repository's threads' worktrees; and with several
 * repositories, the folders that hold a worktree of each.
 */
function projectFolders(repository: string, threads: boolean): string[] {
	return [projectsHome(), worktreesHome(repository), ...threads ? [allThreadsHome()] : []];
}

/** Whether the Gemini CLI trusts all of `folders`, or checks no folder's trust. */
async function projectFoldersTrusted(folders: readonly string[]): Promise<boolean> {
	const file = trustedFoldersPath(process.env);
	return !await folderTrustApplies(process.env) || (await Promise.all(folders.map(each => isFolderTrusted(file, each)))).every(trusted => trusted === true);
}

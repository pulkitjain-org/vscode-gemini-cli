/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, ChangeTotals, formatCounts } from '../acp/agentChanges';
import { agentRowMeta } from '../acp/agentRow';
import { attentionChange, waitingCount } from '../acp/attention';
import { branchNameFrom, isValidBranchName } from '../acp/branchNames';
import { AgentRecord, AgentsModel, AgentsSnapshot, WorkspaceRecord } from '../acp/agents';
import { coordinatorModel, threadPrompt, type ThreadRequest } from '../acp/projectHub';
import type { Attachment } from '../acp/attachments';
import { FolderFileIndex } from '../acp/folderFiles';
import { readGitHead } from '../acp/gitHead';
import { errorMessage } from '../acp/errors';
import { memoizeAsync } from '../acp/memoize';
import { reviewRequest, workingChanges } from '../acp/reviewPrompt';
import type { SessionChoice } from '../acp/sessionSettings';
import { TranscriptStore } from '../acp/transcriptStore';
import { AgentWorktree, branchExists, commitAll, createWorktree, currentBranch, folderInRepository, mergeBranch, removeWorktree, repositoryRoot, runWorktreeSetup, worktreeSetupCommand, worktreeStatus } from '../acp/worktrees';
import { supportedMcpServers } from '../acp/agentClient';
import { AgentNotifier } from './agentNotifier';
import { AgentService } from './agentService';
import { AgentSession } from './agentSession';
import { ChangesSource, ChangesView } from './changesView';
import type { AgentStateKind } from './panelProtocol';
import { ReviewController } from './reviewController';
import type { BrowserTools } from './browserTools';
import { ChatActivity, ChatController, ChatEnhancer, FileSearch, openChatAsMarkdown } from './chatController';
import { configSection } from './configuration';
import { relativeTime, tildify } from './displayText';
import { Projects, projectsEnabled } from './projects';
export { relativeTime } from './displayText';
import { DiffPreview } from './diffPreview';
import { agentColumn, closeAgentFiles } from './editorPlacement';
import { escapeMarkdown } from './markdown';
import { sessionModel } from './modelPreference';
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

type Node = SectionNode | MessageNode | GapNode | WorkspaceNode | AgentNode;

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
	/** The state its tab's icon shows; unset for the Gemini icon. */
	tabIcon?: AgentStateKind;
	readonly disposables: vscode.Disposable[];
}

/** How long after a turn ends its conversation is saved, so quick turns write once. */
const saveDelayMs = 1_000;

/**
 * The Agents pane: workspaces, the agents under each, and an editor tab per
 * agent that reuses the chat. Every agent is a session on the one shared agent
 * process, so a new agent is ready in tens of milliseconds once the agent runs.
 */
export class AgentsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {

	private readonly model: AgentsModel;
	/** Each agent's conversation as shown, so its tab looks the same after a reload. */
	private readonly transcripts: TranscriptStore;
	private readonly live = new Map<string, LiveAgent>();
	/** The model a thread's first session starts on, picked in the New thread dialog. */
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
	/** Today's quota, for the chats' usage popover. */
	usage: UsageMeter | undefined;
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
			startThread: (id, request) => this.startThread(id, request),
			open: id => this.open(id),
			stopTurn: id => this.stopTurn(id),
			mergeBack: id => this.mergeBack(id),
			openChanges: id => this.openChanges(id),
			undoThread: id => this.undoThread(id),
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
			return this.model.threadsOf(node.record.id).map(record => {
				const agent: AgentNode = { kind: 'agent', record, folder: record.worktree?.cwd ?? node.folder };
				this.agentNodes.set(record.id, agent);
				return agent;
			});
		}
		return [];
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
		for (const workspace of this.model.workspaces) {
			for (const record of this.model.agentsIn(workspace.id)) {
				const live = this.live.get(record.id);
				const state = this.agentState(live);
				const changes = live?.changes.totals ?? record.changes;
				summaries.push({
					id: record.id, title: record.title, folder: workspace.folder, state: state.kind, status: state.status,
					...(changes?.files ? { changes } : {}), ...(record.worktree ? { worktree: record.worktree } : {}), updatedAt: record.updatedAt,
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
			runtime.prepareSession(folder, supportedMcpServers(runtime.state.agent, this.browser?.spareServers() ?? []), key);
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

	/** Matches a spare session to the agents that can take it: same folder, and the browser the same way. */
	private spareKey(folder: string): string {
		return JSON.stringify(['agent', folder, !!this.browser?.serving]);
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
			const branch = await freeBranchName(repository, branchNameFrom(text));
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

	private persist(): void {
		clearTimeout(this.persistTimeout);
		this.persistTimeout = undefined;
		void this.context.globalState.update(storageKey, this.model.snapshot());
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
			const icon = state.kind === 'idle' || state.kind === 'stopped' ? undefined : state.kind;
			if (icon !== live.tabIcon) {
				live.tabIcon = icon;
				// Tab icons draw a ThemeIcon without its colour or spin, so these are SVGs (the spinner is animated).
				live.panel.iconPath = icon ? this.tabIcon(id, `tabs/${icon}.svg`) : this.tabIcon(id);
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
	private async newAgent(node: Node | undefined, ownBranch?: boolean): Promise<void> {
		const folder = node?.kind === 'workspace' ? node.folder : node?.kind === 'agent' ? this.model.workspace(node.record.workspaceId)?.folder : await this.pickFolder();
		if (!folder) {
			return;
		}
		let worktree: AgentWorktree | undefined;
		if (ownBranch ?? vscode.workspace.getConfiguration(configSection).get<boolean>('agents.ownBranch', false)) {
			const repository = await repositoryRoot(folder);
			if (repository) {
				worktree = await this.createWorktree(repository, folder);
				if (!worktree) {
					return;
				}
			} else if (ownBranch) {
				void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
				return;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		await this.open(agent.id);
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
			const command = vscode.workspace.isTrusted
				? await worktreeSetupCommand(repository, vscode.workspace.getConfiguration(configSection).get<string>('agents.worktreeSetup'))
				: undefined;
			if (!command || token.isCancellationRequested) {
				return worktree;
			}
			progress.report({ message: vscode.l10n.t("Running the setup script...") });
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
			return worktree;
		});
	}

	/** Merges an agent's branch into what its workspace has checked out, committing its work first. */
	/** Merges an agent's branch into the branch its workspace has checked out. */
	/** Returns whether the branch was merged. */
	async mergeBack(id: string): Promise<boolean> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		const worktree = record?.worktree;
		if (!record || !workspace || !worktree) {
			return false;
		}
		const live = this.live.get(record.id);
		if (live?.activity.busy) {
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" is still working. Merge back once it finishes.", record.title));
			return false;
		}
		try {
			const repository = await repositoryRoot(workspace.folder);
			if (!repository) {
				throw new Error(vscode.l10n.t("{0} is no longer a Git repository.", workspace.folder));
			}
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
			if (status.uncommitted) {
				await commitAll(worktree.folder, record.title);
				live?.changes.clear();
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
			const done = vscode.l10n.t("Remove Agent and Branch");
			const keep = vscode.l10n.t("Keep Working");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Merged {0} into {1}.", worktree.branch, into), done, keep) === done) {
				await this.removeAgentAndWorktree(record.id, true);
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
		this.model.removeAgent(id);
		void this.transcripts.delete(id);
		this.browser?.closeAgent(id);
		if (record?.worktree && workspace) {
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
			if (record.worktree && !await exists(folder)) {
				void vscode.window.showErrorMessage(vscode.l10n.t("The folder of \"{0}\"'s branch, {1}, no longer exists.", record.title, tildify(record.worktree.folder)));
				return;
			}
			if (record.project && projectsEnabled()) {
				// Its session gets the project's tools, so their server must listen first.
				await this.projects.ready();
			}
			live = this.live.get(id) ?? this.startSaved(record, folder);
		}
		live.unread = false;
		this.notifier.clear(id);
		if (live.panel) {
			live.panel.reveal();
		} else {
			const panel = vscode.window.createWebviewPanel(agentPanelType, record.title, vscode.ViewColumn.Active, {
				enableScripts: true,
				// Switching tabs then costs no re-render of a long conversation.
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			});
			panel.iconPath = this.tabIcon(id);
			live.panel = panel;
			// A disposed panel throws on `.webview`, so keep the webview for detaching.
			const webview = panel.webview;
			live.controller.attach(webview);
			panel.onDidChangeViewState(e => {
				if (e.webviewPanel.active) {
					this.focus(id);
				}
				if (e.webviewPanel.active) {
					this.notifier.clear(id);
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
			void this.transcripts.load(record.id).then(stored => {
				// The agent may have been stopped while the file was read.
				if (this.live.get(record.id) !== live) {
					return;
				}
				live.controller.restore(stored.items, record.sessionId);
				live.changes.restore(stored.changes);
			});
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
	 * Starts one of a project's threads: a new agent on a new branch in its own
	 * worktree, sent its brief at once. Its tab opens only when the user opens it.
	 */
	private async startThread(coordinatorId: string, request: ThreadRequest): Promise<string> {
		const coordinator = this.model.agent(coordinatorId);
		const workspace = coordinator && this.model.workspace(coordinator.workspaceId);
		if (!workspace) {
			throw new Error(vscode.l10n.t("The project is gone."));
		}
		const repository = await repositoryRoot(workspace.folder);
		if (!repository) {
			throw new Error(vscode.l10n.t("{0} is not in a Git repository, so a thread can't have its own branch.", path.basename(workspace.folder)));
		}
		const named = request.branch && isValidBranchName(request.branch) ? request.branch : branchNameFrom(request.title);
		const branch = await freeBranchName(repository, named);
		const worktree = await this.makeWorktree(repository, branch, workspace.folder);
		const agent = this.model.addAgent(workspace.id, request.title, worktree, undefined, {
			role: 'thread', coordinator: coordinatorId, byCoordinator: request.byCoordinator,
			...(request.planFirst ? { planFirst: true } : {}),
			...(request.track ? { track: request.track } : {}),
		});
		this.model.rename(agent.id, request.title);
		if (request.model) {
			this.threadModels.set(agent.id, request.model);
		}
		await this.projects.ready();
		const live = this.start(this.model.agent(agent.id) ?? agent, worktree.cwd);
		if (request.planFirst) {
			live.session.client.setModeOnNextSession('plan');
		}
		// Not awaited: send resolves when the whole turn ends.
		void live.controller.send(threadPrompt(request.brief, request.planFirst), [], request.byCoordinator ? 'coordinator' : undefined);
		this.refresh();
		return agent.id;
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
		// No questions first: the project chat opens at once, named after its repository; Rename changes it.
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
		if (!projectsEnabled()) {
			return undefined;
		}
		if (record.project?.role === 'coordinator') {
			return available => coordinatorModel(available.map(choice => choice.id));
		}
		const picked = this.threadModels.get(record.id);
		if (!picked) {
			return undefined;
		}
		this.threadModels.delete(record.id);
		return available => available.some(choice => choice.id === picked) ? picked : sessionModel(available);
	}

	private start(record: AgentRecord, folder: string, openLater = false): LiveAgent {
		const project = projectsEnabled() ? record.project : undefined;
		const servers = () => [...this.browser?.mcpServersFor(record.id, folder) ?? [], ...project ? this.projects.mcpServersFor(this.model.agent(record.id) ?? record) : []];
		const session = new AgentSession(this.service, folder, record.sessionId, servers, openLater, {
			// A project agent's session needs the project's server, which a spare never has.
			...(project ? {} : { spareKey: () => this.spareKey(folder) }),
			onDidOpenSession: servers => {
				this.browser?.bindSession(record.id, folder, servers);
				// Refill, for the next agent, which most likely starts in the same folder; not in an agent's own worktree.
				if (!this.model.agent(record.id)?.worktree) {
					this.prepareStart(folder, spareDelayMs);
				}
			},
		}, this.preferredModel(record));
		if (project) {
			session.permissions.answerAtOnce = request => this.projects.instantAnswer(this.model.agent(record.id) ?? record, request);
		}
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
				...(project?.role === 'coordinator' ? { project: this.projects.chatProject(record.id) } : {}),
				savedSessions: {
					inUse: () => new Set(this.model.snapshot().agents.flatMap(a => a.id !== record.id && a.sessionId ? [a.sessionId] : [])),
				},
				workspace: () => {
					const workspace = this.model.workspace(record.workspaceId);
					return workspace && { folder: workspace.folder, cwd: folder, worktree: !!this.model.agent(record.id)?.worktree };
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
				this.review.refresh();
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
		live.saveTimer = setTimeout(() => {
			live.saveTimer = undefined;
			void this.transcripts.save(id, { items: live.controller.conversation, changes: live.changes.files });
		}, saveDelayMs);
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
			this.model.rename(node.record.id, title.trim());
			const panel = this.live.get(node.record.id)?.panel;
			if (panel) {
				panel.title = title.trim();
			}
			if (this.focusedId === node.record.id) {
				this.focus(node.record.id);
			}
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
			this.model.removeAgent(node.record.id);
			void this.transcripts.delete(node.record.id);
			this.browser?.closeAgent(node.record.id);
		}
	}

	private async removeWorktreeAgent(record: AgentRecord, worktree: AgentWorktree): Promise<void> {
		const workspace = this.model.workspace(record.workspaceId);
		const repository = workspace && await repositoryRoot(workspace.folder);
		const status = repository ? await worktreeStatus(worktree, worktree.base).catch(() => undefined) : undefined;
		const unsaved = [
			status?.commits === 1 ? vscode.l10n.t("1 commit not in {0}", worktree.base) : status?.commits ? vscode.l10n.t("{0} commits not in {1}", status.commits, worktree.base) : undefined,
			status?.uncommitted === 1 ? vscode.l10n.t("1 uncommitted changed file") : status?.uncommitted ? vscode.l10n.t("{0} uncommitted changed files", status.uncommitted) : undefined,
		].filter(Boolean).join(', ');
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
				this.browser?.closeAgent(agent.id);
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
			this.persist();
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

/** `branch`, or `branch-2`, `branch-3`... when taken. */
async function freeBranchName(repository: string, branch: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? branch : `${branch}-${n}`;
		if (!await branchExists(repository, candidate)) {
			return candidate;
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, ChangeTotals, formatCounts } from '../acp/agentChanges';
import { attentionChange, waitingCount } from '../acp/attention';
import { branchNameFrom, isValidBranchName } from '../acp/branchNames';
import { AgentRecord, AgentsModel, AgentsSnapshot, WorkspaceRecord } from '../acp/agents';
import { FolderFileIndex } from '../acp/folderFiles';
import { readGitHead } from '../acp/gitHead';
import { errorMessage } from '../acp/errors';
import { memoizeAsync } from '../acp/memoize';
import { reviewRequest, workingChanges } from '../acp/reviewPrompt';
import { TranscriptStore } from '../acp/transcriptStore';
import { AgentWorktree, branchExists, commitAll, createWorktree, currentBranch, folderInRepository, mergeBranch, removeWorktree, repositoryRoot, worktreeStatus } from '../acp/worktrees';
import { AgentNotifier } from './agentNotifier';
import { AgentService } from './agentService';
import { AgentSession } from './agentSession';
import { ChangesSource, ChangesView } from './changesView';
import type { AgentStateKind } from './panelProtocol';
import { ReviewController } from './reviewController';
import { ChatActivity, ChatController, FileSearch } from './chatController';
import { configSection } from './configuration';
import { DiffPreview } from './diffPreview';
import { besideAgent } from './editorPlacement';
import { escapeMarkdown } from './markdown';
import { WorkspaceFileIndex } from './workspaceFiles';

const agentsViewId = 'gemini.agents';
const agentPanelType = 'gemini.agent';
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

type Node = WorkspaceNode | AgentNode;

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
	private readonly changesView: ChangesView;
	/** Keep and Undo on each agent change, in the files themselves. */
	readonly review: ReviewController;
	/** The agent whose tab was last in front; the Changes view shows it. */
	private focusedId: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly tree: vscode.TreeView<Node>;
	private readonly notifier = new AgentNotifier();
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
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
	private persistTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly service: AgentService,
		private readonly diffPreview: DiffPreview,
		private readonly workspaceFiles: WorkspaceFileIndex,
	) {
		this.model = new AgentsModel(context.globalState.get<AgentsSnapshot>(storageKey));
		this.transcripts = new TranscriptStore(vscode.Uri.joinPath(context.globalStorageUri, 'agents').fsPath);
		this.tree = vscode.window.createTreeView(agentsViewId, { treeDataProvider: this, showCollapseAll: false });
		this.changesView = new ChangesView(id => this.live.get(id)?.changes);
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
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.notifications`) && this.refresh()),
			// Relative times go stale; refresh them only while the pane is visible.
			this.tree.onDidChangeVisibility(e => this.setRefreshing(e.visible)),
			vscode.commands.registerCommand('gemini.agents.newAgent', (node?: Node) => this.newAgent(node)),
			vscode.commands.registerCommand('gemini.agents.newAgentOnBranch', (node?: Node) => this.newAgent(node, true)),
			vscode.commands.registerCommand('gemini.agents.mergeBack', (node?: Node) => node?.kind === 'agent' && this.mergeBack(node.record.id)),
			vscode.commands.registerCommand('gemini.reviewChanges', (source?: { readonly rootUri?: vscode.Uri }) => this.reviewChanges(source)),
			vscode.commands.registerCommand('gemini.agents.addWorkspace', () => this.addWorkspace()),
			vscode.commands.registerCommand('gemini.agents.open', (id: string) => this.open(id)),
			vscode.commands.registerCommand('gemini.agents.openChanges', (node?: Node) => node?.kind === 'agent' && this.openChanges(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.rename', (node?: Node) => this.rename(node)),
			vscode.commands.registerCommand('gemini.agents.stop', (node?: Node) => node?.kind === 'agent' && this.stopTurn(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.remove', (node?: Node) => this.removeAgent(node)),
			vscode.commands.registerCommand('gemini.agents.removeWorkspace', (node?: Node) => this.removeWorkspace(node)),
		);
		this.setRefreshing(this.tree.visible);
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
		return node.kind === 'workspace' ? this.workspaceItem(node) : this.agentItem(node);
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			return this.workspaceNodes();
		}
		if (node.kind === 'workspace' && node.record) {
			return this.model.agentsIn(node.record.id).map(record => ({ kind: 'agent', record, folder: record.worktree?.cwd ?? node.folder }));
		}
		return [];
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
		const hasAgents = !!node.record && this.model.agentsIn(node.record.id).length > 0;
		const item = new vscode.TreeItem(path.basename(node.folder) || node.folder, hasAgents ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// The id changes with the expander, so a workspace that gets its first agent opens.
		item.id = `workspace:${node.folder}:${hasAgents}`;
		item.description = tildify(path.dirname(node.folder));
		item.tooltip = node.folder;
		item.iconPath = new vscode.ThemeIcon(node.current ? 'root-folder-opened' : 'folder');
		// `.git` offers New Agent on Its Own Branch.
		const inGit = await this.branchOf(node.folder).then(Boolean, () => false);
		item.contextValue = `${node.current ? 'workspace.current' : 'workspace'}${inGit ? '.git' : ''}`;
		return item;
	}

	private async agentItem(node: AgentNode): Promise<vscode.TreeItem> {
		const { record } = node;
		const live = this.live.get(record.id);
		const item = new vscode.TreeItem(record.title, vscode.TreeItemCollapsibleState.None);
		item.id = `agent:${record.id}`;
		const branch = await this.branchOf(node.folder).catch(() => undefined);
		const changes = live?.changes.totals ?? record.changes;
		const state = this.agentState(live);
		const statusLine = state.kind === 'working' || state.kind === 'waiting' ? state.status : undefined;
		item.description = [statusLine ?? (changes?.files ? formatCounts(changes) : undefined), relativeTime(record.updatedAt, Date.now()), branch].filter(Boolean).join(' · ');
		item.iconPath = state.icon;
		const where = record.worktree
			? vscode.l10n.t("On its own branch {0}, in {1}", escapeMarkdown(record.worktree.branch), escapeMarkdown(tildify(record.worktree.folder)))
			: `${escapeMarkdown(node.folder)}${branch ? ` (${escapeMarkdown(branch)})` : ''}`;
		item.tooltip = new vscode.MarkdownString(`**${escapeMarkdown(record.title)}**\n\n${escapeMarkdown(state.status)}\n\n${where}`);
		item.contextValue = `${live?.activity.busy ? 'agent.busy' : 'agent'}${record.worktree ? '.worktree' : ''}${changes?.files ? '.changes' : ''}`;
		item.command = { command: 'gemini.agents.open', title: vscode.l10n.t("Open Agent"), arguments: [record.id] };
		item.accessibilityInformation = { label: `${record.title}, ${state.status}` };
		return item;
	}

	private agentState(live: LiveAgent | undefined): { kind: AgentStateKind; icon: vscode.ThemeIcon; status: string } {
		const step = live?.activity.step;
		if (live?.session.status.phase === 'error') {
			return { kind: 'error', icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')), status: vscode.l10n.t("Needs attention") };
		}
		if (live?.activity.needsPermission) {
			return { kind: 'waiting', icon: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow')), status: step ? vscode.l10n.t("Needs you: {0}", step) : vscode.l10n.t("Waiting for your permission") };
		}
		if (live?.activity.busy) {
			return { kind: 'working', icon: new vscode.ThemeIcon('loading~spin'), status: step ?? vscode.l10n.t("Working") };
		}
		if (live?.unread) {
			return { kind: 'done', icon: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')), status: vscode.l10n.t("Done") };
		}
		return live
			? { kind: 'idle', icon: new vscode.ThemeIcon('comment-discussion'), status: vscode.l10n.t("Idle") }
			: { kind: 'stopped', icon: new vscode.ThemeIcon('comment-discussion'), status: vscode.l10n.t("Paused \u00b7 open to continue") };
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

	/** Starts an agent in `folder` (on its own branch, named after the prompt, with `ownBranch`) and sends it `text`. */
	/** Returns whether the agent started; when not, the user has been told why. */
	async startWithPrompt(folder: string, text: string, ownBranch: boolean): Promise<boolean> {
		let worktree: AgentWorktree | undefined;
		if (ownBranch) {
			const repository = await repositoryRoot(folder);
			if (!repository) {
				void vscode.window.showErrorMessage(vscode.l10n.t("{0} is not in a Git repository, so the agent can't have its own branch.", path.basename(folder)));
				return false;
			}
			const branch = await freeBranchName(repository, branchNameFrom(text));
			try {
				worktree = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating the agent's branch...") },
					async () => createWorktree(repository, branch, await folderInRepository(folder)));
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
				return false;
			}
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"), worktree);
		await this.open(agent.id);
		await this.live.get(agent.id)?.controller.send(text);
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
	private refresh(): void {
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
		this.onDidChangeTreeDataEmitter.fire(undefined);
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
			return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Creating the agent's branch...") },
				async () => createWorktree(repository, branch.trim(), await folderInRepository(folder)));
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not create the agent's branch: {0}", errorMessage(err)));
			return undefined;
		}
	}

	/** Merges an agent's branch into what its workspace has checked out, committing its work first. */
	/** Merges an agent's branch into the branch its workspace has checked out. */
	async mergeBack(id: string): Promise<void> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		const worktree = record?.worktree;
		if (!record || !workspace || !worktree) {
			return;
		}
		const live = this.live.get(record.id);
		if (live?.activity.busy) {
			void vscode.window.showInformationMessage(vscode.l10n.t("\"{0}\" is still working. Merge back once it finishes.", record.title));
			return;
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
				return;
			}
			const detail = [
				status.commits === 1 ? vscode.l10n.t("1 commit") : status.commits ? vscode.l10n.t("{0} commits", status.commits) : undefined,
				status.uncommitted === 1 ? vscode.l10n.t("1 changed file not committed yet; it is committed first as \"{0}\"", record.title)
					: status.uncommitted ? vscode.l10n.t("{0} changed files not committed yet; they are committed first as \"{1}\"", status.uncommitted, record.title) : undefined,
			].filter(Boolean).join('\n');
			const merge = vscode.l10n.t("Merge");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Merge {0} into {1}?", worktree.branch, into), { modal: true, detail }, merge) !== merge) {
				return;
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
				return;
			}
			const done = vscode.l10n.t("Remove Agent and Branch");
			const keep = vscode.l10n.t("Keep Working");
			if (await vscode.window.showInformationMessage(vscode.l10n.t("Merged {0} into {1}.", worktree.branch, into), done, keep) === done) {
				await this.removeAgentAndWorktree(record.id, true);
			}
		} catch (err) {
			if (/Author identity unknown|Please tell me who you are/.test(errorMessage(err))) {
				void vscode.window.showErrorMessage(vscode.l10n.t("Could not merge {0}: Git doesn't know your name and email yet. Set them with git config --global user.name and user.email, then try again.", worktree.branch));
				return;
			}
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not merge {0}: {1}", worktree.branch, errorMessage(err)));
		}
	}

	/** Removes the agent, its worktree folder and, with `deleteBranch`, its branch. */
	private async removeAgentAndWorktree(id: string, deleteBranch: boolean): Promise<void> {
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		this.stop(id, false);
		this.model.removeAgent(id);
		void this.transcripts.delete(id);
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
			live = this.start(record, folder);
			if (record.updatedAt !== record.createdAt) {
				// Read while the tab opens; the agent reopens its session meanwhile.
				const started = live;
				void this.transcripts.load(id).then(saved => {
					// The agent may have been stopped while the file was read.
					if (this.live.get(id) !== started) {
						return;
					}
					started.controller.restore(saved.items, record.sessionId);
					started.changes.restore(saved.changes);
				});
			}
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
					this.refresh();
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
			});
		}
		this.focus(id);
		this.refresh();
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
			editorColumn: () => besideAgent(live.panel),
			busy: () => live.activity.busy,
			...(record.worktree ? { branch: record.worktree.branch, mergeBack: () => this.mergeBack(id) } : { commit: () => live.controller.commit() }),
		} : undefined;
	}

	private start(record: AgentRecord, folder: string): LiveAgent {
		const session = new AgentSession(this.service, folder, record.sessionId);
		const files: FileSearch = isOpenFolder(folder) ? this.workspaceFiles : new FolderFileIndex(folder);
		const changes = new AgentChanges(folder);
		const live: LiveAgent = {
			session,
			changes,
			controller: new ChatController(this.context.extensionUri, session, this.diffPreview, files, {
				reveal: preserveFocus => this.reveal(record.id, preserveFocus),
				editorColumn: () => besideAgent(this.live.get(record.id)?.panel),
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
				live.activity = activity;
				this.refresh();
			}),
			session.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.model.setSessionId(record.id, state.sessionId);
				}
			}),
			live.controller.onDidEditFiles(diffs => changes.record(diffs)),
			changes.onDidChange(() => {
				this.review.refresh();
				this.model.setChanges(record.id, changes.totals);
				this.scheduleSave(record.id, live);
				this.refresh();
			}),
			live.controller.onDidSendPrompt(text => {
				this.model.recordPrompt(record.id, text);
				const title = this.model.agent(record.id)?.title;
				if (live.panel && title) {
					live.panel.title = title;
				}
			}),
			session.onDidChangeStatus(() => this.refresh()),
		);
		this.live.set(record.id, live);
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
		for (const id of [...this.live.keys()]) {
			this.stop(id, true);
		}
		this.setRefreshing(false);
		clearTimeout(this.refreshTimeout);
		if (this.persistTimeout) {
			this.persist();
		}
		this.model.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

/** "now", "5m", "3h", "2d", "6w": short, like the screenshot's session list. */
export function relativeTime(then: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - then) / 60_000);
	if (minutes < 1) {
		return vscode.l10n.t("now");
	}
	if (minutes < 60) {
		return vscode.l10n.t("{0}m", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return vscode.l10n.t("{0}h", hours);
	}
	const days = Math.floor(hours / 24);
	return days < 7 ? vscode.l10n.t("{0}d", days) : vscode.l10n.t("{0}w", Math.floor(days / 7));
}

async function exists(folder: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(folder));
		return true;
	} catch {
		return false;
	}
}

function isOpenFolder(folder: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === folder);
}

export function tildify(folder: string): string {
	const home = os.homedir();
	return folder === home || folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
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

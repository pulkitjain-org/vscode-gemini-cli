/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's list: one list of workspaces, each with its projects
// (their threads and an Archived row under each), its agents (forks under
// the agent they came from) and an Archived row, each row with its state,
// and a clock that ticks only the rows of working agents.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeTotals, formatCounts } from '../../acp/agentChanges';
import { agentRowMeta } from '../../acp/agentRow';
import { workspaceRows, WorkspaceRows } from '../../acp/agentList';
import { agentFolder, AgentRecord, AgentsModel, isArchived, resolvedAt, WorkspaceRecord } from '../../acp/agents';
import { readGitHead } from '../../acp/gitHead';
import { memoizeAsync } from '../../acp/memoize';
import { canMoveToBranch } from '../../acp/moveToBranch';
import type { AgentStatus } from '../../acp/status';
import type { ChatActivity } from '../chatController';
import { relativeTime, tildify } from '../displayText';
import { escapeMarkdown } from '../markdown';
import type { AgentStateKind } from '../panelProtocol';
import { projectsEnabled } from '../projects';

const agentsViewId = 'gemini.agents';

/** A workspace row: one the user added, or a folder open in this window. */
export interface WorkspaceNode {
	readonly kind: 'workspace';
	readonly folder: string;
	/** Unset for an open folder that has no agents yet. */
	readonly record?: WorkspaceRecord;
	readonly current: boolean;
}

export interface AgentNode {
	readonly kind: 'agent';
	readonly record: AgentRecord;
	readonly folder: string;
}

/**
 * A project's threads merged over a week ago, or a workspace's agents the
 * user archived, collapsed under one row so the list stays short.
 */
type ArchiveNode = {
	readonly kind: 'archive';
	readonly folder: string;
	readonly count: number;
} & ({ readonly coordinator: AgentRecord; readonly workspace?: undefined } | { readonly workspace: WorkspaceRecord; readonly coordinator?: undefined });

export type AgentTreeNode = WorkspaceNode | AgentNode | ArchiveNode;

/** A workspace agents can start in. */
export interface WorkspaceSummary {
	readonly folder: string;
	/** In a Git repository, so an agent can have its own branch. */
	readonly git: boolean;
	/** Open in this window. */
	readonly current: boolean;
}

/** What the list shows of an agent running in this window. */
export interface LiveAgentView {
	readonly activity: ChatActivity;
	/** A turn finished while its tab was not in front. */
	readonly unread: boolean;
	readonly session: { readonly status: AgentStatus };
	readonly changes: { readonly totals: ChangeTotals };
}

export class AgentTree implements vscode.TreeDataProvider<AgentTreeNode>, vscode.Disposable {

	readonly view: vscode.TreeView<AgentTreeNode>;
	/** The agent rows last handed to the tree, so a clock tick redraws just those rows. */
	private readonly agentNodes = new Map<string, AgentNode>();
	/** Branch names are read from `.git/HEAD`; kept for a few seconds so a refresh reads each folder once. */
	private readonly branchOf = memoizeAsync(readGitHead, { ttlMs: 5_000, maxEntries: 100 });
	/** Ticks working agents' clocks once a second while the pane shows one. */
	private clockTimer: ReturnType<typeof setInterval> | undefined;

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<AgentTreeNode | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(
		private readonly model: AgentsModel,
		/** The agents running in this window. */
		private readonly live: ReadonlyMap<string, LiveAgentView>,
	) {
		this.view = vscode.window.createTreeView(agentsViewId, { treeDataProvider: this, showCollapseAll: false });
	}

	getTreeItem(node: AgentTreeNode): Promise<vscode.TreeItem> | vscode.TreeItem {
		switch (node.kind) {
			case 'workspace':
				return this.workspaceItem(node);
			case 'agent':
				return this.agentItem(node);
			case 'archive':
				return this.archiveItem(node);
		}
	}

	getChildren(node?: AgentTreeNode): AgentTreeNode[] {
		if (!node) {
			return this.workspaceNodes();
		}
		if (node.kind === 'workspace' && node.record) {
			const workspace = node.record;
			const { projects, agents, archived } = this.rowsOf(workspace.id);
			// Its projects first, each a row that opens on its threads; then its own agents.
			const rows: AgentTreeNode[] = [...projects.map(record => this.agentNode(record, node.folder)), ...agents.map(record => this.agentNode(record, node.folder))];
			if (archived.length) {
				rows.push({ kind: 'archive', workspace, folder: node.folder, count: archived.length });
			}
			return rows;
		}
		if (node.kind === 'archive' && node.workspace) {
			return this.rowsOf(node.workspace.id).archived.map(record => this.agentNode(record, node.folder));
		}
		if (node.kind === 'agent' && !node.record.project) {
			// Its forks, under it.
			return this.forksOf(node.record).map(record => {
				const agent: AgentNode = { kind: 'agent', record, folder: agentFolder(record, this.model.workspace(record.workspaceId)?.folder ?? node.folder) };
				this.agentNodes.set(record.id, agent);
				return agent;
			});
		}
		if (node.kind === 'agent' && node.record.project?.role === 'coordinator') {
			const now = Date.now();
			const threads = this.model.threadsOf(node.record.id);
			// A thread running in this window stays in the list, even if it was merged long ago.
			const archived = threads.filter(record => isArchived(record, now) && !this.live.has(record.id));
			const rows: AgentTreeNode[] = threads.filter(record => !archived.includes(record)).map(record => this.agentNode(record, node.folder));
			if (archived.length) {
				rows.push({ kind: 'archive', coordinator: node.record, folder: node.folder, count: archived.length });
			}
			return rows;
		}
		if (node.kind === 'archive' && node.coordinator) {
			const now = Date.now();
			// Most recently merged first: the one most likely looked for.
			return this.model.threadsOf(node.coordinator.id)
				.filter(record => isArchived(record, now) && !this.live.has(record.id))
				.sort((a, b) => resolvedAt(b) - resolvedAt(a))
				.map(record => this.agentNode(record, node.folder));
		}
		return [];
	}

	/** A row's parent, so the list can reveal and highlight the agent, project or thread whose tab is in front. */
	getParent(node: AgentTreeNode): AgentTreeNode | undefined {
		const projects = projectsEnabled();
		switch (node.kind) {
			case 'workspace':
				return undefined;
			case 'archive':
				if (node.workspace) {
					const current = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === node.workspace.folder);
					return { kind: 'workspace', folder: node.workspace.folder, record: node.workspace, current };
				}
				return this.agentNodes.get(node.coordinator.id) ?? { kind: 'agent', record: node.coordinator, folder: node.folder };
			case 'agent': {
				const { record } = node;
				const coordinator = projects && record.project?.role === 'thread' ? this.model.coordinatorOf(record) : undefined;
				if (coordinator) {
					const folder = this.model.workspace(coordinator.workspaceId)?.folder ?? node.folder;
					return this.agentNodes.get(coordinator.id) ?? { kind: 'agent', record: coordinator, folder };
				}
				const parent = this.model.parentOf(record);
				if (parent && !parent.project) {
					const folder = this.model.workspace(parent.workspaceId)?.folder ?? node.folder;
					return this.agentNodes.get(parent.id) ?? { kind: 'agent', record: parent, folder: agentFolder(parent, folder) };
				}
				const workspace = this.model.workspace(record.workspaceId);
				if (!workspace) {
					return undefined;
				}
				const { archived } = this.rowsOf(workspace.id);
				if (archived.includes(record)) {
					return { kind: 'archive', workspace, folder: workspace.folder, count: archived.length };
				}
				const current = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === workspace.folder);
				return { kind: 'workspace', folder: workspace.folder, record: workspace, current };
			}
			default:
				return undefined;
		}
	}

	/** Highlights the row of agent `id` (its tab came to the front), without taking focus from the chat. */
	revealAgent(id: string): void {
		const node = this.agentNodes.get(id);
		if (node && this.view.visible && this.view.selection[0] !== node) {
			void Promise.resolve(this.view.reveal(node, { select: true, focus: false, expand: false })).catch(() => undefined);
		}
	}

	/** The open folders first, then the workspaces the user added. */
	workspaceNodes(): WorkspaceNode[] {
		const open = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
		const nodes: WorkspaceNode[] = open.map(folder => ({ kind: 'workspace', folder, record: this.model.workspaceFor(folder), current: true }));
		for (const record of this.model.workspaces) {
			if (!nodes.some(n => n.record?.id === record.id)) {
				nodes.push({ kind: 'workspace', folder: record.folder, record, current: false });
			}
		}
		return nodes;
	}

	/** The workspaces a new agent can start in: the open folders first. */
	async workspaces(): Promise<WorkspaceSummary[]> {
		return Promise.all(this.workspaceNodes().map(async node => ({
			folder: node.folder, current: node.current, git: await this.inGit(node.folder),
		})));
	}

	/** Whether `folder` is in a Git repository, so an agent there can have its own branch. */
	inGit(folder: string): Promise<boolean> {
		return this.branchOf(folder).then(Boolean, () => false);
	}

	/** Redraws the whole list, or only the rows of agents `ids`; the whole list when one of them has no row yet. */
	redraw(ids: readonly string[] | undefined): void {
		const rows = (ids ?? []).map(id => this.agentNodes.get(id));
		if (!ids || rows.some(node => !node)) {
			this.agentNodes.clear();
			this.onDidChangeTreeDataEmitter.fire(undefined);
		} else {
			// Only these agents changed state: redraw their rows, not the whole tree.
			for (const node of rows) {
				this.onDidChangeTreeDataEmitter.fire(node);
			}
		}
	}

	/** Runs the clock tick while the pane is visible and an agent works; it redraws only those rows. */
	updateClock(): void {
		const ticking = this.view.visible && this.workingIds().length > 0;
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

	dispose(): void {
		clearInterval(this.clockTimer);
		this.view.dispose();
		this.onDidChangeTreeDataEmitter.dispose();
	}

	/** Agents working now (not waiting on the user), whose rows show a running clock. */
	private workingIds(): string[] {
		return [...this.live].filter(([, live]) => live.activity.busy && !live.activity.needsPermission && live.session.status.phase !== 'error').map(([id]) => id);
	}

	/** The row of an agent in `folder` (its own folder when it has one), remembered for redraws. */
	private agentNode(record: AgentRecord, folder: string): AgentNode {
		const agent: AgentNode = { kind: 'agent', record, folder: agentFolder(record, folder) };
		this.agentNodes.set(record.id, agent);
		return agent;
	}

	/** What a workspace lists: its projects, its own agents and the archived ones (`agentList.ts`). */
	private rowsOf(workspaceId: string): WorkspaceRows {
		return workspaceRows(this.model, workspaceId, { projects: projectsEnabled(), live: id => this.live.has(id), now: Date.now() });
	}

	private archiveItem(node: ArchiveNode): vscode.TreeItem {
		const item = new vscode.TreeItem(vscode.l10n.t("Archived"), vscode.TreeItemCollapsibleState.Collapsed);
		item.id = node.workspace ? `archive:workspace:${node.workspace.id}` : `archive:${node.coordinator.id}`;
		item.description = String(node.count);
		item.iconPath = new vscode.ThemeIcon('archive');
		item.tooltip = node.workspace
			? vscode.l10n.t("Agents you archived. Each keeps its chat and undo history: open one to pick it up again.")
			: vscode.l10n.t("Threads merged over a week ago. Each keeps its chat and branch: open one to pick it up again.");
		item.contextValue = 'archive';
		return item;
	}

	/** An agent's forks, most recently used first, as a workspace lists its agents. */
	private forksOf(record: AgentRecord): AgentRecord[] {
		return [...this.model.forksOf(record.id)].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private async workspaceItem(node: WorkspaceNode): Promise<vscode.TreeItem> {
		const rows = node.record ? this.rowsOf(node.record.id) : undefined;
		const hasAgents = !!rows && rows.projects.length + rows.agents.length + rows.archived.length > 0;
		const item = new vscode.TreeItem(path.basename(node.folder) || node.folder, hasAgents ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// The id changes with the expander, so a workspace that gets its first agent opens.
		item.id = `workspace:${node.folder}:${hasAgents}`;
		// Just the name, as a heading over its agents; the path is in the tooltip.
		item.tooltip = tildify(node.folder);
		// Agents mode draws workspaces as headings by this icon (geminiModes.css).
		item.iconPath = new vscode.ThemeIcon('folder');
		// `.git` offers New Agent on Its Own Branch.
		const inGit = await this.inGit(node.folder);
		item.contextValue = `${node.current ? 'workspace.current' : 'workspace'}${inGit ? '.git' : ''}`;
		return item;
	}

	private async agentItem(node: AgentNode): Promise<vscode.TreeItem> {
		const { record } = node;
		const live = this.live.get(record.id);
		const coordinator = record.project?.role === 'coordinator';
		const threads = coordinator ? this.model.threadsOf(record.id).length : record.project ? 0 : this.model.forksOf(record.id).length;
		const item = new vscode.TreeItem(record.title, threads ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// The id changes with the expander, so a project that gets its first thread, or an agent its first fork, opens.
		item.id = `agent:${record.id}${threads ? ':threads' : ''}`;
		const branch = await this.branchOf(node.folder).catch(() => undefined);
		const changes = live?.changes.totals ?? record.changes;
		const state = agentState(record, live);
		item.description = rowMeta(record, live, state.kind, changes);
		item.iconPath = coordinator && (state.kind === 'idle' || state.kind === 'stopped') ? new vscode.ThemeIcon('comment-discussion') : state.icon;
		const parent = this.model.parentOf(record);
		const where = record.worktree
			? vscode.l10n.t("On its own branch {0}, in {1}", escapeMarkdown(record.worktree.branch), escapeMarkdown(tildify(record.worktree.folder)))
			: record.forkedFrom?.sharedFolder
				? vscode.l10n.t("In the folder of the agent it was forked from, {0}", escapeMarkdown(tildify(record.forkedFrom.sharedFolder)))
				: `${escapeMarkdown(tildify(node.folder))}${branch ? ` (${escapeMarkdown(branch)})` : ''}`;
		const forked = parent ? `\n\n${vscode.l10n.t("Forked from \"{0}\"", escapeMarkdown(parent.title))}` : '';
		const counts = changes?.files ? `\n\n${escapeMarkdown(formatCounts(changes))}` : '';
		item.tooltip = new vscode.MarkdownString(`**${escapeMarkdown(record.title)}**\n\n${escapeMarkdown(state.status)}${counts}\n\n${where}${forked}`);
		// A coordinator isn't forked, nor yet a thread in several repositories; any other thread forks as a new thread.
		const forkable = record.project?.role !== 'coordinator' && !record.repos?.length;
		// `.movable` offers Move to its own branch: it works in the user's checkout of a Git folder.
		const movable = canMoveToBranch(record, !!branch);
		item.contextValue = `${live?.activity.busy ? 'agent.busy' : 'agent'}${record.worktree ? '.worktree' : ''}${forkable ? '.forkable' : ''}${movable ? '.movable' : ''}${changes?.files ? '.changes' : ''}${record.project?.role === 'coordinator' ? '.project' : ''}${record.tried?.state === 'trying' ? '.trying' : ''}`;
		item.command = { command: 'gemini.agents.open', title: vscode.l10n.t("Open Agent"), arguments: [record.id] };
		item.accessibilityInformation = { label: `${record.title}, ${state.status}` };
		return item;
	}
}

/** Each state's icon is a dot in its colour, or a spinner while the agent works. */
export function agentState(record: AgentRecord, live: LiveAgentView | undefined): { kind: AgentStateKind; icon: vscode.ThemeIcon; status: string } {
	const step = live?.activity.step;
	if (live?.session.status.phase === 'error') {
		return { kind: 'error', icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground')), status: vscode.l10n.t("Needs attention") };
	}
	if (live?.activity.needsPermission) {
		return { kind: 'waiting', icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow')), status: step ? vscode.l10n.t("Needs you: {0}", step) : vscode.l10n.t("Needs you") };
	}
	if (live?.activity.busy) {
		return { kind: 'working', icon: new vscode.ThemeIcon('loading~spin'), status: step ?? vscode.l10n.t("Working") };
	}
	if (live?.unread) {
		return { kind: 'done', icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green')), status: vscode.l10n.t("Done") };
	}
	const quiet = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('descriptionForeground'));
	// Kept or merged: the one word every surface uses for an agent on a branch whose work was taken.
	if (record.resolved) {
		return { kind: 'kept', icon: new vscode.ThemeIcon('check', new vscode.ThemeColor('descriptionForeground')), status: record.resolved.kind === 'merged' ? vscode.l10n.t("Merged") : vscode.l10n.t("Kept") };
	}
	return live
		? { kind: 'idle', icon: quiet, status: vscode.l10n.t("Done") }
		: { kind: 'stopped', icon: quiet, status: vscode.l10n.t("Paused \u00b7 open to continue") };
}

/** The row's note after the title: the turn's clock, "needs you", lines added, or how old it is. */
function rowMeta(record: AgentRecord, live: LiveAgentView | undefined, state: AgentStateKind, changes: ChangeTotals | undefined): string {
	const meta = agentRowMeta({ state, startedAt: live?.activity.startedAt, added: changes?.added }, Date.now());
	switch (meta.kind) {
		case 'clock':
		case 'added':
			return meta.text;
		case 'waiting':
			return vscode.l10n.t("needs you");
		case 'age':
			return relativeTime(record.updatedAt, Date.now());
	}
}

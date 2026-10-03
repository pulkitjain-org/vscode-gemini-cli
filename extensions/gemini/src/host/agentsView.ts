/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges, formatCounts } from '../acp/agentChanges';
import { branchNameFrom } from '../acp/branchNames';
import { AgentRecord, AgentsModel, AgentsSnapshot, WorkspaceRecord } from '../acp/agents';
import { FolderFileIndex } from '../acp/folderFiles';
import { readGitHead } from '../acp/gitHead';
import { memoizeAsync } from '../acp/memoize';
import { TranscriptStore } from '../acp/transcriptStore';
import { AgentService } from './agentService';
import { AgentSession } from './agentSession';
import { ChangesSource, ChangesView } from './changesView';
import { ChatActivity, ChatController, FileSearch } from './chatController';
import { DiffPreview } from './diffPreview';
import { WorkspaceFileIndex } from './workspaceFiles';

export const agentsViewId = 'gemini.agents';
const agentPanelType = 'gemini.agent';
const storageKey = 'gemini.agents';

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
	/** The agent whose tab was last in front; the Changes view shows it. */
	private focusedId: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly tree: vscode.TreeView<Node>;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	/** Branch names are read from `.git/HEAD`; kept for a few seconds so a refresh reads each folder once. */
	private readonly branchOf = memoizeAsync(readGitHead, { ttlMs: 5_000, maxEntries: 100 });

	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

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
		this.disposables.push(
			this.tree,
			this.changesView,
			this.onDidChangeTreeDataEmitter,
			toDisposable(this.model.onDidChange(() => {
				void context.globalState.update(storageKey, this.model.snapshot());
				this.refresh();
			})),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			// Relative times go stale; refresh them only while the pane is visible.
			this.tree.onDidChangeVisibility(e => this.setRefreshing(e.visible)),
			vscode.commands.registerCommand('gemini.agents.newAgent', (node?: Node) => this.newAgent(node)),
			vscode.commands.registerCommand('gemini.agents.addWorkspace', () => this.addWorkspace()),
			vscode.commands.registerCommand('gemini.agents.open', (id: string) => this.open(id)),
			vscode.commands.registerCommand('gemini.agents.openChanges', (node?: Node) => node?.kind === 'agent' && this.openChanges(node.record.id)),
			vscode.commands.registerCommand('gemini.agents.rename', (node?: Node) => this.rename(node)),
			vscode.commands.registerCommand('gemini.agents.stop', (node?: Node) => node?.kind === 'agent' && this.live.get(node.record.id)?.session.cancel()),
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
			return this.model.agentsIn(node.record.id).map(record => ({ kind: 'agent', record, folder: node.folder }));
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

	private workspaceItem(node: WorkspaceNode): vscode.TreeItem {
		const hasAgents = !!node.record && this.model.agentsIn(node.record.id).length > 0;
		const item = new vscode.TreeItem(path.basename(node.folder) || node.folder, hasAgents ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		// The id changes with the expander, so a workspace that gets its first agent opens.
		item.id = `workspace:${node.folder}:${hasAgents}`;
		item.description = tildify(path.dirname(node.folder));
		item.tooltip = node.folder;
		item.iconPath = new vscode.ThemeIcon(node.current ? 'root-folder-opened' : 'folder');
		item.contextValue = node.current ? 'workspace.current' : 'workspace';
		return item;
	}

	private async agentItem(node: AgentNode): Promise<vscode.TreeItem> {
		const { record } = node;
		const live = this.live.get(record.id);
		const item = new vscode.TreeItem(record.title, vscode.TreeItemCollapsibleState.None);
		item.id = `agent:${record.id}`;
		const branch = await this.branchOf(node.folder).catch(() => undefined);
		const changes = live?.changes.totals ?? record.changes;
		item.description = [changes?.files ? formatCounts(changes) : undefined, relativeTime(record.updatedAt, Date.now()), branch].filter(Boolean).join(' · ');
		const state = this.agentState(live);
		item.iconPath = state.icon;
		item.tooltip = new vscode.MarkdownString(`**${escapeMarkdown(record.title)}**\n\n${escapeMarkdown(state.label)}\n\n${escapeMarkdown(node.folder)}${branch ? ` (${escapeMarkdown(branch)})` : ''}`);
		item.contextValue = `${live?.activity.busy ? 'agent.busy' : 'agent'}${changes?.files ? '.changes' : ''}`;
		item.command = { command: 'gemini.agents.open', title: vscode.l10n.t("Open Agent"), arguments: [record.id] };
		item.accessibilityInformation = { label: `${record.title}, ${state.label}` };
		return item;
	}

	private agentState(live: LiveAgent | undefined): { icon: vscode.ThemeIcon; label: string } {
		if (live?.session.status.phase === 'error') {
			return { icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')), label: vscode.l10n.t("Needs attention") };
		}
		if (live?.activity.needsPermission) {
			return { icon: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow')), label: vscode.l10n.t("Waiting for your permission") };
		}
		if (live?.activity.busy) {
			return { icon: new vscode.ThemeIcon('loading~spin'), label: vscode.l10n.t("Working") };
		}
		if (live?.unread) {
			return { icon: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')), label: vscode.l10n.t("Done") };
		}
		return { icon: new vscode.ThemeIcon('comment-discussion'), label: live ? vscode.l10n.t("Idle") : vscode.l10n.t("Not started in this window") };
	}

	private refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
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

	private async newAgent(node: Node | undefined): Promise<void> {
		const folder = node?.kind === 'workspace' ? node.folder : node?.kind === 'agent' ? node.folder : await this.pickFolder();
		if (!folder) {
			return;
		}
		const workspace = this.model.addWorkspace(folder);
		const agent = this.model.addAgent(workspace.id, vscode.l10n.t("New agent"));
		await this.open(agent.id);
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
			live = this.start(record, workspace.folder);
			if (record.updatedAt !== record.createdAt) {
				// Read while the tab opens; the agent reopens its session meanwhile.
				const started = live;
				void this.transcripts.load(id).then(saved => {
					started.controller.restore(saved.items, record.sessionId);
					started.changes.restore(saved.changes);
				});
			}
		}
		live.unread = false;
		if (live.panel) {
			live.panel.reveal();
		} else {
			const panel = vscode.window.createWebviewPanel(agentPanelType, record.title, vscode.ViewColumn.Active, {
				enableScripts: true,
				// Switching tabs then costs no re-render of a long conversation.
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			});
			panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gemini.svg');
			live.panel = panel;
			live.controller.attach(panel.webview);
			panel.onDidChangeViewState(e => {
				if (e.webviewPanel.active) {
					this.focus(id);
				}
				if (e.webviewPanel.active && live.unread) {
					live.unread = false;
					this.refresh();
				}
			});
			panel.onDidDispose(() => {
				live.controller.detach(panel.webview);
				if (live.panel === panel) {
					live.panel = undefined;
				}
			});
		}
		this.focus(id);
		this.refresh();
	}

	/** Opens the agent's changes in the multi-diff editor, starting it to read them if needed. */
	private async openChanges(id: string): Promise<void> {
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
		this.changesView.show(this.changesSource(id));
	}

	private changesSource(id: string): ChangesSource | undefined {
		const live = this.live.get(id);
		const record = this.model.agent(id);
		const workspace = record && this.model.workspace(record.workspaceId);
		return live && workspace ? { agentId: id, title: record.title, folder: workspace.folder, changes: live.changes } : undefined;
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
				git: {
					folder: () => folder,
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
				if (!activity.busy) {
					this.scheduleSave(record.id, live);
				}
				live.activity = activity;
				this.refresh();
			}),
			toDisposable(session.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					this.model.setSessionId(record.id, state.sessionId);
				}
			})),
			live.controller.onDidEditFiles(diffs => changes.record(diffs)),
			toDisposable(changes.onDidChange(() => {
				this.model.setChanges(record.id, changes.totals);
				this.scheduleSave(record.id, live);
				this.refresh();
			})),
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
		if (node?.kind !== 'agent') {
			return;
		}
		const remove = vscode.l10n.t("Remove");
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove the agent \"{0}\"? Its conversation is closed.", node.record.title), { modal: true }, remove);
		if (answer === remove) {
			this.stop(node.record.id, false);
			this.model.removeAgent(node.record.id);
			void this.transcripts.delete(node.record.id);
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
		if (await vscode.window.showWarningMessage(message, { modal: true }, remove) === remove) {
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
		// Saved already unless a save is pending or a turn runs.
		if (save && (live.saveTimer !== undefined || live.activity.busy)) {
			void this.transcripts.save(id, { items: live.controller.conversation, changes: live.changes.files });
		}
		clearTimeout(live.saveTimer);
		if (this.focusedId === id) {
			this.focusedId = undefined;
			this.changesView.show(undefined);
		}
		live.panel?.dispose();
		void live.session.cancel();
		vscode.Disposable.from(...live.disposables).dispose();
		live.controller.dispose();
		live.changes.dispose();
		live.session.dispose();
	}

	dispose(): void {
		for (const id of [...this.live.keys()]) {
			this.stop(id, true);
		}
		this.setRefreshing(false);
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

function isOpenFolder(folder: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === folder);
}

function tildify(folder: string): string {
	const home = os.homedir();
	return folder === home || folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function toDisposable(listener: { dispose(): void }): vscode.Disposable {
	return new vscode.Disposable(() => listener.dispose());
}

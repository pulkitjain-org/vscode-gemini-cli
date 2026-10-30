/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The editor tab per agent: opening one (starting the agent's session in
// this window, with its saved chat shown first), which agent is in front or
// was last in front (the Changes view follows it), its changes, Rename and
// Fork from its row, and its conversation as Markdown.

import * as vscode from 'vscode';
import { agentFolder, AgentRecord, AgentsModel } from '../../acp/agents';
import { savedRepoCount } from '../../acp/projectStore';
import type { CheckpointStore } from '../../acp/checkpointStore';
import type { TranscriptStore } from '../../acp/transcriptStore';
import { coordinatorHome } from '../../acp/worktrees';
import type { AgentNotifier } from '../agentNotifier';
import type { AgentsView } from '../agentsView';
import type { ChangesSource, ChangesView } from '../changesView';
import { ChatController, openChatAsMarkdown } from '../chatController';
import { tildify } from '../displayText';
import { agentColumn, agentsColumn, closeAgentFiles } from '../editorPlacement';
import { Projects, projectsEnabled } from '../projects';
import type { AgentIndicators } from './agentIndicators';
import type { AgentProjects } from './agentProjects';
import type { AgentStarter, LiveAgent } from './agentStart';
import type { AgentTree, AgentTreeNode } from './agentTree';
import type { AgentWorktrees } from './agentWorktrees';
import { showError } from '../errorNotice';

const agentPanelType = 'gemini.agent';

/** What the agents' tabs reach into the Agents pane for. */
export interface AgentTabsHost {
	readonly extensionUri: vscode.Uri;
	readonly model: AgentsModel;
	/** The agents running in this window. */
	readonly live: ReadonlyMap<string, LiveAgent>;
	readonly tree: Pick<AgentTree, 'view' | 'revealAgent'>;
	readonly worktrees: Pick<AgentWorktrees, 'restoreFolder'>;
	readonly projects: Pick<Projects, 'ready'>;
	readonly projectAgents: Pick<AgentProjects, 'ensureProjectTrust' | 'linkRules'>;
	readonly starter: Pick<AgentStarter, 'start'>;
	readonly transcripts: Pick<TranscriptStore, 'load'>;
	readonly checkpointFiles: Pick<CheckpointStore, 'load'>;
	readonly notifier: Pick<AgentNotifier, 'clear'>;
	readonly indicators: Pick<AgentIndicators, 'tabIcon' | 'restingTabIcon' | 'tabClosed'>;
	readonly changesView: Pick<ChangesView, 'show' | 'openAll'>;
	/** The pane's own surface the tabs call back into: the Try button of an agent's changes. */
	readonly view: Pick<AgentsView, 'mergeBack' | 'tryChoiceOf' | 'chooseTry' | 'mergeRequests' | 'tryAction'>;
	/** The agent whose changes show changed; Agents mode's Changes panel follows it. */
	focusChanged(source: ChangesSource | undefined): void;
	/** Redraws the list, or agent `id`'s row. */
	refresh(id?: string): void;
	/** Whether the extension shuts down, when closing agent tabs must not close their files. */
	disposing(): boolean;
}

export class AgentTabs {

	/** The agent whose tab was last in front; the Changes view shows it. */
	private _focusedId: string | undefined;

	constructor(private readonly host: AgentTabsHost) { }

	/** The agent whose tab was last in front, if any. */
	get focusedId(): string | undefined {
		return this._focusedId;
	}

	/** Opens agent `id`'s conversation as Markdown; one not running in this window is read from its saved file. */
	async openAsMarkdown(id: string): Promise<void> {
		const record = this.host.model.agent(id);
		const live = this.host.live.get(id);
		const items = live ? live.controller.conversation : (await this.host.transcripts.load(id)).items;
		await openChatAsMarkdown(record?.title ?? vscode.l10n.t("Agent"), items, live ? await agentColumn(id, live.panel) : undefined);
	}

	/** The agent whose tab is in front, if any. */
	activeAgentId(): string | undefined {
		for (const [id, agent] of this.host.live) {
			if (agent.panel?.active) {
				return id;
			}
		}
		return undefined;
	}

	/** The agent whose tab is in front, else the one last in front while it is still in the list. */
	agentLastInFront(): string | undefined {
		return this.activeAgentId() ?? (this._focusedId && this.host.model.agent(this._focusedId) ? this._focusedId : undefined);
	}

	/** The chat of the agent whose tab is in front, else the one last in front. */
	chatInFront(): ChatController | undefined {
		const id = this.activeAgentId() ?? this._focusedId;
		return id ? this.host.live.get(id)?.controller : undefined;
	}

	/** Puts the cursor in the message box of the agent in front (or last in front), opening its tab; with no agent yet, starts one. */
	async focusChat(): Promise<void> {
		const id = this.agentLastInFront();
		if (!id) {
			await vscode.commands.executeCommand('gemini.agents.newAgent');
			return;
		}
		await this.open(id);
		this.host.live.get(id)?.controller.focusComposer();
	}

	/** The chat in the agent tab that is in front, if any. */
	activeController(): ChatController | undefined {
		for (const agent of this.host.live.values()) {
			if (agent.panel?.active) {
				return agent.controller;
			}
		}
		return undefined;
	}

	/** Opens the agent's tab, starting its session if it has none in this window. */
	async open(id: string): Promise<void> {
		const host = this.host;
		const record = host.model.agent(id);
		const workspace = record && host.model.workspace(record.workspaceId);
		if (!record || !workspace) {
			return;
		}
		let live = host.live.get(id);
		if (!live) {
			const folder = agentFolder(record, workspace.folder);
			// A merged thread's folder may have been cleaned up: it comes back from its branch.
			if (record.worktree && !await host.worktrees.restoreFolder(id)) {
				void showError(vscode.l10n.t("The folder of \"{0}\"'s branch, {1}, no longer exists.", record.title, tildify(record.worktree.folder)));
				return;
			}
			if (record.project && projectsEnabled()) {
				// Its session gets the project's tools, so their server must listen first, in a folder the CLI trusts.
				await host.projects.ready();
				const coordinatorId = record.project.role === 'coordinator' ? record.id : record.project.coordinator;
				await host.projectAgents.ensureProjectTrust(workspace.folder, !!record.repos?.length || await savedRepoCount(coordinatorHome(coordinatorId)) > 1);
				if (record.project.role === 'coordinator') {
					await host.projectAgents.linkRules(workspace.folder, coordinatorHome(record.id), 'coordinator');
				}
			}
			live = host.live.get(id) ?? this.startSaved(record, folder);
		}
		live.unread = false;
		host.notifier.clear(id);
		// Beside the other agents, never in one agent's side group.
		const viewColumn = live.panel ? undefined : await agentsColumn();
		if (live.panel) {
			live.panel.reveal();
		} else {
			const panel = vscode.window.createWebviewPanel(agentPanelType, record.title, viewColumn ?? vscode.ViewColumn.Active, {
				enableScripts: true,
				// Switching tabs then costs no re-render of a long conversation.
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(host.extensionUri, 'media')],
			});
			panel.iconPath = host.indicators.tabIcon(id, host.indicators.restingTabIcon(id));
			live.panel = panel;
			// A disposed panel throws on `.webview`, so keep the webview for detaching.
			const webview = panel.webview;
			live.controller.attach(webview);
			panel.onDidChangeViewState(e => {
				live.controller.setHidden(!e.webviewPanel.visible);
				if (e.webviewPanel.active) {
					this.focus(id);
					host.tree.revealAgent(id);
					host.notifier.clear(id);
					// Switching to an agent or thread puts the cursor where the user types.
					live.controller.focusComposer();
				}
				if (e.webviewPanel.active && live.unread) {
					live.unread = false;
					host.refresh(id);
				}
			});
			panel.onDidDispose(() => {
				if (live.panel === panel) {
					live.panel = undefined;
					live.tabIcon = undefined;
				}
				// A reopened tab is a new editor without the description, so send the tabs again.
				host.indicators.tabClosed();
				live.controller.detach(webview);
				// Closing the tab or removing the agent closes its files; quitting keeps them for next time.
				if (!host.disposing()) {
					closeAgentFiles(id);
				}
			});
		}
		this.focus(id);
		host.refresh();
	}

	/** Starts an agent's session in this window, showing its saved chat first. */
	private startSaved(record: AgentRecord, folder: string): LiveAgent {
		// A saved chat shows first; its session reopens, replaying the whole history, once it is on screen.
		const saved = record.updatedAt !== record.createdAt;
		const live = this.host.starter.start(record, folder, saved && !!record.sessionId);
		if (saved) {
			// Read while the tab opens; the agent reopens its session meanwhile.
			const restored = Promise.all([this.host.transcripts.load(record.id), this.host.checkpointFiles.load(record.id)]).then(([stored, checkpoints]) => {
				// The agent may have been stopped while the file was read.
				if (this.host.live.get(record.id) !== live) {
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
	ensureLive(id: string): LiveAgent | undefined {
		const live = this.host.live.get(id);
		const record = this.host.model.agent(id);
		const folder = record && this.host.model.folderOf(record);
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
			await this.host.changesView.openAll(source);
		}
	}

	private focus(id: string): void {
		this._focusedId = id;
		const source = this.changesSource(id);
		this.host.changesView.show(source);
		this.host.focusChanged(source);
	}

	/** Agent `id`'s session ended: when its tab was the one last in front, the Changes view shows nothing. */
	unfocus(id: string): void {
		if (this._focusedId === id) {
			this._focusedId = undefined;
			this.host.changesView.show(undefined);
			this.host.focusChanged(undefined);
		}
	}

	/** The agent whose changes show: the one whose tab was last in front. */
	get focusedSource(): ChangesSource | undefined {
		return this._focusedId ? this.changesSource(this._focusedId) : undefined;
	}

	changesSource(id: string): ChangesSource | undefined {
		const host = this.host;
		const live = host.live.get(id);
		const record = host.model.agent(id);
		const workspace = record && host.model.workspace(record.workspaceId);
		return live && workspace ? {
			agentId: id, title: record.title, folder: agentFolder(record, workspace.folder), changes: live.changes,
			editorColumn: () => agentColumn(id, live.panel),
			focusEditors: async () => { await agentColumn(id, live.panel, true); },
			busy: () => live.activity.busy,
			...(record.worktree ? {
				branch: record.worktree.branch,
				trying: record.tried?.state === 'trying',
				mergeBack: async () => { await host.view.mergeBack(id); },
				tryChoice: () => host.view.tryChoiceOf(id),
				chooseTry: async choice => { await host.view.chooseTry(id, choice); },
				mergeRequests: () => host.view.mergeRequests(),
				keep: async () => { await host.view.tryAction(id, 'keep'); },
				takeBack: async () => { await host.view.tryAction(id, 'takeBack'); },
			} : { commit: () => live.controller.commit() }),
		} : undefined;
	}

	/** Brings the agent's tab to the front, opening it if it has none. */
	async reveal(id: string, preserveFocus: boolean): Promise<void> {
		const live = this.host.live.get(id);
		if (live?.panel) {
			live.panel.reveal(undefined, preserveFocus);
		} else {
			await this.open(id);
		}
	}

	async rename(node: AgentTreeNode | undefined): Promise<void> {
		node ??= this.host.tree.view.selection[0];
		if (node?.kind !== 'agent') {
			return;
		}
		const title = await vscode.window.showInputBox({ title: vscode.l10n.t("Rename Agent"), value: node.record.title, validateInput: v => v.trim() ? undefined : vscode.l10n.t("Enter a name.") });
		if (title?.trim()) {
			this.renameAgent(node.record.id, title.trim());
		}
	}

	renameAgent(id: string, title: string): void {
		this.host.model.rename(id, title);
		const panel = this.host.live.get(id)?.panel;
		if (panel) {
			panel.title = title;
		}
		if (this._focusedId === id) {
			this.focus(id);
		}
	}

	/** Fork Agent, from the agent's row or the Command Palette: the Fork dialog opens in the agent's chat. */
	async fork(node: AgentTreeNode | undefined): Promise<void> {
		const selected = node ?? this.host.tree.view.selection[0];
		const id = selected?.kind === 'agent' ? selected.record.id : this.activeAgentId();
		const record = id ? this.host.model.agent(id) : undefined;
		if (!id || !record) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Select an agent to fork."));
			return;
		}
		if (record.project?.role === 'coordinator') {
			void vscode.window.showInformationMessage(vscode.l10n.t("A project chat can't be forked: fork one of its threads, or start a new thread from the project chat."));
			return;
		}
		await this.open(id);
		await this.host.live.get(id)?.controller.openFork();
	}
}

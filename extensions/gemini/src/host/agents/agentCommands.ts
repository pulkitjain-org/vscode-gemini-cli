/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agents pane's commands: the pane's title and row menus, the Command
// Palette and the keys. Each one calls the pane, or the module behind it.

import * as vscode from 'vscode';
import type { EditedFile } from '../../acp/agentChanges';
import type { AgentsView } from '../agentsView';
import type { ChangesView } from '../changesView';
import type { Projects } from '../projects';
import type { AgentFeatures } from './agentFeatures';
import type { AgentProjects } from './agentProjects';
import type { AgentRemoval } from './agentRemoval';
import type { AgentSideLinks } from './agentSideLinks';
import type { AgentStarts } from './agentStarts';
import type { AgentTabs } from './agentTabs';
import type { AgentTree, AgentTreeNode } from './agentTree';

/** What the commands act on: the Agents pane, and the modules behind some of them. */
export interface AgentCommandsHost {
	/** The pane's own surface. */
	readonly view: Pick<AgentsView, 'chooseTry' | 'tryAction' | 'pickReview' | 'open' | 'activeAgentId' | 'openChanges' | 'summaries' | 'openAsMarkdown' | 'stopTurn'>;
	readonly starts: Pick<AgentStarts, 'newAgent' | 'reviewChanges' | 'addWorkspace'>;
	readonly tree: Pick<AgentTree, 'view'>;
	readonly changesView: Pick<ChangesView, 'openFile'>;
	readonly projectAgents: Pick<AgentProjects, 'newProject'>;
	readonly projects: Pick<Projects, 'openNewThread' | 'openSettingsOf'>;
	/** Try in Workspace and the rest, from dist/onDemand.js once first needed. */
	readonly features: Pick<AgentFeatures, 'tries'>;
	/** The agents' tabs: Fork, Rename and the chat in front. */
	readonly tabs: Pick<AgentTabs, 'fork' | 'rename' | 'focusChat' | 'chatInFront'>;
	readonly sideLinks: Pick<AgentSideLinks, 'openTerminal'>;
	readonly removal: Pick<AgentRemoval, 'removeAgent' | 'removeWorkspace'>;
}

/** Registers the pane's commands; the disposables go with the pane. */
export function registerAgentCommands(view: AgentCommandsHost): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('gemini.agents.newAgent', (node?: AgentTreeNode) => view.starts.newAgent(node)),
		vscode.commands.registerCommand('gemini.agents.newAgentOnBranch', (node?: AgentTreeNode) => view.starts.newAgent(node, true)),
		// The row's menu lists both; Merge Back from there is remembered for the repository, as the chevron's choice is.
		vscode.commands.registerCommand('gemini.agents.mergeBack', (node?: AgentTreeNode) => node?.kind === 'agent' && view.view.chooseTry(node.record.id, 'merge')),
		vscode.commands.registerCommand('gemini.agents.tryInWorkspace', (node?: AgentTreeNode) => node?.kind === 'agent' && view.view.chooseTry(node.record.id, 'try')),
		vscode.commands.registerCommand('gemini.agents.takeBack', (node?: AgentTreeNode) => node?.kind === 'agent' && view.view.tryAction(node.record.id, 'takeBack')),
		// The status bar item of a try: Keep Changes, Take Back and the rest.
		vscode.commands.registerCommand('gemini.tries.menu', (id?: unknown) => view.features.tries.showMenu(typeof id === 'string' ? id : undefined)),
		vscode.commands.registerCommand('gemini.agents.fork', (node?: AgentTreeNode) => view.tabs.fork(node)),
		vscode.commands.registerCommand('gemini.reviewChanges', (source?: { readonly rootUri?: vscode.Uri }) => view.starts.reviewChanges(source)),
		vscode.commands.registerCommand('gemini.review', () => view.view.pickReview()),
		vscode.commands.registerCommand('gemini.agents.addWorkspace', () => view.starts.addWorkspace()),
		// From the keyboard (Cmd+Down on a Mac, where Return renames as in Finder) it opens the selected agent.
		vscode.commands.registerCommand('gemini.agents.open', (id?: string) => {
			const selected = view.tree.view.selection[0];
			const target = typeof id === 'string' ? id : selected?.kind === 'agent' ? selected.record.id : undefined;
			return target && view.view.open(target);
		}),
		vscode.commands.registerCommand('gemini.agents.openTerminal', (node?: AgentTreeNode) => view.sideLinks.openTerminal(node?.kind === 'agent' ? node.record.id : view.view.activeAgentId())),
		// From the pane's row, or from the Changes view's file rows with the file.
		vscode.commands.registerCommand('gemini.agents.openChanges', (target?: AgentTreeNode | EditedFile) => {
			if (!target) {
				return undefined;
			}
			if (typeof (target as EditedFile).path === 'string') {
				return view.changesView.openFile(target as EditedFile);
			}
			const node = target as AgentTreeNode;
			return node.kind === 'agent' && view.view.openChanges(node.record.id);
		}),
		vscode.commands.registerCommand('gemini.agents.rename', (node?: AgentTreeNode) => view.tabs.rename(node)),
		// From the pane's row; from the palette, the agent in front, else the first one not stopped.
		vscode.commands.registerCommand('gemini.agents.openAsMarkdown', (node?: AgentTreeNode) => {
			const id = node?.kind === 'agent' ? node.record.id : view.view.activeAgentId() ?? view.view.summaries().find(each => each.state !== 'stopped')?.id;
			return id ? view.view.openAsMarkdown(id) : vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
		}),
		// From the palette or a key: the agent in front.
		vscode.commands.registerCommand('gemini.agents.stop', (node?: AgentTreeNode) => {
			const id = node?.kind === 'agent' ? node.record.id : view.view.activeAgentId();
			return id && view.view.stopTurn(id);
		}),
		vscode.commands.registerCommand('gemini.agents.focusChat', () => view.tabs.focusChat()),
		vscode.commands.registerCommand('gemini.agents.cycleMode', () => view.tabs.chatInFront()?.cycleMode()),
		vscode.commands.registerCommand('gemini.agents.toggleYolo', () => view.tabs.chatInFront()?.toggleYolo()),
		vscode.commands.registerCommand('gemini.agents.sideQuestion', () => view.tabs.chatInFront()?.openSide()),
		vscode.commands.registerCommand('gemini.agents.switchModel', () => view.tabs.chatInFront()?.pickModel()),
		vscode.commands.registerCommand('gemini.agents.remove', (node?: AgentTreeNode) => view.removal.removeAgent(node)),
		vscode.commands.registerCommand('gemini.agents.removeWorkspace', (node?: AgentTreeNode) => view.removal.removeWorkspace(node)),
		vscode.commands.registerCommand('gemini.projects.new', (node?: AgentTreeNode) => view.projectAgents.newProject(node)),
		vscode.commands.registerCommand('gemini.projects.newThread', (node?: AgentTreeNode) => node?.kind === 'agent' && view.projects.openNewThread(node.record.id)),
		vscode.commands.registerCommand('gemini.projects.settings', (node?: AgentTreeNode) => node?.kind === 'agent' && view.projects.openSettingsOf(node.record.id)),
	];
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An agent's side column beside its chat: the links to its changes, page,
// terminal and files, Open Terminal (one terminal per repository of a
// thread), and Run on the agent's replies in its own terminals.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentFolder, AgentsModel } from '../../acp/agents';
import type { AgentTerminals } from '../agentTerminals';
import type { ChatTerminal, ChatWorkspace } from '../chatController';
import { agentColumn } from '../editorPlacement';
import type { AgentsView } from '../agentsView';
import type { AgentFeatures } from './agentFeatures';
import type { SideLink } from '../chatProtocol';

/** What the side column's links reach into the Agents pane for. */
export interface AgentSideLinksHost {
	readonly model: Pick<AgentsModel, 'agent' | 'workspace'>;
	/** The agents running in this window. */
	readonly live: ReadonlyMap<string, { readonly panel?: vscode.WebviewPanel }>;
	/** Each agent's terminals, and the last command of every terminal. */
	readonly terminals: Pick<AgentTerminals, 'run' | 'insert' | 'lastCommandFor' | 'open'>;
	/** The pane's own surface: its browser (set by activate, so read when a link is opened), and opening an agent's tab or changes. */
	readonly view: Pick<AgentsView, 'browser' | 'open' | 'openChanges'>;
	/** The agents' Files pages, from dist/pages.js once first needed. */
	readonly features: Pick<AgentFeatures, 'agentFiles'>;
}

export class AgentSideLinks {

	constructor(private readonly host: AgentSideLinksHost) { }

	/**
	 * Run on the agent's replies: its folder, or each repository of a thread or
	 * project, in the agent's own terminals. A coordinator's Run always asks:
	 * its repositories are the user's own checkouts.
	 */
	chatTerminal(id: string, workspace: () => ChatWorkspace | undefined, coordinator: boolean): ChatTerminal {
		const several = () => (workspace()?.repos?.length ?? 0) > 1;
		return {
			places: () => {
				const current = workspace();
				return current?.repos?.length ? current.repos : current ? [{ name: path.basename(current.cwd), folder: current.cwd }] : [];
			},
			alwaysAsk: coordinator,
			run: (place, command, fresh) => this.host.terminals.run(id, this.terminalName(id, place.name, several()), place.folder, command, fresh),
			insert: (place, command) => this.host.terminals.insert(id, this.terminalName(id, place.name, several()), place.folder, command),
			lastCommand: () => this.host.terminals.lastCommandFor(id),
		};
	}

	/** An agent's terminal: "fix-login · Gemini", or "thread · api" for one of its several repositories. */
	private terminalName(id: string, place: string, several: boolean): string {
		const title = this.host.model.agent(id)?.title ?? vscode.l10n.t("Agent");
		return several ? vscode.l10n.t("{0} \u00b7 {1}", title, place) : vscode.l10n.t("{0} \u00b7 Gemini", title);
	}

	/** Open Terminal: the agent's terminal in its folder, or in each of a thread's repositories. */
	/** A link in an agent's side column: its changes, page, terminal or files, beside its chat. */
	openSideLink(id: string, link: SideLink): void {
		switch (link) {
			case 'changes':
				void this.host.view.openChanges(id);
				break;
			case 'terminal':
				this.openTerminal(id);
				break;
			case 'browser':
				void this.openBrowser(id);
				break;
			case 'files':
				void this.openFiles(id);
				break;
		}
	}

	/** The Files link: the agent's Files page, in its side group. */
	private async openFiles(id: string): Promise<void> {
		await this.host.view.open(id);
		await this.host.features.agentFiles.open(id);
	}

	/** The Browser link: the agent's page, or a blank page of the user's in the agent's side group. */
	private async openBrowser(id: string): Promise<void> {
		await this.host.view.open(id);
		if (await this.host.view.browser?.revealAgentPage(id)) {
			return;
		}
		const column = await agentColumn(id, this.host.live.get(id)?.panel, true);
		await vscode.commands.executeCommand('_gemini.browser.openBlank', column).then(undefined, () =>
			vscode.commands.executeCommand('workbench.action.browser.open'));
	}

	openTerminal(id: string | undefined): void {
		const record = id ? this.host.model.agent(id) : undefined;
		const workspace = record && this.host.model.workspace(record.workspaceId);
		if (!id || !record || !workspace) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
			return;
		}
		const repos = record.repos?.filter(repo => !repo.merged);
		const folder = agentFolder(record, workspace.folder);
		const places = repos && repos.length > 1 ? repos.map(repo => ({ name: repo.key, folder: repo.cwd })) : [{ name: path.basename(folder), folder }];
		for (const place of places) {
			void this.host.terminals.open(id, this.terminalName(id, place.name, places.length > 1), place.folder);
		}
	}
}

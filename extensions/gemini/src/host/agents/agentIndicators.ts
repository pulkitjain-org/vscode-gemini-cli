/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the window shows about agents outside their list: a pill in the title
// bar for each agent working, waiting or done, each agent tab's icon and line
// counts, and the number waiting on the user on the pane's icon and the Dock.

import * as vscode from 'vscode';
import type { AgentsModel } from '../../acp/agents';
import { waitingCount } from '../../acp/attention';
import { jiraKeyIn } from '../../acp/jira';
import type { AgentNotifier } from '../agentNotifier';
import type { AgentStateKind } from '../panelProtocol';
import { agentState, AgentTreeNode, LiveAgentView } from './agentTree';

/** Agent tab icons end in #gemini-agent=<id>; GeminiCode's workbench matches tabs on it (gemini.contribution.ts). */
const agentTabFragment = 'gemini-agent=';

/** An agent running in this window, with the tab it may have. */
export interface LiveAgentTab extends LiveAgentView {
	readonly panel?: vscode.WebviewPanel;
	/** The icon file its tab shows (its state, or Gemini's or Jira's at rest); unset until set. */
	tabIcon?: string;
}

/** An agent as the title bar's pills show it. */
export interface AgentPill {
	readonly id: string;
	readonly title: string;
	readonly state: AgentStateKind;
	readonly status: string;
}

export class AgentIndicators {

	/** The pills last sent to the title bar, to send only changes. */
	private lastStatus = '';
	/** The tabs last sent to the workbench, to send only changes. */
	private lastTabs = '';

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly model: AgentsModel,
		private readonly live: ReadonlyMap<string, LiveAgentTab>,
		private readonly view: vscode.TreeView<AgentTreeNode>,
		private readonly notifier: AgentNotifier,
	) { }

	/** The number of agents waiting on the user, on the pane's icon and the Dock. */
	updateBadge(): void {
		const count = waitingCount(this.live.values());
		const tooltip = count === 1 ? vscode.l10n.t("1 agent is waiting for you") : vscode.l10n.t("{0} agents are waiting for you", count);
		if (this.view.badge?.value !== count) {
			this.view.badge = count ? { value: count, tooltip } : undefined;
		}
		this.notifier.setWaiting(count);
	}

	/** Sends the title bar a pill for each agent that is working, waiting or done and unread. */
	updateTitleBar(agents: readonly AgentPill[]): void {
		const pills = agents
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

	/** Each agent tab's icon shows its state, and its description its line counts. */
	updateTabs(): void {
		const tabs: { id: string; title: string; description: string }[] = [];
		for (const [id, live] of this.live) {
			if (!live.panel) {
				continue;
			}
			const state = agentState(live);
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

	/** A tab closed: a reopened tab is a new editor without the description, so the tabs are sent again. */
	tabClosed(): void {
		this.lastTabs = '';
	}

	/** A resting agent's tab icon: the Jira logo for an agent on a ticket (its title or branch names one), else Gemini's. */
	restingTabIcon(agentId: string): string {
		const record = this.model.agent(agentId);
		return record && (jiraKeyIn(record.title) || (record.worktree && jiraKeyIn(record.worktree.branch))) ? 'tools/jira.svg' : 'gemini.svg';
	}

	/**
	 * An agent tab's icon. The fragment names the agent, so the workbench can
	 * tell tabs apart when two agents have the same title (the browser ignores it).
	 */
	tabIcon(agentId: string, file = 'gemini.svg'): vscode.Uri {
		return vscode.Uri.joinPath(this.extensionUri, 'media', file).with({ fragment: `${agentTabFragment}${agentId}` });
	}
}

/** Agents waiting on the user come first in the title bar, then working ones. */
function pillOrder(state: AgentStateKind): number {
	return state === 'waiting' || state === 'error' ? 0 : state === 'working' ? 1 : 2;
}

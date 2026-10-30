/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { PageTab } from './pagePanel';

/**
 * Agent Setup is one page with four tabs, each a page of its own on the
 * shared shell: Loads (what every agent loads), Index & Docs, Connections
 * and Storage & Audit. A tab's click runs the page's command and the page
 * clicked from closes, so the editor keeps one tab.
 */
export type AgentSetupTab = 'loads' | 'index' | 'connections' | 'audit';

const commands: Readonly<Record<AgentSetupTab, string>> = {
	loads: 'gemini.projectSettings',
	index: 'gemini.index.open',
	connections: 'gemini.connections',
	audit: 'gemini.openAuditLog',
};

function labels(): Readonly<Record<AgentSetupTab, string>> {
	return {
		loads: vscode.l10n.t("Loads"),
		index: vscode.l10n.t("Index & Docs"),
		connections: vscode.l10n.t("Connections"),
		audit: vscode.l10n.t("Storage & Audit"),
	};
}

/** The strip's tabs, with `active` marked. */
export function agentSetupTabs(active: AgentSetupTab): PageTab[] {
	const names = labels();
	return (Object.keys(commands) as AgentSetupTab[]).map(id => ({ id, label: names[id], ...id === active ? { active: true } : {} }));
}

export function agentSetupTabsLabel(): string {
	return vscode.l10n.t("Agent Setup");
}

/** The editor tab's title: "Agent Setup: Loads". */
export function agentSetupTitle(tab: AgentSetupTab): string {
	return vscode.l10n.t("Agent Setup: {0}", labels()[tab]);
}

/** Opens the tab's page; resolves once its command ran. */
export async function openAgentSetupTab(tab: string): Promise<void> {
	const command = commands[tab as AgentSetupTab];
	if (command) {
		await vscode.commands.executeCommand(command);
	}
}

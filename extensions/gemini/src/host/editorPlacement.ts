/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where an agent's files and diffs open. An agent tab is the main editor, so
// what it opens goes in a group beside it and the chat stays in view. In
// GeminiCode each agent has a side group of its own (the workbench's
// geminiAgentGroups.ts): it stays open but hidden while another agent is in
// front, so returning to an agent shows its files as they were left. Elsewhere
// it is the group after the agent's, reused instead of a new group per file;
// a column one past the last group makes the workbench add that group once.

import * as vscode from 'vscode';

/** The editor group after `panel`'s, or the group beside the active one when the panel has no column. */
export function besideAgent(panel: vscode.WebviewPanel | undefined): vscode.ViewColumn {
	const column = panel?.viewColumn;
	return column === undefined ? vscode.ViewColumn.Beside : Math.min(column + 1, vscode.ViewColumn.Nine);
}

/** The column for what agent `agentId` opens: its own side group in GeminiCode, else the group after its tab. */
export async function agentColumn(agentId: string, panel: vscode.WebviewPanel | undefined, activate = false): Promise<vscode.ViewColumn> {
	try {
		const column = await vscode.commands.executeCommand<number | undefined>('_gemini.agentGroupColumn', agentId, activate);
		if (typeof column === 'number' && column >= 1) {
			return column;
		}
	} catch {
		// Not GeminiCode's workbench.
	}
	const column = besideAgent(panel);
	if (activate) {
		await focusColumn(column);
	}
	return column;
}

/**
 * The column a new agent or Agent Home opens in: the agents' group, so neither
 * lands in an agent's side group when that group is the active one. Elsewhere
 * (or with no agents' group yet) the active group.
 */
export async function agentsColumn(): Promise<vscode.ViewColumn> {
	try {
		const column = await vscode.commands.executeCommand<number | undefined>('_gemini.agentsColumn');
		if (typeof column === 'number' && column >= 1) {
			return column;
		}
	} catch {
		// Not GeminiCode's workbench.
	}
	return vscode.ViewColumn.Active;
}

/** Closes agent `agentId`'s side group and its files; files with unsaved changes stay open. */
export function closeAgentFiles(agentId: string): void {
	vscode.commands.executeCommand('_gemini.closeAgentGroup', agentId).then(undefined, () => undefined);
}

const focusGroupCommands = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
	.map(ordinal => `workbench.action.focus${ordinal}EditorGroup`);

/**
 * Makes `column`'s group the active one (adding it when it is the next one),
 * for commands such as `vscode.changes` that only open in the active group.
 */
export async function focusColumn(column: vscode.ViewColumn): Promise<void> {
	const command = column === vscode.ViewColumn.Beside ? 'workbench.action.focusRightGroup' : focusGroupCommands[column - 1];
	if (command) {
		await vscode.commands.executeCommand(command);
	}
}

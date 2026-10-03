/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where an agent's files and diffs open. An agent tab is the main editor, so
// what it opens goes in the editor group after the agent's (the one to its
// right in the default layout): the chat stays in view, and that one group is
// reused instead of a new group per file. A column one past the last group
// makes the workbench add that group once.

import * as vscode from 'vscode';

/** The editor group after `panel`'s, or the group beside the active one when the panel has no column. */
export function besideAgent(panel: vscode.WebviewPanel | undefined): vscode.ViewColumn {
	const column = panel?.viewColumn;
	return column === undefined ? vscode.ViewColumn.Beside : Math.min(column + 1, vscode.ViewColumn.Nine);
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

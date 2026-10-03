/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The GeminiCode layout: the Agents pane on the left and the Changes view on
// the right. The workbench always opens a new workspace on the Explorer, and no
// setting or product.json field picks another default container, so the
// extension shows both once per workspace. After that the workbench restores
// whatever the user arranged.

import * as vscode from 'vscode';

const shownKey = 'gemini.layout.shown';
const settingKey = 'gemini.layout.showAgentsInNewWorkspaces';

export async function applyLayoutDefaults(context: vscode.ExtensionContext): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length || context.workspaceState.get<boolean>(shownKey)) {
		return;
	}
	await context.workspaceState.update(shownKey, true);
	if (!vscode.workspace.getConfiguration().get<boolean>(settingKey, true)) {
		return;
	}
	try {
		// The Changes view first, so the Agents pane ends up with focus.
		await vscode.commands.executeCommand('workbench.view.extension.gemini-changes');
		await vscode.commands.executeCommand('workbench.view.extension.gemini');
	} catch {
		// A container can be missing when a policy hides it; the layout is only a default.
	}
}

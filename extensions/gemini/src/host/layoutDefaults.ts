/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The GeminiCode layout: one side bar card with the Agents pane and, below it,
// the active agent's Changes; agent chats open as editor tabs in the centre.
// The workbench always opens a new workspace on the Explorer, and no setting or
// product.json field picks another default container, so the extension reveals
// the Agents pane once per workspace. After that the workbench restores
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
		await vscode.commands.executeCommand('workbench.view.extension.gemini');
	} catch {
		// The container can be missing when a policy hides it; the layout is only a default.
	}
}

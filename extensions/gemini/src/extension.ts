/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { validateProjectId } from './acp/projectId';
import { filesToAttach, selectionsToAttach } from './host/addToChat';
import { AppUpdateNotice } from './host/appUpdateNotice';
import { AgentService } from './host/agentService';
import { AgentsView } from './host/agentsView';
import { applyLayoutDefaults } from './host/layoutDefaults';
import { ChatViewProvider, chatViewId } from './host/chatView';
import { checkAgent } from './host/checkAgent';
import { CliManager } from './host/cliManager';
import { DiffPreview } from './host/diffPreview';
import { configSection, setStorageDirs } from './host/configuration';
import { initModelPreference } from './host/modelPreference';
import { SetupWalkthrough, walkthroughId } from './host/setupWalkthrough';
import { GeminiStatusBar } from './host/statusBar';
import { initTeamCommands } from './host/teamCommands';
import { WorkspaceFileIndex } from './host/workspaceFiles';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Gemini', { log: true });
	initModelPreference(context.globalState);
	setStorageDirs({
		managedCli: vscode.Uri.joinPath(context.globalStorageUri, 'gemini-cli').fsPath,
		bundledCli: vscode.Uri.joinPath(context.extensionUri, 'cli').fsPath,
		adminPolicy: vscode.Uri.joinPath(context.globalStorageUri, 'policy').fsPath,
	});
	const teamCommandStore = initTeamCommands(log);
	const service = new AgentService(log, vscode.Uri.joinPath(context.globalStorageUri, 'cli-debug.log').fsPath);
	const diffPreview = new DiffPreview();
	const fileIndex = new WorkspaceFileIndex();
	const chatView = new ChatViewProvider(context.extensionUri, service, diffPreview, fileIndex);
	const agentsView = new AgentsView(context, service, diffPreview, fileIndex);
	void applyLayoutDefaults(context);
	// Add to Chat goes to the agent tab in front, else to the quick chat.
	const chatInFront = () => agentsView.activeController() ?? chatView.controller;
	const walkthrough = new SetupWalkthrough(service, context.globalState);

	context.subscriptions.push(
		log,
		teamCommandStore,
		service,
		diffPreview,
		fileIndex,
		chatView,
		agentsView,
		walkthrough,
		new GeminiStatusBar(service),
		new CliManager(service, context.globalState, log),
		new AppUpdateNotice(context.globalState, log),
		// Kept alive while hidden, so switching back to the chat is instant instead of reloading it.
		vscode.window.registerWebviewViewProvider(chatViewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('gemini.openChat', () => vscode.commands.executeCommand(`${chatViewId}.focus`)),
		vscode.commands.registerCommand('gemini.newChat', () => chatView.newChat()),
		vscode.commands.registerCommand('gemini.addFileToChat', async (uri: unknown, uris: unknown) => chatInFront().addAttachments(await filesToAttach(uri, uris))),
		vscode.commands.registerCommand('gemini.addSelectionToChat', () => chatInFront().addAttachments(selectionsToAttach())),
		vscode.commands.registerCommand('gemini.showLog', () => log.show()),
		vscode.commands.registerCommand('gemini.checkAgent', () => checkAgent(log)),
		vscode.commands.registerCommand('gemini.restartAgent', () => service.restart()),
		vscode.commands.registerCommand('gemini.completeSetupInTerminal', () => service.completeSetupInTerminal()),
		vscode.commands.registerCommand('gemini.setProjectId', () => setProjectId()),
		vscode.commands.registerCommand('gemini.signIn', () => walkthrough.signIn()),
		vscode.commands.registerCommand('gemini.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthroughId, false)),
	);
}

export function deactivate(): void { }

async function setProjectId(): Promise<void> {
	const config = vscode.workspace.getConfiguration(configSection);
	const value = await vscode.window.showInputBox({
		title: vscode.l10n.t("Google Cloud project ID"),
		prompt: vscode.l10n.t("The project ID (not the project number) that Gemini bills to, for example my-project-123."),
		value: config.get<string>('projectId') ?? '',
		ignoreFocusOut: true,
		validateInput: input => {
			const problem = input.trim() ? validateProjectId(input.trim()) : undefined;
			return problem === 'numeric' ? vscode.l10n.t("That is a project number. Enter the project ID instead.")
				: problem === 'malformed' ? { message: vscode.l10n.t("This does not look like a project ID."), severity: vscode.InputBoxValidationSeverity.Warning }
					: undefined;
		},
	});
	if (value === undefined) {
		return;
	}
	const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await config.update('projectId', value.trim() || undefined, target);
}

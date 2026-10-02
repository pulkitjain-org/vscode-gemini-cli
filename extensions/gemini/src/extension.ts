/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { validateProjectId } from './acp/projectId';
import { AgentService } from './host/agentService';
import { checkAgent } from './host/checkAgent';
import { configSection } from './host/configuration';
import { sendPrompt } from './host/sendPrompt';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Gemini', { log: true });
	const transcript = vscode.window.createOutputChannel(vscode.l10n.t("Gemini Transcript"));
	const service = new AgentService(log);

	context.subscriptions.push(
		log,
		transcript,
		service,
		vscode.commands.registerCommand('gemini.showLog', () => log.show()),
		vscode.commands.registerCommand('gemini.checkAgent', () => checkAgent(log)),
		vscode.commands.registerCommand('gemini.restartAgent', () => service.restart()),
		vscode.commands.registerCommand('gemini.completeSetupInTerminal', () => service.completeSetupInTerminal()),
		vscode.commands.registerCommand('gemini.sendPrompt', () => sendPrompt(service, transcript)),
		vscode.commands.registerCommand('gemini.setProjectId', () => setProjectId()),
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

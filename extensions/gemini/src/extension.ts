/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { validateProjectId } from './acp/projectId';
import { filesToAttach, selectionsToAttach } from './host/addToChat';
import { AppUpdateNotice } from './host/appUpdateNotice';
import { Appearance } from './host/appearance';
import { AgentService } from './host/agentService';
import { AgentHome } from './host/agentHome';
import { AgentsView } from './host/agentsView';
import { ChangesPanel } from './host/changesPanel';
import { applyLayoutDefaults } from './host/layoutDefaults';
import { ChatViewProvider, chatViewId } from './host/chatView';
import { checkAgent } from './host/checkAgent';
import { CliManager } from './host/cliManager';
import { DiffPreview } from './host/diffPreview';
import { errorMessage } from './acp/errors';
import { PromptEnhancer } from './acp/promptEnhancer';
import { configSection, setStorageDirs } from './host/configuration';
import { initModelPreference } from './host/modelPreference';
import { SetupWalkthrough, walkthroughId } from './host/setupWalkthrough';
import { GeminiStatusBar } from './host/statusBar';
import { QuickEdits } from './host/quickEdits';
import { SettingsPage } from './host/settingsPage';
import { UsageMeter } from './host/usageMeter';
import { initTeamCommands } from './host/teamCommands';
import { KeepAwake } from './acp/keepAwake';
import { BrowserTools } from './host/browserTools';
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
	// Rewrites run on the agent process every chat shares, in an empty folder of their own.
	const enhancer = new PromptEnhancer(service.runtime, {
		cwd: vscode.Uri.joinPath(context.globalStorageUri, 'enhance').fsPath,
		start: () => service.isStarted || service.restart(),
		// One direct request when inline edit's are on; the CLI otherwise, or when it fails.
		direct: (request): Promise<string | undefined> => quickEdits.enhancePrompt(request),
		onDirectFailed: err => log.info(`Prompt enhancement's direct request failed (${errorMessage(err)}); asking the CLI`),
		onDidEnhance: ({ ms, model }) => log.info(`Prompt enhanced in ${ms} ms with ${model ?? 'the default model'}`),
	});
	const chatView = new ChatViewProvider(context.extensionUri, service, diffPreview, fileIndex, enhancer);
	const agentsView = new AgentsView(context, service, diffPreview, fileIndex, enhancer);
	// Agents mode's Changes panel follows the agent in front, as the Changes view does.
	const changesPanel = new ChangesPanel(context.extensionUri);
	changesPanel.show(agentsView.focusedSource);
	void applyLayoutDefaults(context);
	// Add to Chat goes to the agent tab in front, else to the quick chat.
	const chatInFront = () => agentsView.activeController() ?? chatView.controller;
	const quickEdits = new QuickEdits(agentsView.review, log);
	const statusBar = new GeminiStatusBar(service);
	const usageMeter = new UsageMeter(quickEdits.client, log);
	chatView.usage = usageMeter;
	agentsView.usage = usageMeter;
	const walkthrough = new SetupWalkthrough(service, context.globalState);
	const browserTools = new BrowserTools(String(context.extension.packageJSON.version ?? ''), log, {
		stop: agent => agentsView.stopTurn(agent),
		title: agent => agentsView.agentTitle(agent) ?? vscode.l10n.t("Agent"),
		open: () => agentsView.summaries().filter(agent => agent.state !== 'stopped'),
		attach: async (agent, attachments) => {
			await agentsView.open(agent);
			await agentsView.controllerOf(agent)?.addAttachments(attachments);
		},
	});
	agentsView.browser = browserTools;
	// caffeinate watches this process, so it ends with GeminiCode even if GeminiCode crashes.
	const keepAwake = new KeepAwake({ platform: process.platform, pid: process.pid, log: message => log.info(message) });
	const readKeepAwake = () => keepAwake.setEnabled(vscode.workspace.getConfiguration(configSection).get<boolean>('keepAwake', true));
	readKeepAwake();

	context.subscriptions.push(
		log,
		teamCommandStore,
		enhancer,
		service,
		diffPreview,
		fileIndex,
		chatView,
		agentsView,
		changesPanel,
		agentsView.onDidFocus(source => changesPanel.show(source)),
		new AgentHome(context.extensionUri, agentsView),
		new SettingsPage(context.extensionUri, service),
		quickEdits,
		statusBar,
		usageMeter,
		usageMeter.onDidChange(usage => statusBar.setUsage(usage)),
		walkthrough,
		new Appearance(context.extensionUri),
		new CliManager(service, context.globalState, log),
		new AppUpdateNotice(context.globalState, log),
		keepAwake,
		browserTools,
		service.runtime.onDidBecomeBusy(() => keepAwake.setBusy(true)),
		service.runtime.onDidBecomeIdle(() => keepAwake.setBusy(false)),
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.keepAwake`) && readKeepAwake()),
		// Kept alive while hidden, so switching back to the chat is instant instead of reloading it.
		vscode.window.registerWebviewViewProvider(chatViewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('gemini.openChat', () => vscode.commands.executeCommand(`${chatViewId}.focus`)),
		vscode.commands.registerCommand('gemini.newChat', () => chatView.newChat()),
		vscode.commands.registerCommand('gemini.enhancePrompt', () => chatInFront().requestEnhance()),
		vscode.commands.registerCommand('gemini.toggleFollowAgent', () => chatInFront().toggleFollowing()),
		vscode.commands.registerCommand('gemini.openChatAsMarkdown', () => {
			const agent = agentsView.activeAgentId();
			return agent ? agentsView.openAsMarkdown(agent) : chatView.controller.openAsMarkdown(vscode.l10n.t("Quick Chat"));
		}),
		vscode.commands.registerCommand('gemini.showUsage', () => chatInFront().showUsage()),
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

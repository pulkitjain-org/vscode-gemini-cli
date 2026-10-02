/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { googleAccountsPath, readActiveAccount } from '../acp/accounts';
import { CliResolution } from '../acp/cliResolution';
import { AgentStatus } from '../acp/status';
import { AgentService } from './agentService';
import { configSection, getProjectSettings } from './configuration';

export const statusMenuCommand = 'gemini.showStatusMenu';

/**
 * The Gemini status bar item: sidecar state, signed-in account, project and
 * CLI version. Clicking it opens a menu to restart, change the project or
 * show the log.
 */
export class GeminiStatusBar implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('gemini.status', vscode.StatusBarAlignment.Right, 100);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly accountsFile = googleAccountsPath(process.env, os.homedir());
	private account: string | undefined;
	/** The last CLI seen, kept while the agent is down so the tooltip still says which CLI failed. */
	private cli: string | undefined;

	constructor(private readonly service: AgentService) {
		this.item.name = vscode.l10n.t("Gemini");
		this.item.command = statusMenuCommand;

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.dirname(this.accountsFile)), path.basename(this.accountsFile)));
		this.disposables.push(
			this.item,
			watcher,
			watcher.onDidCreate(() => this.refreshAccount()),
			watcher.onDidChange(() => this.refreshAccount()),
			watcher.onDidDelete(() => this.refreshAccount()),
			service.onDidChangeStatus(status => {
				// The CLI writes the account when a sign-in completes, so re-read on every session.
				if (status.phase === 'ready') {
					void this.refreshAccount();
				}
				this.render();
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${configSection}.projectId`)) {
					this.render();
				}
			}),
			vscode.commands.registerCommand(statusMenuCommand, () => this.showMenu()),
		);

		this.render();
		this.item.show();
		void this.refreshAccount();
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async refreshAccount(): Promise<void> {
		const account = await readActiveAccount(this.accountsFile);
		if (account !== this.account) {
			this.account = account;
			this.render();
		}
	}

	private render(): void {
		const status = this.service.status;
		if (status.agentVersion) {
			this.cli = `${status.agentName ?? 'gemini'} ${status.agentVersion}`;
		}
		const { icon, label } = describePhase(status);
		this.item.text = `${icon} ${label}`;
		this.item.backgroundColor = status.phase === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;

		const project = getProjectSettings().resolved;
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${vscode.l10n.t("Gemini")}**: ${escape(label)}\n\n`);
		if (status.phase === 'error' && status.error) {
			tooltip.appendMarkdown(`${escape(status.error.message)}\n\n`);
		}
		tooltip.appendMarkdown(`${vscode.l10n.t("Account")}: ${escape(this.account ?? vscode.l10n.t("not signed in"))}  \n`);
		tooltip.appendMarkdown(`${vscode.l10n.t("Project")}: ${escape(project ? `${project.projectId} (${project.source})` : vscode.l10n.t("not set"))}  \n`);
		tooltip.appendMarkdown(`${vscode.l10n.t("CLI")}: ${escape(this.cli ?? vscode.l10n.t("unknown until the agent starts"))}${escape(describeCliSource(this.service.cli))}`);
		this.item.tooltip = tooltip;
	}

	private async showMenu(): Promise<void> {
		const status = this.service.status;
		const items: (vscode.QuickPickItem & { command?: string })[] = [
			{ label: status.phase === 'stopped' ? vscode.l10n.t("$(play) Start Agent") : vscode.l10n.t("$(debug-restart) Restart Agent"), command: 'gemini.restartAgent' },
			{ label: vscode.l10n.t("$(project) Change Project ID"), description: getProjectSettings().resolved?.projectId, command: 'gemini.setProjectId' },
			{ label: vscode.l10n.t("$(account) Sign In or Finish Setup in Terminal"), description: this.account, command: 'gemini.completeSetupInTerminal' },
			{ label: vscode.l10n.t("$(comment-discussion) Open Chat"), command: 'gemini.openChat' },
			{ label: vscode.l10n.t("$(output) Show Log"), command: 'gemini.showLog' },
		];
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Gemini: {0}", describePhase(status).label) });
		if (picked?.command) {
			await vscode.commands.executeCommand(picked.command);
		}
	}
}

function describePhase(status: AgentStatus): { icon: string; label: string } {
	switch (status.phase) {
		case 'stopped': return { icon: '$(circle-outline)', label: vscode.l10n.t("Gemini") };
		case 'starting': return { icon: '$(loading~spin)', label: vscode.l10n.t("Gemini: starting") };
		case 'restarting': return { icon: '$(loading~spin)', label: vscode.l10n.t("Gemini: restarting ({0})", status.restartAttempt ?? 1) };
		case 'ready': return { icon: '$(sparkle)', label: vscode.l10n.t("Gemini") };
		case 'error': return { icon: '$(error)', label: vscode.l10n.t("Gemini: needs attention") };
	}
}

function escape(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function describeCliSource(cli: CliResolution | undefined): string {
	switch (cli?.source) {
		case 'setting': return ` (${vscode.l10n.t("from the gemini.cliPath setting")})`;
		case 'managed': return ` (${vscode.l10n.t("GeminiCode's copy")})`;
		case 'path': return ` (${vscode.l10n.t("from PATH")})`;
		default: return '';
	}
}

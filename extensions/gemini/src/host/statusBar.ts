/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { googleAccountsPath, readActiveAccount } from '../acp/accounts';
import { CliResolution } from '../acp/cliResolution';
import type { ModelQuota } from '../acp/directRequest';
import { AgentStatus } from '../acp/status';
import { AgentService } from './agentService';
import { configSection, getProjectSettings } from './configuration';
import { escapeMarkdown } from './markdown';

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
	/** Today's quota use per model, from the usage meter. */
	private usage: readonly ModelQuota[] | undefined;

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

	setUsage(usage: readonly ModelQuota[] | undefined): void {
		this.usage = usage;
		this.render();
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
		// Near a limit, the most used model's share shows in the bar itself.
		const top = this.usage?.[0];
		const nearLimit = status.phase === 'ready' && top && top.used >= nearLimitShare ? ` ${Math.round(top.used * 100)}%` : '';
		this.item.text = `${icon} ${label}${nearLimit}`;
		this.item.backgroundColor = status.phase === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : nearLimit && top!.used >= 0.95 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

		const project = getProjectSettings().resolved;
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${vscode.l10n.t("Gemini")}**: ${escapeMarkdown(label)}\n\n`);
		if (status.phase === 'error' && status.error) {
			tooltip.appendMarkdown(`${escapeMarkdown(status.error.message)}\n\n`);
		}
		tooltip.appendMarkdown(`${vscode.l10n.t("Account")}: ${escapeMarkdown(this.account ?? vscode.l10n.t("not signed in"))}  \n`);
		tooltip.appendMarkdown(`${vscode.l10n.t("Project")}: ${escapeMarkdown(project ? `${project.projectId} (${project.source})` : vscode.l10n.t("not set"))}  \n`);
		tooltip.appendMarkdown(`${vscode.l10n.t("CLI")}: ${escapeMarkdown(this.cli ?? vscode.l10n.t("unknown until the agent starts"))}${escapeMarkdown(describeCliSource(this.service.cli))}`);
		if (this.usage?.length) {
			tooltip.appendMarkdown(`\n\n**${vscode.l10n.t("Today's use")}**  \n`);
			tooltip.appendMarkdown(this.usage.slice(0, 6).map(q => describeQuota(q, Date.now())).join('  \n'));
		}
		this.item.tooltip = tooltip;
	}

	private async showMenu(): Promise<void> {
		const status = this.service.status;
		const items: (vscode.QuickPickItem & { command?: string })[] = [
			{ label: status.phase === 'stopped' ? vscode.l10n.t("$(play) Start Agent") : vscode.l10n.t("$(debug-restart) Restart Agent"), command: 'gemini.restartAgent' },
			{ label: vscode.l10n.t("$(project) Change Project ID"), description: getProjectSettings().resolved?.projectId, command: 'gemini.setProjectId' },
			{ label: vscode.l10n.t("$(versions) Install or Change Gemini CLI Version..."), description: this.cli, command: 'gemini.installCliVersion' },
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

/** From this share of a model's daily quota, the bar shows the percentage. */
const nearLimitShare = 0.8;

/** "gemini-2.5-pro: 35% used, resets in 3h". */
function describeQuota(quota: ModelQuota, now: number): string {
	const used = `${escapeMarkdown(quota.model)}: ${vscode.l10n.t("{0}% used", Math.round(quota.used * 100))}`;
	const reset = quota.resetTime ? Date.parse(quota.resetTime) - now : NaN;
	if (!Number.isFinite(reset) || reset <= 0) {
		return used;
	}
	const hours = Math.floor(reset / 3_600_000);
	return `${used}, ${hours ? vscode.l10n.t("resets in {0}h", hours) : vscode.l10n.t("resets in {0}m", Math.max(1, Math.round(reset / 60_000)))}`;
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

function describeCliSource(cli: CliResolution | undefined): string {
	switch (cli?.source) {
		case 'setting': return ` (${vscode.l10n.t("from the gemini.cliPath setting")})`;
		case 'managed': return ` (${vscode.l10n.t("GeminiCode's copy")})`;
		case 'bundled': return ` (${vscode.l10n.t("bundled with GeminiCode")})`;
		case 'path': return ` (${vscode.l10n.t("from PATH")})`;
		default: return '';
	}
}

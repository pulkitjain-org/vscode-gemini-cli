/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { googleAccountsPath, readActiveAccount } from '../acp/accounts';
import { CliResolution } from '../acp/cliResolution';
import { cliDocsUrl } from '../acp/helpLinks';
import type { ModelQuota } from '../acp/directRequest';
import { AgentStatus } from '../acp/status';
import { AgentService } from './agentService';
import type { AuditLog } from '../acp/auditLog';
import { teamToolIds, teamToolNames } from '../acp/teamHttp';
import { teamStatusSummary } from '../acp/teamStatus';
import type { TeamConnections } from './teamConnections';
import type { WorkspaceIndex } from './workspaceIndex';
import { relativeTime } from './displayText';
import { reportProblemCommand } from './reportProblem';
import { configSection, getProjectSettings } from './configuration';
import { developerToolsOn } from './developerTools';
import { escapeMarkdown } from './markdown';

export const statusMenuCommand = 'gemini.showStatusMenu';

/** A build smaller than this (a few saved files) never shows in the item. */
const minIndexFilesShown = 50;
/** How old the team tools' last check may be before a window focus checks again. */
const recheckMs = 5 * 60_000;

/**
 * The Gemini status bar item: the agent's state, with "Indexing N%" while a
 * large index build runs and the most used model's share near a limit. Its
 * tooltip adds the account, project and CLI, the team tools' connections,
 * the index builds and today's audit count; its menu opens Agent Setup,
 * Connections, the index and the audit log besides restarting the agent.
 * The one item GeminiCode adds to the right of the status bar (Trying is the
 * other, on the left, while an agent's work is tried).
 */
export class GeminiStatusBar implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('gemini.status', vscode.StatusBarAlignment.Right, 103);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly accountsFile = googleAccountsPath(process.env, os.homedir());
	private account: string | undefined;

	/** The signed-in account's name, as the CLI reports it; unset until known. */
	get accountName(): string | undefined {
		return this.account;
	}
	/** The last CLI seen, kept while the agent is down so the tooltip still says which CLI failed. */
	private cli: string | undefined;
	/** Today's quota use per model, from the usage meter. */
	private usage: readonly ModelQuota[] | undefined;
	private connections: TeamConnections | undefined;
	/** Each folder whose index is being built, with its progress. */
	private readonly building = new Map<string, { readonly done: number; readonly total: number }>();
	/** Today's writes to Jira or GitLab, and the ones that never got their result. */
	private audit: { readonly done: number; readonly unfinished: number } | undefined;
	private auditTimer: ReturnType<typeof setTimeout> | undefined;

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

	/** The parts made after the item: the team tools' connections, the workspace index and the audit log. */
	attach(extras: { readonly connections?: TeamConnections; readonly index?: WorkspaceIndex; readonly audit?: AuditLog }): void {
		const { connections, index, audit } = extras;
		if (connections) {
			this.connections = connections;
			this.disposables.push(
				connections.onDidChange(() => this.render()),
				vscode.window.onDidChangeWindowState(state => state.focused && void connections.refreshIfOlder(recheckMs)),
			);
			// Checks the tools a little after start-up, off the activation path.
			const timer = setTimeout(() => void connections.refreshIfOlder(0), 3000);
			this.disposables.push({ dispose: () => clearTimeout(timer) });
		}
		if (index) {
			this.disposables.push(
				index.onDidChangeStatus(status => {
					if (status.state.kind === 'building' && status.state.total >= minIndexFilesShown) {
						this.building.set(status.root, { done: status.state.done, total: status.state.total });
					} else {
						this.building.delete(status.root);
					}
					this.render();
				}),
				index.onDidChangeEnabled(enabled => {
					if (!enabled) {
						this.building.clear();
						this.render();
					}
				}),
			);
		}
		if (audit) {
			// A write adds two records close together; one read covers both.
			this.disposables.push(audit.onDidAppend(() => {
				clearTimeout(this.auditTimer);
				this.auditTimer = setTimeout(() => void this.readAudit(audit), 500);
			}));
			void this.readAudit(audit);
		}
	}

	dispose(): void {
		clearTimeout(this.auditTimer);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async readAudit(audit: AuditLog): Promise<void> {
		const [today, unfinished] = await Promise.all([audit.read(), audit.unfinished()]);
		this.audit = { done: today.filter(entry => entry.phase === 'result').length, unfinished: unfinished.length };
		this.render();
	}

	/** "Indexing 62%" over every folder being built, or nothing. */
	private indexing(): string | undefined {
		if (!this.building.size) {
			return undefined;
		}
		let done = 0;
		let total = 0;
		for (const progress of this.building.values()) {
			done += progress.done;
			total += progress.total;
		}
		return vscode.l10n.t("Indexing {0}%", total ? Math.floor(done / total * 100) : 0);
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
		const cli = status.phase === 'ready' && status.agentVersion ? ` · ${vscode.l10n.t("CLI {0}", status.agentVersion)}` : '';
		const indexing = this.indexing();
		this.item.text = `${icon} ${label}${nearLimit}${indexing ? ` · ${indexing}` : ''}${cli}`;
		this.item.backgroundColor = status.phase === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : nearLimit && top!.used >= 0.95 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

		const project = getProjectSettings().resolved;
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${vscode.l10n.t("Gemini")}**: ${escapeMarkdown(label)}\n\n`);
		if (status.phase === 'error' && status.error) {
			tooltip.appendMarkdown(`${escapeMarkdown(status.error.message)}\n\n`);
		}
		tooltip.appendMarkdown(`${vscode.l10n.t("Account")}: ${escapeMarkdown(this.account ?? vscode.l10n.t("not signed in"))}  \n`);
		tooltip.appendMarkdown(`${vscode.l10n.t("Google Cloud Project ID")}: ${escapeMarkdown(project ? `${project.projectId} (${project.source})` : vscode.l10n.t("not set"))}  \n`);
		tooltip.appendMarkdown(`${vscode.l10n.t("CLI")}: ${escapeMarkdown(this.cli ?? vscode.l10n.t("unknown until the agent starts"))}${escapeMarkdown(describeCliSource(this.service.cli))}`);
		if (this.usage?.length) {
			tooltip.appendMarkdown(`\n\n**${vscode.l10n.t("Today's use")}**  \n`);
			tooltip.appendMarkdown(this.usage.slice(0, 6).map(q => describeQuota(q, Date.now())).join('  \n'));
		}
		const tools = this.teamToolLines();
		if (tools.length) {
			tooltip.appendMarkdown(`\n\n**${vscode.l10n.t("Team tools")}**  \n${tools.join('  \n')}`);
		}
		if (this.building.size) {
			tooltip.appendMarkdown(`\n\n**${vscode.l10n.t("Index")}**  \n`);
			tooltip.appendMarkdown([...this.building].map(([root, progress]) => vscode.l10n.t("Indexing **{0}**: {1} of {2} files, at low priority in its own process", escapeMarkdown(path.basename(root)), progress.done.toLocaleString(), progress.total.toLocaleString())).join('  \n'));
		}
		if (this.audit && (this.audit.done || this.audit.unfinished)) {
			const actions = this.audit.done === 1 ? vscode.l10n.t("Audit: 1 action today") : vscode.l10n.t("Audit: {0} actions today", this.audit.done);
			tooltip.appendMarkdown(`\n\n${this.audit.unfinished ? vscode.l10n.t("{0} · {1} unfinished", actions, this.audit.unfinished) : actions}`);
		}
		this.item.tooltip = tooltip;
	}

	private async showMenu(): Promise<void> {
		const status = this.service.status;
		const items: (vscode.QuickPickItem & { command?: string; run?: () => void })[] = [
			{
				label: status.phase === 'stopped' ? vscode.l10n.t("$(play) Start Agent") : vscode.l10n.t("$(debug-restart) Restart Agent"),
				...status.phase === 'stopped' ? {} : { description: vscode.l10n.t("{0} sessions in the process", this.service.runtime.sessionCount) },
				...this.service.lastRecycle ? { detail: vscode.l10n.t("Restarted {0} to free {1} idle sessions", relativeTime(this.service.lastRecycle.at, Date.now()), this.service.lastRecycle.sessions) } : {},
				command: 'gemini.restartAgent',
			},
			{ label: vscode.l10n.t("$(project) Change Google Cloud Project ID"), description: getProjectSettings().resolved?.projectId, command: 'gemini.setProjectId' },
			{ label: vscode.l10n.t("$(versions) Install or Change Gemini CLI Version..."), description: this.cli, command: 'gemini.installCliVersion' },
			{ label: vscode.l10n.t("$(account) Sign In or Finish Setup in Terminal"), description: this.account, command: 'gemini.completeSetupInTerminal' },
			{ label: vscode.l10n.t("$(add) New Agent"), command: 'gemini.agents.newAgent' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t("$(tools) Agent Setup"), detail: vscode.l10n.t("MCP servers, skills, rules and hooks your agents load"), command: 'gemini.projectSettings' },
			{ label: vscode.l10n.t("$(plug) Connections"), description: this.teamToolWords(), command: 'gemini.connections' },
			{ label: vscode.l10n.t("$(database) Manage Index"), description: this.indexing(), command: 'gemini.index.open' },
			{ label: vscode.l10n.t("$(list-unordered) Open Audit Log"), detail: vscode.l10n.t("Every write made to Jira or GitLab for you, with what the tool gave back"), command: 'gemini.openAuditLog' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t("$(output) Show Log"), command: 'gemini.showLog' },
			...developerToolsOn() ? [
				{ label: vscode.l10n.t("$(pulse) Record Performance Trace..."), detail: vscode.l10n.t("Restarts the agent with the CLI's telemetry going to a file in your home folder; stop it to see where each turn's time went"), command: 'gemini.recordTrace' },
				{ label: vscode.l10n.t("$(beaker) Run Benchmark..."), detail: vscode.l10n.t("Runs the team's benchmark tasks on one model and writes a results file to add by pull request"), command: 'gemini.runBenchmark' },
			] : [],
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t("$(book) Gemini CLI Docs"), run: () => void vscode.env.openExternal(vscode.Uri.parse(cliDocsUrl)) },
			{ label: vscode.l10n.t("$(report) Report a Problem"), detail: vscode.l10n.t("A report with the versions, the last failed turn and the recent log, for you to read over and paste"), command: reportProblemCommand },
		];
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Gemini: {0}", describePhase(status).label) });
		if (picked?.run) {
			picked.run();
		} else if (picked?.command) {
			await vscode.commands.executeCommand(picked.command);
		}
	}

	/** One line per connected team tool: its name and state, as the old item's words had them. */
	private teamToolLines(): string[] {
		const connections = this.connections;
		if (!connections) {
			return [];
		}
		return teamToolIds.filter(tool => connections.connected.has(tool)).map(tool => {
			const state = connections.state(tool);
			const word = state.kind === 'connected' ? (state.account ? vscode.l10n.t("signed in as {0}", state.account) : vscode.l10n.t("connected"))
				: state.kind === 'unreachable' ? (tool === 'figma' ? vscode.l10n.t("Figma isn't open") : vscode.l10n.t("can't reach, check your VPN"))
					: state.kind === 'auth' ? vscode.l10n.t("token refused")
						: state.kind === 'notInstalled' ? vscode.l10n.t("CLI not installed")
							: state.kind === 'checking' ? vscode.l10n.t("checking…")
								: vscode.l10n.t("not working");
			return `${escapeMarkdown(teamToolNames[tool])}: ${escapeMarkdown(word)}`;
		});
	}

	/** The connected tools in a few words, for the menu's Connections row. */
	private teamToolWords(): string | undefined {
		const connections = this.connections;
		if (!connections) {
			return undefined;
		}
		const states = teamToolIds.map(tool => ({ tool, kind: connections.connected.has(tool) ? connections.state(tool).kind : 'off' as const }));
		const summary = teamStatusSummary(states);
		if (summary.word === 'none') {
			return undefined;
		}
		const names = summary.connected.map(tool => teamToolNames[tool]).join(', ');
		return summary.word === 'attention' ? vscode.l10n.t("{0}; one needs attention", names) : summary.word === 'vpnOff' ? vscode.l10n.t("{0}; VPN off", names) : names;
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
		case 'ready': return { icon: '$(sparkle)', label: vscode.l10n.t("Gemini: ready") };
		case 'error': return { icon: '$(error)', label: vscode.l10n.t("Gemini: needs attention") };
	}
}

export function describeCliSource(cli: CliResolution | undefined): string {
	switch (cli?.source) {
		case 'setting': return ` (${vscode.l10n.t("from the gemini.cliPath setting")})`;
		case 'managed': return ` (${vscode.l10n.t("GeminiCode's copy")})`;
		case 'bundled': return ` (${vscode.l10n.t("bundled with GeminiCode")})`;
		case 'path': return ` (${vscode.l10n.t("from PATH")})`;
		default: return '';
	}
}

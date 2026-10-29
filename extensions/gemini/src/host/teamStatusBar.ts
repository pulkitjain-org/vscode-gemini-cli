/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import { teamStatusSummary, type TeamToolStateKind } from '../acp/teamStatus';
import { escapeMarkdown } from './markdown';
import type { TeamConnections } from './teamConnections';

/** How stale the tools' state may get before focusing the window checks them again. */
const recheckMs = 5 * 60_000;

/**
 * One status bar item for the team's tools: hidden until one is connected,
 * then a word per connected tool ("Jira ✓ · GitLab ✓ · Figma: not open"),
 * with each tool's logo and state in the tooltip. Clicking opens Connections.
 */
export class TeamStatusBar implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('gemini.teamTools', vscode.StatusBarAlignment.Right, 102);
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly connections: TeamConnections) {
		this.item.name = vscode.l10n.t("Team Tools");
		this.item.command = 'gemini.connections';
		this.disposables.push(
			this.item,
			connections.onDidChange(() => this.render()),
			vscode.window.onDidChangeWindowState(state => state.focused && void connections.refreshIfOlder(recheckMs)),
		);
		this.render();
		// Checks the tools a little after start-up, off the activation path.
		const timer = setTimeout(() => void connections.refreshIfOlder(0), 3000);
		this.disposables.push({ dispose: () => clearTimeout(timer) });
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private render(): void {
		const states = teamToolIds.map(tool => ({ tool, kind: this.connections.connected.has(tool) ? this.connections.state(tool).kind : 'off' as const }));
		const summary = teamStatusSummary(states);
		if (summary.word === 'none') {
			this.item.hide();
			return;
		}
		this.item.text = states.filter(s => s.kind !== 'off').map(s => word(s.tool, s.kind)).join(' · ');
		this.item.backgroundColor = summary.word === 'attention' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		this.item.accessibilityInformation = { label: vscode.l10n.t("Team tools: {0}", this.item.text) };
		this.item.tooltip = this.tooltip(summary.connected);
		this.item.show();
	}

	private tooltip(connected: readonly TeamToolId[]): vscode.MarkdownString {
		const md = new vscode.MarkdownString(undefined, true);
		md.supportHtml = false;
		md.appendMarkdown(`**${vscode.l10n.t("Team tools")}**\n\n`);
		for (const tool of connected) {
			const state = this.connections.state(tool);
			const logo = vscode.Uri.joinPath(this.extensionUri, 'media', 'tools', `${tool}.svg`);
			const word = state.kind === 'connected' ? (state.account ? vscode.l10n.t("signed in as {0}", state.account) : vscode.l10n.t("connected"))
				: state.kind === 'unreachable' ? (tool === 'figma' ? vscode.l10n.t("Figma isn't open") : vscode.l10n.t("can't reach, check your VPN"))
					: state.kind === 'auth' ? vscode.l10n.t("token refused")
						: state.kind === 'notInstalled' ? vscode.l10n.t("CLI not installed")
							: state.kind === 'checking' ? vscode.l10n.t("checking…")
								: vscode.l10n.t("not working");
			md.appendMarkdown(`![](${logo.toString()}|width=14,height=14) ${escapeMarkdown(teamToolNames[tool])}: ${escapeMarkdown(word)}  \n`);
		}
		md.appendMarkdown(`\n${vscode.l10n.t("Click to open Connections.")}`);
		return md;
	}
}

/** A tool's state in a word or two, as the status bar shows it. */
function word(tool: TeamToolId, kind: TeamToolStateKind): string {
	const name = teamToolNames[tool];
	switch (kind) {
		case 'connected': return vscode.l10n.t("{0} ✓", name);
		case 'checking': return vscode.l10n.t("{0}: checking", name);
		case 'unreachable': return tool === 'figma' ? vscode.l10n.t("Figma: not open") : vscode.l10n.t("{0}: VPN off", name);
		case 'auth': return tool === 'snyk' ? vscode.l10n.t("{0}: not signed in", name) : vscode.l10n.t("{0}: token refused", name);
		case 'notInstalled': return vscode.l10n.t("{0}: not installed", name);
		default: return vscode.l10n.t("{0}: not working", name);
	}
}

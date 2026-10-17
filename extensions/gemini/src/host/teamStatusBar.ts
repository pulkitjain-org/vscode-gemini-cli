/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import { teamStatusSummary } from '../acp/teamStatus';
import { escapeMarkdown } from './markdown';
import type { TeamConnections } from './teamConnections';

/** How stale the tools' state may get before focusing the window checks them again. */
const recheckMs = 5 * 60_000;

/**
 * One status bar item for the team's tools: hidden until one is connected,
 * then one word for all of them ("Connected", "VPN off", "Needs attention"),
 * with each tool's logo and state in the tooltip. Clicking opens Connections.
 */
export class TeamStatusBar implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('gemini.teamTools', vscode.StatusBarAlignment.Right, 101);
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
		const affected = summary.affected.map(tool => teamToolNames[tool]).join(', ');
		switch (summary.word) {
			case 'attention':
				this.item.text = `$(warning) ${vscode.l10n.t("{0} needs attention", affected)}`;
				this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
				break;
			case 'vpnOff':
				this.item.text = `$(debug-disconnect) ${vscode.l10n.t("VPN off")}`;
				this.item.backgroundColor = undefined;
				break;
			case 'checking':
				this.item.text = `$(sync~spin) ${vscode.l10n.t("Checking tools")}`;
				this.item.backgroundColor = undefined;
				break;
			default:
				this.item.text = `$(plug) ${vscode.l10n.t("Connected")}`;
				this.item.backgroundColor = undefined;
		}
		this.item.accessibilityInformation = { label: vscode.l10n.t("Team tools: {0}", this.item.text.replace(/\$\([^)]*\)\s*/, '')) };
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

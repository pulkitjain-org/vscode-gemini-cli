/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatCounts } from '../acp/agentChanges';
import { AgentsView, AgentSummary, relativeTime } from './agentsView';
import { tildify } from './displayText';
import { configSection } from './configuration';
import { FromHome, HomeAgent, HomeStrings, HomeView, ToHome } from './panelProtocol';
import { createNonce, escapeAttribute } from './webviewHtml';

const homeViewType = 'gemini.agentHome';
/** Earlier agents listed; the Agents pane has them all. */
const maxEarlier = 8;
/** How often agent updates reach the page at most. */
const updateDelayMs = 200;

type Mode = 'agents' | 'editor';

/**
 * Agent Home: where Agents mode starts. A composer starts a new agent in one
 * step, cards show the agents that are working, waiting or have changes to
 * review, and earlier agents can be resumed. It opens whenever the editor
 * area is empty in Agents mode, and from the Agents pane. The page loads only
 * when first shown.
 */
export class AgentHome implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private mode: Mode = 'editor';
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The last view posted, to skip posting the same one again. */
	private lastView: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly agents: AgentsView) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.agentHome', () => this.show(false)),
			// GeminiCode's workbench reports the window mode.
			vscode.commands.registerCommand('_gemini.modeChanged', (mode: Mode) => this.setMode(mode)),
			vscode.window.tabGroups.onDidChangeTabs(e => {
				// Closing Agent Home itself leaves the area empty on purpose.
				if (this.mode === 'agents' && e.closed.length && !e.closed.some(isHomeTab) && openTabs() === 0) {
					this.show(true);
				}
			}),
			agents.onDidChangeAgents(() => this.schedule()),
		);
		void Promise.resolve(vscode.commands.executeCommand<Mode>('_gemini.getMode')).then(mode => this.setMode(mode), () => undefined);
	}

	show(preserveFocus: boolean): void {
		if (this.panel) {
			this.panel.reveal(undefined, preserveFocus);
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(homeViewType, vscode.l10n.t("Agent Home"), { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
			enableScripts: true,
			localResourceRoots: [media],
		});
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'gemini.svg');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromHome) => this.onMessage(message));
		panel.onDidChangeViewState(e => e.webviewPanel.visible && this.schedule(0));
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		this.panel = panel;
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private setMode(mode: Mode | undefined): void {
		this.mode = mode === 'agents' ? 'agents' : 'editor';
		if (this.mode === 'agents' && openTabs() === 0) {
			this.show(true);
		}
	}

	private schedule(delay = updateDelayMs): void {
		if (!this.panel?.visible) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.update(), delay);
	}

	private async update(): Promise<void> {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const view = await this.build();
		const json = JSON.stringify(view);
		// Closed while building (the webview throws once disposed), or nothing changed.
		if (this.panel !== panel || json === this.lastView) {
			return;
		}
		this.lastView = json;
		void panel.webview.postMessage({ type: 'view', view } satisfies ToHome);
	}

	private async build(): Promise<HomeView> {
		const now = Date.now();
		const workspaces = (await this.agents.workspaces()).map(w => ({ folder: w.folder, name: path.basename(w.folder) || w.folder, description: tildify(path.dirname(w.folder)), git: w.git }));
		const summaries = this.agents.summaries();
		const isActive = (a: AgentSummary) => a.state === 'working' || a.state === 'waiting' || a.state === 'done' || a.state === 'error' || !!a.changes?.files;
		const toView = (a: AgentSummary): HomeAgent => ({
			id: a.id, title: a.title, workspace: path.basename(a.folder), state: a.state, status: a.status,
			...(a.changes?.files ? { changes: a.changes.files === 1 ? vscode.l10n.t("{0} in 1 file", formatCounts(a.changes)) : vscode.l10n.t("{0} in {1} files", formatCounts(a.changes), a.changes.files) } : {}),
			...(a.worktree ? { branch: a.worktree.branch } : {}),
			updated: relativeTime(a.updatedAt, now),
		});
		return {
			workspaces,
			active: summaries.filter(isActive).map(toView),
			earlier: summaries.filter(a => !isActive(a)).slice(0, maxEarlier).map(toView),
			ownBranch: vscode.workspace.getConfiguration(configSection).get<boolean>('agents.ownBranch', false),
		};
	}

	private async onMessage(message: FromHome): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.lastView = undefined;
				await this.update();
				void this.panel?.webview.postMessage({ type: 'focus' } satisfies ToHome);
				return;
			case 'start':
				if (message.text.trim()) {
					if (!await this.agents.startWithPrompt(message.folder, message.text.trim(), message.ownBranch)) {
						void this.panel?.webview.postMessage({ type: 'startFailed', text: message.text } satisfies ToHome);
					}
				}
				return;
			case 'addFolder':
				await vscode.commands.executeCommand('workbench.action.addRootFolder');
				return;
			case 'projectHelpers':
				await vscode.commands.executeCommand('gemini.projectSettings');
				return;
			case 'open':
				await this.agents.open(message.id);
				return;
			case 'stop':
				this.agents.stopTurn(message.id);
				return;
			case 'review':
				await this.agents.openChanges(message.id);
				return;
			case 'mergeBack':
				await this.agents.mergeBack(message.id);
				return;
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: HomeStrings = {
			title: vscode.l10n.t("What should an agent do?"),
			subtitle: vscode.l10n.t("Describe the task. A new agent starts on it right away, and you can start more while it works."),
			placeholder: vscode.l10n.t("Fix the rounding in the cart total and add a test"),
			start: vscode.l10n.t("Start Agent"),
			ownBranch: vscode.l10n.t("On its own branch"),
			ownBranchHint: vscode.l10n.t("The agent works in its own copy of the repository, on a new branch. Merge Back brings its work into yours."),
			workspace: vscode.l10n.t("Workspace"),
			addFolder: vscode.l10n.t("Add Folder to Workspace..."),
			projectHelpers: vscode.l10n.t("Project Helpers"),
			projectHelpersHint: vscode.l10n.t("MCP servers, rules and hooks for your projects"),
			active: vscode.l10n.t("Agents"),
			earlier: vscode.l10n.t("Earlier"),
			open: vscode.l10n.t("Open"),
			stop: vscode.l10n.t("Stop"),
			review: vscode.l10n.t("Review"),
			mergeBack: vscode.l10n.t("Merge Back"),
			noAgents: vscode.l10n.t("No agents are running. Start one above."),
			noWorkspace: vscode.l10n.t("Add a workspace folder for agents to work in."),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'home.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const menuStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'menu.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${menuStyle}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>Agent Home</title>
</head>
<body class="agent-home">
	<main class="home">
		<section class="home-start">
			<h1 id="title"></h1>
			<p id="subtitle" class="muted"></p>
			<form id="composer" class="home-composer">
				<textarea id="prompt" rows="3"></textarea>
				<div class="home-composer-bar">
					<span class="spacer"></span>
					<button type="submit" id="start" class="send"><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>
				</div>
			</form>
			<div class="home-options">
				<span class="home-folder"><button type="button" id="workspace" class="option-button"><i class="codicon codicon-folder" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button><div id="workspace-menu" class="home-menu" hidden></div></span>
				<label id="own-branch-label" class="option-switch"><input type="checkbox" id="own-branch"><span class="switch-track" aria-hidden="true"></span><span class="switch-label"></span></label>
				<button type="button" id="helpers" class="option-button helpers-button"><i class="codicon codicon-tools" aria-hidden="true"></i><span></span></button>
			</div>
		</section>
		<section id="active" class="home-section"></section>
		<section id="earlier" class="home-section"></section>
	</main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

function openTabs(): number {
	return vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0);
}

function isHomeTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(homeViewType);
}

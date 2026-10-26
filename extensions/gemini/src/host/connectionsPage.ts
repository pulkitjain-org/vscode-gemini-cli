/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isRecord, readSettingsFile } from '../acp/projectSettings';
import { allowlistBlock, allowServer, settingsFiles } from '../acp/projectToolsCheck';
import type { TeamDefaults } from '../acp/teamDefaults';
import { TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import { teamToolsServerName } from '../acp/teamTools';
import type { ConnectionRowView, ConnectionsStrings, ConnectionsView, FromConnections, TeamServerView, ToConnections } from './connectionsProtocol';
import { tildify } from './displayText';
import { ConnectionState, createTokenUrl, TeamConnections } from './teamConnections';
import { takeOverTeamServers } from './teamTakeover';
import { createNonce, escapeAttribute } from './webviewHtml';
import { showError } from './errorNotice';

const viewType = 'gemini.connections';

/**
 * Connections: one row per team tool with the account it is signed in as,
 * and Connect, Replace Token and Disconnect. The last known state shows at
 * once and every connected tool is checked again in the background each time
 * the page opens. Tokens are typed into the page and go straight to the
 * keychain through `TeamConnections.connect`, which checks them first.
 */
export class ConnectionsPage implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private defaults: TeamDefaults = {};
	private allowlist: ConnectionsView['allowlist'] & { readonly path: string } | undefined;
	private teamServers: ConnectionsView['teamServers'] & { readonly path: string } | undefined;
	private updating = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly connections: TeamConnections, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.connections', () => this.show()),
			connections.onDidChange(() => this.scheduleUpdate()),
		);
	}

	dispose(): void {
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	show(): void {
		if (this.panel) {
			this.panel.reveal();
			void this.connections.refresh();
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(viewType, vscode.l10n.t("Connections"), vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [media],
		});
		panel.iconPath = new vscode.ThemeIcon('plug');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromConnections) => void this.onMessage(message));
		panel.onDidChangeViewState(e => e.webviewPanel.visible && this.scheduleUpdate());
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		this.panel = panel;
	}

	private scheduleUpdate(): void {
		if (this.updating) {
			return;
		}
		this.updating = true;
		queueMicrotask(() => {
			this.updating = false;
			this.post({ type: 'view', view: this.view() });
		});
	}

	private post(message: ToConnections): void {
		void this.panel?.webview.postMessage(message);
	}

	private async onMessage(message: FromConnections): Promise<void> {
		switch (message.type) {
			case 'ready':
				// The saved state first, then what the files and tools say now.
				this.post({ type: 'view', view: this.view() });
				void this.readFiles().then(() => this.scheduleUpdate());
				void this.connections.refresh();
				return;
			case 'connect':
				if (!isTool(message.tool)) {
					return;
				}
				try {
					await this.connections.connect(message.tool, { url: message.url, email: message.email, token: message.token });
					this.post({ type: 'connectResult', tool: message.tool, ok: true });
				} catch (err) {
					const text = err instanceof Error ? err.message : String(err);
					this.post({ type: 'connectResult', tool: message.tool, ok: false, message: text });
					if (message.tool === 'snyk' || message.tool === 'figma') {
						// No dialog to show it in.
						void showError(text);
					}
				}
				return;
			case 'disconnect':
				if (isTool(message.tool)) {
					await this.connections.disconnect(message.tool);
				}
				return;
			case 'refresh':
				if (isTool(message.tool)) {
					await this.connections.refresh([message.tool]);
				}
				return;
			case 'createToken': {
				const url = isTool(message.tool) ? createTokenUrl(message.tool, message.url ?? this.urlOf(message.tool).url) : undefined;
				if (url) {
					await vscode.env.openExternal(vscode.Uri.parse(url));
				}
				return;
			}
			case 'openFigma':
				await vscode.env.openExternal(vscode.Uri.parse('figma://'));
				// Its MCP server starts with the app; look again shortly.
				setTimeout(() => void this.connections.refresh(['figma']), 5000);
				return;
			case 'allowlist':
				if (this.allowlist) {
					const done = await allowServer(this.allowlist.path, teamToolsServerName).catch(() => false);
					if (!done) {
						void vscode.window.showWarningMessage(vscode.l10n.t("GeminiCode can't rewrite {0} because it isn't valid JSON. Remove \"{1}\" from mcp.excluded there yourself.", this.allowlist.file, teamToolsServerName));
						await this.openFile(this.allowlist.path, 'excluded');
					}
					await this.readFiles();
					this.scheduleUpdate();
				}
				return;
			case 'openAllowlistFile':
				if (this.allowlist) {
					await this.openFile(this.allowlist.path, this.allowlist.kind === 'excluded' ? 'excluded' : 'admin');
				}
				return;
			case 'openDefaults':
				if (this.defaults.file) {
					await this.openFile(this.defaults.file);
				}
				return;
			case 'checkAll':
				await this.connections.refresh();
				return;
			case 'openTeamServers':
				if (this.teamServers) {
					await this.openFile(this.teamServers.path, 'mcpServers');
				}
				return;
			case 'takeOverTeamServers':
				if (this.teamServers && await takeOverTeamServers(this.connections, this.teamServers.path, this.log)) {
					await this.readFiles();
					this.scheduleUpdate();
				}
				return;
		}
	}

	private async openFile(file: string, needle?: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument(file);
		const offset = needle ? document.getText().indexOf(`"${needle}"`) : -1;
		const position = offset >= 0 ? document.positionAt(offset) : new vscode.Position(0, 0);
		await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
	}

	/** The team's defaults file and any allowlist that leaves the tools out, from the open folders. */
	private async readFiles(): Promise<void> {
		this.defaults = await this.connections.workspaceDefaults();
		this.allowlist = undefined;
		this.teamServers = undefined;
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const settings = path.join(folder.uri.fsPath, '.gemini', 'settings.json');
			const servers = teamServersIn(await readSettingsFile(settings));
			if (servers.length && !this.teamServers) {
				this.teamServers = { file: tildify(settings), path: settings, servers };
			}
			const block = await allowlistBlock(teamToolsServerName, settingsFiles({ workspace: folder.uri.fsPath }));
			if (block) {
				this.allowlist = { kind: block.kind, file: tildify(block.file), path: block.file };
				return;
			}
		}
	}

	private urlOf(tool: TeamToolId): { url?: string; fromDefaults: boolean } {
		const saved = this.connections.accountOf(tool)?.url;
		if (saved) {
			return { url: saved, fromDefaults: false };
		}
		const fromDefaults = tool === 'jira' ? this.defaults.jira?.site : tool === 'gitlab' ? this.defaults.gitlab?.url : tool === 'sonar' ? this.defaults.sonar?.url : undefined;
		return { url: fromDefaults, fromDefaults: !!fromDefaults };
	}

	private view(): ConnectionsView {
		return {
			rows: teamToolIds.map(tool => this.row(tool)),
			...this.defaults.file ? { defaultsFile: tildify(this.defaults.file) } : {},
			...this.allowlist ? { allowlist: { kind: this.allowlist.kind, file: this.allowlist.file } } : {},
			...this.teamServers ? { teamServers: { file: this.teamServers.file, servers: this.teamServers.servers } } : {},
		};
	}

	private row(tool: TeamToolId): ConnectionRowView {
		const saved = this.connections.connected.has(tool);
		const state = saved || this.connections.isConnecting(tool) ? this.connections.state(tool) : { kind: 'off' as const };
		const { url, fromDefaults } = this.urlOf(tool);
		const needsToken = tool === 'jira' || tool === 'gitlab' || tool === 'sonar';
		return {
			tool,
			name: teamToolNames[tool],
			kind: state.kind,
			label: stateLabel(tool, state),
			detail: stateDetail(tool, state, url),
			pills: pillsOf(tool, state, url, this.connections.childOf(tool)),
			...saved && state.kind === 'connected' ? { token: tokenLine(tool, state) } : {},
			saved,
			needsToken,
			...url ? { url } : {},
			urlFromDefaults: fromDefaults,
			...tool === 'jira' && this.connections.accountOf(tool)?.email ? { email: this.connections.accountOf(tool)!.email } : {},
			canCreateToken: needsToken && (tool === 'jira' || !!url),
		};
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: ConnectionsStrings = {
			title: vscode.l10n.t("Connections"),
			subtitle: vscode.l10n.t("Each tool with your own account. Agents can then read tickets, merge requests, designs and checks. Everything runs from this Mac over your VPN, and your tokens stay in the macOS keychain."),
			tools: vscode.l10n.t("Tools"),
			toolsHint: vscode.l10n.t("Agents get tools only for what you connect."),
			checkAll: vscode.l10n.t("Check All"),
			teamServersTitle: vscode.l10n.t("This repository's {0} runs {1} as MCP servers of the CLI"),
			teamServersText: vscode.l10n.t("Agents see two sets of Jira and GitLab tools, and the servers' tokens come from your shell environment, which the agent's shell tool can read. Take them over to keep the tokens in the keychain and run the same servers behind GeminiCode's team tools, which ask before every write."),
			takeOverServers: vscode.l10n.t("Take Over Both Servers..."),
			teamServerLine: vscode.l10n.t("{0} · token from {1} in your shell"),
			teamServerIncluded: vscode.l10n.t("{0} tools kept by the file"),
			teamServerExcluded: vscode.l10n.t("{0} tools left out by the file"),
			openSettings: vscode.l10n.t("Open Settings File"),
			defaultsHint: vscode.l10n.t("Defaults for the server addresses come from {0}."),
			connect: vscode.l10n.t("Connect"),
			replaceToken: vscode.l10n.t("Replace Token"),
			disconnect: vscode.l10n.t("Disconnect"),
			tryAgain: vscode.l10n.t("Try Again"),
			openFigma: vscode.l10n.t("Open Figma"),
			cancel: vscode.l10n.t("Cancel"),
			connectTitle: vscode.l10n.t("Connect {0}"),
			server: vscode.l10n.t("Server"),
			serverHint: vscode.l10n.t("The address you open {0} at in the browser."),
			serverHintDefaults: vscode.l10n.t("From your team's defaults."),
			serverHintVpn: vscode.l10n.t("{0} is only reachable on the VPN."),
			email: vscode.l10n.t("Email"),
			emailHint: vscode.l10n.t("The email you sign in to Jira with."),
			token: vscode.l10n.t("Token"),
			tokenHintJira: vscode.l10n.t("An Atlassian API token. The link opens your Atlassian account's token page."),
			tokenHintGitlab: vscode.l10n.t("A personal access token with the api scope. The link opens GitLab with the name and scope filled in."),
			tokenHintSonar: vscode.l10n.t("A user token. The link opens your SonarQube account's Security page."),
			createToken: vscode.l10n.t("Create Token"),
			keychainNote: vscode.l10n.t("The token is kept in your macOS keychain. It is never written to settings files, and agents never see it. GeminiCode calls {0} from this Mac only."),
			checking: vscode.l10n.t("Checking…"),
			connected: vscode.l10n.t("Connected"),
			snykConnectHint: vscode.l10n.t("Uses the Snyk CLI on this Mac, signed in with snyk auth and pointed at your team's Snyk. GeminiCode never sees a Snyk token."),
			figmaConnectHint: vscode.l10n.t("Uses the Figma desktop app with your Dev seat. Turn on the Dev Mode MCP server in Figma's Preferences; no token needed."),
			permissions: vscode.l10n.t("What agents may do"),
			permissionsHint: vscode.l10n.t("Reading is always allowed. Changes ask you first, even in Auto Edit. Every answer goes to the audit log with the id Jira or GitLab returns."),
			writes: vscode.l10n.t("Comment on tickets, reply to reviews, reassign"),
			writesDetail: vscode.l10n.t("jira_comment · gitlab_reply · jira_assign: the exact text, with Allow for this session"),
			confirmWrites: vscode.l10n.t("Move tickets, log time, open merge requests, merge"),
			confirmWritesDetail: vscode.l10n.t("jira_transition · jira_log_time · gitlab_create_mr · gitlab_merge: hard to take back, so no session option"),
			reads: vscode.l10n.t("Read tickets, merge requests, checks and designs"),
			readsDetail: vscode.l10n.t("Jira, GitLab, SonarQube, Snyk and Figma"),
			askEachTime: vscode.l10n.t("Ask each time"),
			askOnceOnly: vscode.l10n.t("Ask every time, Allow once only"),
			alwaysAllowed: vscode.l10n.t("Always allowed"),
			allowlistExcluded: vscode.l10n.t("{0} leaves out {1} in mcp.excluded, so agents won't get these tools."),
			allowlistAdminOff: vscode.l10n.t("MCP servers are turned off in {0}, so agents won't get these tools."),
			removeExclusion: vscode.l10n.t("Remove Exclusion"),
			openFile: vscode.l10n.t("Open File"),
			close: vscode.l10n.t("Close"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'connections.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const pageStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'connections.css'));
		const menuStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'menu.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		const glassStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'glass.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${menuStyle}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<link href="${pageStyle}" rel="stylesheet">
	<link href="${glassStyle}" rel="stylesheet">
	<title>${strings.title}</title>
</head>
<body class="settings-page connections-page">
	<main id="page" class="settings connections"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

function isTool(value: unknown): value is TeamToolId {
	return teamToolIds.includes(value as TeamToolId);
}

function stateLabel(tool: TeamToolId, state: ConnectionState): string {
	switch (state.kind) {
		case 'off':
			return vscode.l10n.t("Not connected");
		case 'checking':
			return vscode.l10n.t("Checking…");
		case 'connected':
			return vscode.l10n.t("Connected");
		case 'unreachable':
			return tool === 'figma' ? vscode.l10n.t("Figma isn't open") : vscode.l10n.t("Can't reach");
		case 'auth':
			return tool === 'snyk' ? vscode.l10n.t("Not signed in") : vscode.l10n.t("Token refused");
		case 'notInstalled':
			return vscode.l10n.t("Snyk CLI not installed");
		case 'failed':
			return vscode.l10n.t("Not working");
	}
}

function hostOf(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function stateDetail(tool: TeamToolId, state: ConnectionState, url: string | undefined): string {
	if (state.kind === 'off' || state.kind === 'checking') {
		return tool === 'snyk' ? vscode.l10n.t("Uses the Snyk CLI on this Mac")
			: tool === 'figma' ? vscode.l10n.t("Uses the Figma desktop app")
				: hostOf(url) ?? '';
	}
	if (state.kind !== 'connected') {
		return state.detail ?? '';
	}
	if (tool === 'snyk') {
		const found = state.version ? vscode.l10n.t("Found snyk {0}", state.version) : '';
		const signedIn = state.server ? vscode.l10n.t("signed in to {0}", state.server) : '';
		return [vscode.l10n.t("Uses the Snyk CLI on this Mac."), [found, signedIn].filter(Boolean).join(', ')].filter(Boolean).join(' ');
	}
	if (tool === 'figma') {
		return state.detail ?? vscode.l10n.t("Through the Figma desktop app with your Dev seat: design context and screenshots by link.");
	}
	return [state.account ? vscode.l10n.t("Signed in as {0}", state.account) : '', state.detail].filter(Boolean).join('. ');
}

/** The server and its version, then how GeminiCode reaches the tool. */
function pillsOf(tool: TeamToolId, state: ConnectionState, url: string | undefined, via: string | undefined): string[] {
	const host = state.kind === 'connected' && state.server && tool !== 'snyk' ? state.server : hostOf(url);
	const version = state.kind === 'connected' && state.version && tool !== 'snyk' ? (tool === 'gitlab' ? state.version.split('.').slice(0, 2).join('.') : state.version) : undefined;
	const where = tool === 'snyk' ? [state.kind === 'connected' && state.server ? state.server : '', state.kind === 'connected' && state.version ? vscode.l10n.t("CLI {0}", state.version) : ''].filter(Boolean).join(' · ') : [host, version].filter(Boolean).join(' · ');
	const how = tool === 'figma' ? vscode.l10n.t("Dev Mode MCP server, 127.0.0.1:3845")
		: tool === 'snyk' ? via ? vscode.l10n.t("{0}, this Mac", via) : vscode.l10n.t("Snyk CLI, this Mac")
			: via ? vscode.l10n.t("{0}, this Mac", via) : vscode.l10n.t("REST from this Mac");
	return [where, how].filter(Boolean);
}

/** Where the tool's token lives, and when it expires. */
function tokenLine(tool: TeamToolId, state: ConnectionState): string {
	if (tool === 'snyk' || tool === 'figma') {
		return vscode.l10n.t("No token held by GeminiCode.");
	}
	return state.expires ? vscode.l10n.t("Token: in the macOS keychain · expires {0}", formatDate(state.expires)) : vscode.l10n.t("Token: in the macOS keychain");
}

/** The Jira and GitLab servers a repository's `.gemini/settings.json` makes the CLI run, with what the file says about each. */
function teamServersIn(settings: Record<string, unknown>): TeamServerView[] {
	const servers = isRecord(settings.mcpServers) ? settings.mcpServers : {};
	return Object.entries(servers).flatMap(([name, entry]): TeamServerView[] => {
		if (!/^(jira|gitlab)$/i.test(name) || !isRecord(entry)) {
			return [];
		}
		const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
		const image = args.find(a => /^[\w.-]+(\/[\w.-]+)+(:[\w.-]+)?$/.test(a));
		const env = isRecord(entry.env) ? Object.keys(entry.env) : [];
		const included = Array.isArray(entry.includeTools) ? entry.includeTools.length : undefined;
		const excluded = Array.isArray(entry.excludeTools) ? entry.excludeTools.length : undefined;
		return [{ name, ...image ? { image } : {}, tokenEnv: env.filter(k => /TOKEN|SECRET|PASSWORD/i.test(k)), ...included ? { included } : {}, ...excluded ? { excluded } : {} }];
	});
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	return isNaN(date.getTime()) ? iso : date.toLocaleDateString(vscode.env.language, { day: 'numeric', month: 'short', year: 'numeric' });
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { allowlistBlock, allowServer, settingsFiles } from '../acp/projectToolsCheck';
import type { TeamDefaults } from '../acp/teamDefaults';
import { TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import { teamToolsServerName } from '../acp/teamTools';
import type { ConnectionRowView, ConnectionsStrings, ConnectionsView, FromConnections, ToConnections } from './connectionsProtocol';
import { tildify } from './displayText';
import { ConnectionState, createTokenUrl, TeamConnections } from './teamConnections';
import { createNonce, escapeAttribute } from './webviewHtml';

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
	private updating = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly connections: TeamConnections) {
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
						void vscode.window.showErrorMessage(text);
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
						void vscode.window.showWarningMessage(vscode.l10n.t("GeminiCode can't rewrite {0} because it has comments. Add \"{1}\" to mcp.allowed there yourself.", this.allowlist.file, teamToolsServerName));
						await this.openFile(this.allowlist.path, 'allowed');
					}
					await this.readFiles();
					this.scheduleUpdate();
				}
				return;
			case 'openAllowlistFile':
				if (this.allowlist) {
					await this.openFile(this.allowlist.path, 'allowed');
				}
				return;
			case 'openDefaults':
				if (this.defaults.file) {
					await this.openFile(this.defaults.file);
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
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
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
		};
	}

	private row(tool: TeamToolId): ConnectionRowView {
		const saved = this.connections.connected.has(tool);
		const state = saved ? this.connections.state(tool) : { kind: 'off' as const };
		const { url, fromDefaults } = this.urlOf(tool);
		const needsToken = tool === 'jira' || tool === 'gitlab' || tool === 'sonar';
		return {
			tool,
			name: teamToolNames[tool],
			kind: state.kind,
			label: stateLabel(tool, state),
			detail: stateDetail(tool, state, url),
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
			subtitle: vscode.l10n.t("Sign in to your team's tools with your own account. Agents can then read tickets, merge requests, designs and checks. Everything runs from this Mac over your VPN, and your tokens stay in the macOS keychain."),
			tools: vscode.l10n.t("Tools"),
			toolsHint: vscode.l10n.t("Agents get tools only for what you connect."),
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
			permissionsHint: vscode.l10n.t("Reading is always allowed. Changes ask you first, even in Auto Edit."),
			jiraWrites: vscode.l10n.t("Move tickets, comment on them and log time"),
			jiraWritesDetail: vscode.l10n.t("Jira status changes, comments and work logs"),
			gitlabWrites: vscode.l10n.t("Open merge requests and reply to reviews"),
			gitlabWritesDetail: vscode.l10n.t("GitLab"),
			reads: vscode.l10n.t("Read tickets, merge requests, checks and designs"),
			readsDetail: vscode.l10n.t("Jira, GitLab, SonarQube, Snyk and Figma"),
			askEachTime: vscode.l10n.t("Ask each time"),
			alwaysAllowed: vscode.l10n.t("Always allowed"),
			allowlistNotAllowed: vscode.l10n.t("{0} allows only the MCP servers in mcp.allowed, and {1} isn't one, so agents won't get these tools."),
			allowlistExcluded: vscode.l10n.t("{0} leaves out {1} in mcp.excluded, so agents won't get these tools."),
			allowlistAdminOff: vscode.l10n.t("MCP servers are turned off in {0}, so agents won't get these tools."),
			addToAllowlist: vscode.l10n.t("Add to Allowlist"),
			openFile: vscode.l10n.t("Open File"),
			close: vscode.l10n.t("Close"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'connections.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const pageStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'connections.css'));
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
	<link href="${pageStyle}" rel="stylesheet">
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
		return state.detail ?? vscode.l10n.t("Through the Figma desktop app.");
	}
	const parts = [
		state.account ? vscode.l10n.t("Signed in as {0}", state.account) : undefined,
		state.server,
		state.version ? `${teamToolNames[tool]} ${tool === 'gitlab' ? state.version.split('.').slice(0, 2).join('.') : state.version}` : undefined,
		state.expires ? vscode.l10n.t("token expires {0}", formatDate(state.expires)) : undefined,
	].filter(Boolean);
	return [parts.join(' · '), state.detail].filter(Boolean).join('. ');
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	return isNaN(date.getTime()) ? iso : date.toLocaleDateString(vscode.env.language, { day: 'numeric', month: 'short', year: 'numeric' });
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { geminiDir } from '../acp/directRequest';
import { errorMessage } from '../acp/errors';
import { addMcpServer, disabledServers, isServerEnabled, mcpServersIn, readSettingsFile, rulesFileNames, serverConfigFrom, setServerEnabled } from '../acp/projectSettings';
import { AgentService } from './agentService';
import { tildify } from './agentsView';
import { FromSettingsPage, McpServerView, RulesFileView, SettingsPageStrings, SettingsPageView, ToSettingsPage } from './panelProtocol';
import { createNonce, escapeAttribute } from './webviewHtml';

const viewType = 'gemini.projectSettings';

/**
 * MCP Servers and Rules: the MCP servers in the Gemini CLI's settings, each
 * with a switch and why it failed to start, and the rules (GEMINI.md) files
 * every agent reads. It edits the CLI's own files, so the terminal CLI sees
 * the same. The page reads them when shown and after each change.
 */
export class SettingsPage implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	/** The files the page shows; the only ones it may open or create. */
	private files = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly service: AgentService) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.projectSettings', () => this.show()),
			service.onDidChangeMcpProblems(() => void this.update()),
		);
	}

	show(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(viewType, vscode.l10n.t("MCP Servers and Rules"), vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [media],
		});
		panel.iconPath = new vscode.ThemeIcon('server-environment');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromSettingsPage) => this.onMessage(message));
		panel.onDidChangeViewState(e => e.webviewPanel.active && void this.update());
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		this.panel = panel;
	}

	dispose(): void {
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async update(): Promise<void> {
		const panel = this.panel;
		if (!panel?.visible) {
			return;
		}
		const view = await this.build();
		if (this.panel !== panel) {
			return;
		}
		this.files = new Set([...view.servers.map(s => s.file), ...view.rules.map(r => r.path)]);
		void panel.webview.postMessage({ type: 'view', view } satisfies ToSettingsPage);
	}

	private personalSettings(): string {
		return path.join(geminiDir(), 'settings.json');
	}

	private async build(): Promise<SettingsPageView> {
		const dir = geminiDir();
		const personal = await readSettingsFile(this.personalSettings());
		const folders = vscode.workspace.workspaceFolders ?? [];
		const projects = await Promise.all(folders.map(async folder => {
			const file = path.join(folder.uri.fsPath, '.gemini', 'settings.json');
			return { folder, file, settings: await readSettingsFile(file) };
		}));
		const disabled = await disabledServers(path.join(dir, 'mcp-server-enablement.json'));
		const problems = new Map(this.service.mcpProblems.filter(p => p.server).map(p => [p.server!, p.message]));
		const servers: McpServerView[] = [];
		const seen = new Set<string>();
		// A project's server of the same name replaces the personal one, as in the CLI.
		for (const { folder, file, settings } of projects) {
			for (const server of mcpServersIn(settings, file)) {
				seen.add(server.name);
				servers.push(this.serverView(server, folder.name, disabled, problems));
			}
		}
		for (const server of mcpServersIn(personal, this.personalSettings())) {
			if (!seen.has(server.name)) {
				servers.push(this.serverView(server, vscode.l10n.t("Personal"), disabled, problems));
			}
		}
		const rules: RulesFileView[] = [];
		for (const { folder, settings } of projects) {
			const name = plainFileName(rulesFileNames({ ...personal, ...settings })[0]);
			const file = path.join(folder.uri.fsPath, name);
			rules.push(await rulesView(folders.length > 1 ? vscode.l10n.t("Project rules ({0})", folder.name) : vscode.l10n.t("Project rules"), file, name));
		}
		const personalRules = path.join(dir, plainFileName(rulesFileNames(personal)[0]));
		rules.push(await rulesView(vscode.l10n.t("Personal rules"), personalRules, tildify(personalRules)));
		return { servers, rules };
	}

	private serverView(server: ReturnType<typeof mcpServersIn>[number], scope: string, disabled: ReadonlySet<string>, problems: ReadonlyMap<string, string>): McpServerView {
		const enabled = isServerEnabled(disabled, server.name);
		const problem = enabled ? problems.get(server.name) : undefined;
		return { ...server, scope, enabled, ...(problem ? { problem } : {}) };
	}

	private async onMessage(message: FromSettingsPage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					break;
				case 'restart':
					this.service.restart();
					return;
				case 'toggle':
					await setServerEnabled(path.join(geminiDir(), 'mcp-server-enablement.json'), message.name, message.enabled);
					this.offerRestart(message.enabled
						? vscode.l10n.t("\"{0}\" is on for new agents.", message.name)
						: vscode.l10n.t("\"{0}\" is off for new agents.", message.name));
					break;
				case 'addServer':
					await this.addServer();
					break;
				case 'openFile':
					if (!this.files.has(message.path)) {
						return;
					}
					await openAt(message.path, message.server && `"${message.server}"`);
					return;
				case 'createRules':
					if (!this.files.has(message.path)) {
						return;
					}
					await fs.mkdir(path.dirname(message.path), { recursive: true });
					await fs.writeFile(message.path, `# ${vscode.l10n.t("Rules for Gemini")}\n\n`, { flag: 'wx' }).catch(() => undefined);
					await openAt(message.path);
					break;
			}
		} catch (err) {
			void vscode.window.showErrorMessage(errorMessage(err));
		}
		await this.update();
	}

	private async addServer(): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t("Add MCP Server (1/2)"),
			prompt: vscode.l10n.t("A short name for the server"),
			placeHolder: 'github',
			validateInput: value => /^[\w.-]+$/.test(value.trim()) ? undefined : vscode.l10n.t("Use letters, numbers, dots, dashes and underscores."),
		});
		if (!name) {
			return;
		}
		const target = await vscode.window.showInputBox({
			title: vscode.l10n.t("Add MCP Server (2/2)"),
			prompt: vscode.l10n.t("The command that starts the server, or its URL"),
			placeHolder: 'npx -y @modelcontextprotocol/server-github',
			validateInput: value => value.trim() ? undefined : vscode.l10n.t("Enter a command or a URL."),
		});
		if (!target) {
			return;
		}
		const file = this.personalSettings();
		if (await addMcpServer(file, name.trim(), serverConfigFrom(target))) {
			this.offerRestart(vscode.l10n.t("Added \"{0}\". New agents can use its tools.", name.trim()));
		} else {
			void vscode.window.showWarningMessage(vscode.l10n.t("{0} has comments, so GeminiCode won't rewrite it. Add the server under \"mcpServers\" yourself.", tildify(file)));
			await openAt(file, '"mcpServers"');
		}
	}

	private offerRestart(message: string): void {
		const restart = vscode.l10n.t("Restart Agent");
		void vscode.window.showInformationMessage(message, restart).then(choice => choice === restart && this.service.restart());
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: SettingsPageStrings = {
			title: vscode.l10n.t("MCP Servers and Rules"),
			subtitle: vscode.l10n.t("What every Gemini agent loads when it starts, shared with the gemini command in your terminal. Changes apply to new agents."),
			restart: vscode.l10n.t("Restart Agent"),
			servers: vscode.l10n.t("MCP servers"),
			serversHint: vscode.l10n.t("Tools agents can use, such as GitHub, a database or your docs. A project's servers load once you trust its folder."),
			addServer: vscode.l10n.t("Add Server"),
			noServers: vscode.l10n.t("No MCP servers yet."),
			edit: vscode.l10n.t("Edit in settings"),
			enable: vscode.l10n.t("Use this server"),
			failed: vscode.l10n.t("Failed to start: {0}"),
			rules: vscode.l10n.t("Rules"),
			rulesHint: vscode.l10n.t("Instructions every agent follows, such as how to build, test and write code here."),
			open: vscode.l10n.t("Open"),
			create: vscode.l10n.t("Create"),
			missing: vscode.l10n.t("Not created yet"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'settings.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<title>${strings.title}</title>
</head>
<body class="settings-page">
	<main id="page" class="settings"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

async function rulesView(label: string, file: string, display: string): Promise<RulesFileView> {
	try {
		const text = await fs.readFile(file, 'utf8');
		const preview = text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean);
		return { label, display, path: file, exists: true, ...(preview ? { preview: preview.slice(0, 120) } : {}) };
	} catch {
		return { label, display, path: file, exists: false };
	}
}

/** Opens a file, with the cursor on the first `needle` when given. */
async function openAt(file: string, needle?: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
	const offset = needle ? document.getText().indexOf(needle) : -1;
	const position = offset >= 0 ? document.positionAt(offset) : new vscode.Position(0, 0);
	await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
}

/** A rules file name from settings, which may come from the repository: never a path that leaves its folder. */
function plainFileName(name: string): string {
	return name && path.basename(name) === name && name !== '..' && name !== '.' ? name : 'GEMINI.md';
}

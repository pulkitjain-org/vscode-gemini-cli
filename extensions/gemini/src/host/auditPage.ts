/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AuditEntry, AuditLog, renderAudit } from '../acp/auditLog';
import { teamConfirmTools } from '../acp/teamTools';
import type { AuditPageView, AuditRowView, AuditStrings, FromAudit, ToAudit } from './auditProtocol';
import { tildify } from './displayText';
import { createNonce, escapeAttribute } from './webviewHtml';

const viewType = 'gemini.auditLog';
const confirmTools = new Set(teamConfirmTools.map(tool => tool.name));

/**
 * Gemini: Open Audit Log. Every write GeminiCode made to Jira or GitLab for
 * the user, one row per write with its intent and result, by day, with the
 * intents that never got a result marked. The page reads the append-only log
 * (acp/auditLog.ts) and follows it as records are added.
 */
export class AuditPage implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private day: string | undefined;
	private updating = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly audit: AuditLog, private readonly agentTitle: (id: string) => string | undefined) {
		this.disposables.push(
			vscode.commands.registerCommand('gemini.openAuditLog', () => this.show()),
			audit.onDidAppend(() => this.scheduleUpdate()),
		);
	}

	dispose(): void {
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	show(): void {
		if (this.panel) {
			this.panel.reveal();
			this.scheduleUpdate();
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(viewType, vscode.l10n.t("Audit log"), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [media] });
		panel.iconPath = new vscode.ThemeIcon('list-unordered');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromAudit) => void this.onMessage(message));
		panel.onDidChangeViewState(e => e.webviewPanel.visible && this.scheduleUpdate());
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		this.panel = panel;
	}

	private scheduleUpdate(): void {
		if (this.updating || !this.panel) {
			return;
		}
		this.updating = true;
		// A write adds two records close together; one read covers both.
		setTimeout(() => {
			this.updating = false;
			void this.update();
		}, 300);
	}

	private async update(): Promise<void> {
		const view = await this.view();
		const message: ToAudit = { type: 'view', view };
		void this.panel?.webview.postMessage(message);
	}

	private async onMessage(message: FromAudit): Promise<void> {
		switch (message.type) {
			case 'ready':
				return this.update();
			case 'day':
				this.day = message.day;
				return this.update();
			case 'settle': {
				const entry = (await this.audit.unfinished()).find(e => e.id === message.id);
				if (entry) {
					await this.audit.settle(entry, 'checked by hand');
				}
				return;
			}
			case 'export': {
				const entries = await this.audit.read(dayDate(message.day));
				const file = path.join(os.homedir(), `geminicode-audit-${message.day}.md`);
				await fs.writeFile(file, renderAudit([{ day: message.day, entries }], await this.audit.unfinished()));
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
				return;
			}
			case 'openFolder':
				await fs.mkdir(this.audit.dir, { recursive: true });
				await vscode.env.openExternal(vscode.Uri.file(this.audit.dir));
				return;
		}
	}

	private async view(): Promise<AuditPageView> {
		const days = await this.audit.days();
		const today = new Date().toISOString().slice(0, 10);
		const day = this.day && days.includes(this.day) ? this.day : days[0] ?? today;
		const [entries, unfinished] = await Promise.all([this.audit.read(dayDate(day)), this.audit.unfinished()]);
		return {
			day,
			days: days.includes(day) ? days : [day, ...days],
			folder: tildify(this.audit.dir),
			rows: auditRows(entries, this.agentTitle),
			unfinished: unfinished.length,
		};
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: AuditStrings = {
			title: vscode.l10n.t("Audit log"),
			subtitle: vscode.l10n.t("Every write to Jira or GitLab made from GeminiCode, by you or by an agent you approved. Append-only, on this Mac: {0}"),
			day: vscode.l10n.t("Day"),
			tool: vscode.l10n.t("Tool"),
			all: vscode.l10n.t("All"),
			onlyOpen: vscode.l10n.t("Only intents without a result"),
			exportDay: vscode.l10n.t("Export the Day..."),
			openFolder: vscode.l10n.t("Open Folder"),
			columns: {
				time: vscode.l10n.t("Time"), caller: vscode.l10n.t("Caller"), action: vscode.l10n.t("Action"), effect: vscode.l10n.t("Effect"),
				answered: vscode.l10n.t("Answered"), remote: vscode.l10n.t("Remote record"), state: vscode.l10n.t("State"),
			},
			done: vscode.l10n.t("done"),
			failed: vscode.l10n.t("failed"),
			open: vscode.l10n.t("intent only"),
			noResult: vscode.l10n.t("no result: GeminiCode quit before it came"),
			markChecked: vscode.l10n.t("Mark as Checked"),
			nothing: vscode.l10n.t("Nothing recorded on this day."),
			unfinished: vscode.l10n.t("{0} unfinished"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'auditLog.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const pageStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'auditLog.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		const glassStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'glass.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<link href="${pageStyle}" rel="stylesheet">
	<link href="${glassStyle}" rel="stylesheet">
	<title>${strings.title}</title>
</head>
<body class="settings-page audit-page">
	<main id="page" class="settings audit"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

function dayDate(day: string): Date {
	return new Date(`${day}T00:00:00Z`);
}

/** "openMergeRequest" as a person reads it: "Open merge request". */
function flowName(tool: string): string {
	const words = tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function toolKind(entry: AuditEntry): AuditRowView['toolKind'] {
	if (/^jira/.test(entry.tool) || /ticket|jira/i.test(entry.tool)) {
		return 'jira';
	}
	if (/^gitlab/.test(entry.tool) || /merge|review|gitlab/i.test(entry.tool)) {
		return 'gitlab';
	}
	return 'other';
}

/** One row per write, newest first: the intent, joined with its result or failure. */
export function auditRows(entries: readonly AuditEntry[], agentTitle: (id: string) => string | undefined): AuditRowView[] {
	const byId = new Map<string, { intent?: AuditEntry; outcome?: AuditEntry }>();
	for (const entry of entries) {
		const group = byId.get(entry.id) ?? {};
		if (entry.phase === 'intent') {
			group.intent = entry;
		} else {
			group.outcome = entry;
		}
		byId.set(entry.id, group);
	}
	const rows = [...byId.values()].flatMap(({ intent, outcome }): AuditRowView[] => {
		const first = intent ?? outcome;
		if (!first) {
			return [];
		}
		const caller = first.caller === 'agent'
			? `${vscode.l10n.t("agent")} · ${(first.agent && agentTitle(first.agent)) ?? first.agent?.slice(0, 8) ?? ''}`
			: `${vscode.l10n.t("UI")} · ${flowName(first.tool)}`;
		const answered = first.caller === 'ui' ? vscode.l10n.t("you · button") : confirmTools.has(first.tool) ? vscode.l10n.t("you · Allow once") : vscode.l10n.t("you · allowed");
		return [{
			id: first.id,
			time: first.time.slice(11, 19),
			caller,
			tool: first.tool,
			toolKind: toolKind(first),
			effect: first.effect,
			answered,
			...outcome?.remote ? { remote: outcome.remote } : {},
			state: !outcome ? 'open' : outcome.phase === 'failed' ? 'failed' : 'done',
			...outcome?.error ? { error: outcome.error } : {},
		}];
	});
	return rows.sort((a, b) => b.time.localeCompare(a.time));
}

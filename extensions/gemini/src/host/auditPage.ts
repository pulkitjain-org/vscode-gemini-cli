/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
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
import { PagePanel, PageShell, SinglePage } from './pagePanel';
import { agentSetupTabs, agentSetupTabsLabel, agentSetupTitle, openAgentSetupTab } from './agentSetupTabs';
import { StorageSection, type StorageHost } from './storageSection';

const viewType = 'gemini.auditLog';
const confirmTools = new Set(teamConfirmTools.map(tool => tool.name));

/**
 * Gemini: Open Audit Log. Every write GeminiCode made to Jira or GitLab for
 * the user, one row per write with its intent and result, by day, with the
 * intents that never got a result marked. The page reads the append-only log
 * (acp/auditLog.ts) and follows it as records are added.
 */
export class AuditPage implements vscode.Disposable {

	private readonly page = new SinglePage<ToAudit, FromAudit>(() => this.create());
	private day: string | undefined;
	private updating = false;
	private readonly disposables: vscode.Disposable[] = [];

	/** The Storage section, measured the first time it scrolls into view. */
	private readonly storage: StorageSection | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly audit: AuditLog, private readonly agentTitle: (id: string) => string | undefined, storageHost?: StorageHost) {
		this.storage = storageHost && new StorageSection(storageHost, () => this.scheduleUpdate());
		this.disposables.push(
			vscode.commands.registerCommand('gemini.openAuditLog', () => this.show()),
			audit.onDidAppend(() => this.scheduleUpdate()),
		);
	}

	dispose(): void {
		this.page.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	show(): void {
		if (this.page.show()) {
			this.scheduleUpdate();
		}
	}

	private create(): PagePanel<ToAudit, FromAudit> {
		const page = new PagePanel<ToAudit, FromAudit>(this.extensionUri, { viewType, title: agentSetupTitle('audit'), icon: new vscode.ThemeIcon('list-unordered'), openTab: tab => void openAgentSetupTab(tab).then(() => this.page.dispose()) }, this.shell(), message => this.onMessage(message));
		page.onDidChangeVisibility(visible => visible && this.scheduleUpdate());
		return page;
	}

	private scheduleUpdate(): void {
		if (this.updating || !this.page.page) {
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
		this.page.post({ type: 'view', view: await this.view() });
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
			case 'measureStorage':
				void this.storage?.measure();
				return;
			case 'cleanUp':
				await this.storage?.cleanUp();
				return;
			case 'setKeepLogs':
				await this.storage?.setKeepLogs(message.days);
				return;
			case 'storageAction':
				await this.storage?.action(message.action);
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
			...this.storage ? { storage: this.storage.view() } : {},
		};
	}

	private shell(): PageShell {
		const strings: AuditStrings = {
			title: vscode.l10n.t("Storage & Audit"),
			auditTitle: vscode.l10n.t("Audit log"),
			storage: vscode.l10n.t("Storage"),
			storageHint: vscode.l10n.t("What GeminiCode keeps on this Mac, and how much room each part takes."),
			storageMeasuring: vscode.l10n.t("Measuring\u2026"),
			keepLogs: vscode.l10n.t("Keep logs for"),
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
		return { script: 'auditLog.js', styles: ['auditLog.css'], title: strings.title, bodyClass: 'settings-page audit-page', mainClass: 'settings audit', strings, tabs: agentSetupTabs('audit'), tabsLabel: agentSetupTabsLabel() };
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

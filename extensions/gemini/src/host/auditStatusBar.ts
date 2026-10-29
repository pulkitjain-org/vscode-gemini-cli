/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AuditLog } from '../acp/auditLog';

/**
 * "Audit: 14 actions today" at the right of the status bar: the writes made
 * to Jira or GitLab for the user today, and any that never got their result,
 * from the audit log. Clicking opens the log. Hidden until the first write.
 */
export class AuditStatusBar implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('gemini.audit', vscode.StatusBarAlignment.Right, 101);
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly audit: AuditLog) {
		this.item.name = vscode.l10n.t("Audit Log");
		this.item.command = 'gemini.openAuditLog';
		this.item.tooltip = vscode.l10n.t("Every write made to Jira or GitLab for you today. Click to open the audit log.");
		this.disposables.push(this.item, audit.onDidAppend(() => this.schedule()));
		void this.render();
	}

	dispose(): void {
		clearTimeout(this.timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** A write adds two records close together; one render covers both. */
	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.render(), 500);
	}

	private async render(): Promise<void> {
		const [today, unfinished] = await Promise.all([this.audit.read(), this.audit.unfinished()]);
		const done = today.filter(entry => entry.phase === 'result').length;
		if (!done && !unfinished.length) {
			this.item.hide();
			return;
		}
		const actions = done === 1 ? vscode.l10n.t("Audit: 1 action today") : vscode.l10n.t("Audit: {0} actions today", done);
		this.item.text = unfinished.length ? vscode.l10n.t("{0} · {1} unfinished", actions, unfinished.length) : actions;
		this.item.show();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Evidence page (DEBUG_MODE.md, The Evidence page): a page in the
// agent's side group with every event by point, a run or all of them, the
// last two runs side by side, and the totals. Rows go a page of 200 at a
// time, and the page redraws at most once a second, from the same store the
// model and the debug bar read.

import * as vscode from 'vscode';
import { PagePanel } from '../pagePanel';
import type { DebugMode } from './debugMode';
import type { EvidenceFilter, FromEvidence, ToEvidence } from './debugProtocol';
import { evidenceStrings } from './debugStrings';

export const evidenceViewType = 'gemini.debugEvidence';
const pageRows = 200;

export class EvidencePage implements vscode.Disposable {

	private readonly page: PagePanel<ToEvidence, FromEvidence>;
	private filter: EvidenceFilter = { limit: pageRows };
	private ready = false;
	private focus: string | undefined;

	constructor(extensionUri: vscode.Uri, private mode: DebugMode, column: vscode.ViewColumn, focus?: string) {
		this.focus = focus;
		this.page = new PagePanel<ToEvidence, FromEvidence>(extensionUri, {
			viewType: evidenceViewType,
			title: vscode.l10n.t("Evidence"),
			icon: new vscode.ThemeIcon('debug-alt'),
			column: { viewColumn: column, preserveFocus: true },
		}, {
			script: 'evidence.js',
			styles: ['debug.css'],
			title: vscode.l10n.t("Evidence"),
			bodyClass: 'evidence-page',
			strings: evidenceStrings(),
		}, message => this.onMessage(message));
		this.page.onDidChangeVisibility(visible => visible && this.update());
	}

	get onDidDispose(): vscode.Event<void> {
		return this.page.onDidDispose;
	}

	/** The page follows a new Debug mode of the same agent. */
	follow(mode: DebugMode, focus?: string): void {
		this.mode = mode;
		this.focus = focus;
		this.page.reveal(undefined, true);
		this.update();
	}

	update(): void {
		if (this.ready && this.page.visible) {
			this.page.post({ type: 'view', view: this.mode.evidenceView(this.filter, this.focus) });
			this.focus = undefined;
		}
	}

	private onMessage(message: FromEvidence): void {
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.update();
				break;
			case 'filter':
				this.filter = { ...message.filter, limit: Math.max(pageRows, Math.min(message.filter.limit, 2000)) };
				this.update();
				break;
			case 'open':
				void this.mode.action('openPoint', message.point);
				break;
		}
	}

	dispose(): void {
		this.page.dispose();
	}
}

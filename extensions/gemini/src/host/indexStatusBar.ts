/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IndexStatus } from '../acp/index/indexerProtocol';
import type { WorkspaceIndex } from './workspaceIndex';

/** A build smaller than this (a few saved files) never shows in the status bar. */
const minFilesShown = 50;

/**
 * "Indexing 62%" in the status bar while a folder's index is being built,
 * and nothing otherwise: the updates that follow saves are too small and
 * quick to show. A click opens the Index page.
 */
export class IndexStatusBar implements vscode.Disposable {

	private readonly item = vscode.window.createStatusBarItem('gemini.index', vscode.StatusBarAlignment.Right, 101);
	private readonly building = new Map<string, { readonly done: number; readonly total: number }>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(index: WorkspaceIndex) {
		this.item.name = vscode.l10n.t("Gemini Index");
		this.item.command = 'gemini.index.open';
		this.disposables.push(this.item, index.onDidChangeStatus(status => this.update(status)), index.onDidChangeEnabled(enabled => {
			if (!enabled) {
				this.building.clear();
				this.item.hide();
			}
		}));
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private update(status: IndexStatus): void {
		const state = status.state;
		if (state.kind === 'building' && state.total >= minFilesShown) {
			this.building.set(status.root, { done: state.done, total: state.total });
		} else {
			this.building.delete(status.root);
		}
		if (!this.building.size) {
			this.item.hide();
			return;
		}
		let done = 0;
		let total = 0;
		for (const progress of this.building.values()) {
			done += progress.done;
			total += progress.total;
		}
		const percent = total ? Math.floor(done / total * 100) : 0;
		this.item.text = `$(database) ${vscode.l10n.t("Indexing {0}%", percent)}`;
		const tooltip = new vscode.MarkdownString();
		for (const [root, progress] of this.building) {
			tooltip.appendMarkdown(`${vscode.l10n.t("Indexing **{0}**: {1} of {2} files", path.basename(root), progress.done.toLocaleString(), progress.total.toLocaleString())}  \n`);
		}
		tooltip.appendMarkdown(vscode.l10n.t("At low priority, in its own process. Click to open the Index page."));
		this.item.tooltip = tooltip;
		this.item.show();
	}
}

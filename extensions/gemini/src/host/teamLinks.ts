/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { configSection } from './configuration';

/** Where merge request links open: `ask` each time, GeminiCode's browser, or the system's default browser. */
export type MergeRequestOpener = 'ask' | 'geminicode' | 'browser';

const settingKey = 'team.openMergeRequestsIn';

/** Whether `url` is a GitLab merge request page. */
export function isMergeRequestUrl(url: string): boolean {
	return /\/-\/merge_requests\/\d+/.test(url);
}

/**
 * Opens a link from the team tools. A merge request asks whether to open it
 * in GeminiCode's browser or the default browser, unless the user chose one
 * for good (`gemini.team.openMergeRequestsIn`); other links open in the
 * default browser.
 */
export async function openTeamLink(url: string): Promise<void> {
	if (!/^https?:\/\//i.test(url)) {
		return;
	}
	if (!isMergeRequestUrl(url)) {
		await vscode.env.openExternal(vscode.Uri.parse(url));
		return;
	}
	let where = vscode.workspace.getConfiguration(configSection).get<MergeRequestOpener>(settingKey, 'ask');
	if (where === 'ask') {
		const picked = await pickOpener();
		if (!picked) {
			return;
		}
		where = picked.where;
		if (picked.always) {
			await vscode.workspace.getConfiguration(configSection).update(settingKey, where, vscode.ConfigurationTarget.Global);
		}
	}
	if (where === 'geminicode') {
		try {
			await vscode.commands.executeCommand('workbench.action.browser.open', url);
			return;
		} catch {
			// No integrated browser in this build: the default browser instead.
		}
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

interface OpenerItem extends vscode.QuickPickItem {
	readonly where: Exclude<MergeRequestOpener, 'ask'>;
	readonly always: boolean;
}

async function pickOpener(): Promise<OpenerItem | undefined> {
	const items: (OpenerItem | vscode.QuickPickItem)[] = [
		{ label: `$(globe) ${vscode.l10n.t("GeminiCode's Browser")}`, description: vscode.l10n.t("In a tab beside your work"), where: 'geminicode', always: false },
		{ label: `$(link-external) ${vscode.l10n.t("Default Browser")}`, description: vscode.l10n.t("Where you're already signed in to GitLab"), where: 'browser', always: false },
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: vscode.l10n.t("Always Use GeminiCode's Browser"), where: 'geminicode', always: true },
		{ label: vscode.l10n.t("Always Use the Default Browser"), where: 'browser', always: true },
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t("Open Merge Request"),
		placeHolder: vscode.l10n.t("Where should merge requests open? You can change this later in the setting gemini.team.openMergeRequestsIn."),
	});
	return (picked as Partial<OpenerItem> | undefined)?.where ? picked as OpenerItem : undefined;
}

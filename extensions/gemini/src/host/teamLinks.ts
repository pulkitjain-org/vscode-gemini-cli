/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { configSection } from './configuration';

/** Where merge request links open: `ask` each time, GeminiCode's browser, or the system's default browser. */
export type MergeRequestOpener = 'geminicode' | 'browser';

const settingKey = 'team.openMergeRequestsIn';

/** Whether `url` is a GitLab merge request page. */
export function isMergeRequestUrl(url: string): boolean {
	return /\/-\/merge_requests\/\d+/.test(url);
}

/**
 * Opens a link from the team tools. A merge request opens in GeminiCode's
 * browser, or the default browser with `gemini.team.openMergeRequestsIn`
 * set to it; other links open in the default browser.
 */
export async function openTeamLink(url: string): Promise<void> {
	if (!/^https?:\/\//i.test(url)) {
		return;
	}
	if (!isMergeRequestUrl(url)) {
		await vscode.env.openExternal(vscode.Uri.parse(url));
		return;
	}
	// "ask", the value before 1.7, means GeminiCode's browser now.
	const where = vscode.workspace.getConfiguration(configSection).get<string>(settingKey, 'geminicode') === 'browser' ? 'browser' : 'geminicode';
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


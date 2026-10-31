/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gemini: Troubleshoot. One place for the commands that put the agent right
// (sign in, finish setup, the project id, the CLI's version, a restart, the
// log, a problem report), so the command palette lists one entry for them
// rather than eight. The status bar's menu offers the same.

import * as vscode from 'vscode';
import { reportProblemCommand } from './reportProblem';

export const troubleshootCommand = 'gemini.troubleshoot';

export interface TroubleshootContext {
	/** The agent's phase word, for the pick's title. */
	phase(): string;
	/** The signed-in account, the project id and the CLI's version, as the rows' descriptions. */
	account(): string | undefined;
	project(): string | undefined;
	cli(): string | undefined;
	stopped(): boolean;
}

export function registerTroubleshoot(context: TroubleshootContext): vscode.Disposable {
	return vscode.commands.registerCommand(troubleshootCommand, async () => {
		const items: (vscode.QuickPickItem & { readonly command: string })[] = [
			{ label: context.stopped() ? vscode.l10n.t("$(play) Start agent") : vscode.l10n.t("$(debug-restart) Restart agent"), command: 'gemini.restartAgent' },
			{ label: vscode.l10n.t("$(account) Sign in with Google"), description: context.account(), command: 'gemini.signIn' },
			{ label: vscode.l10n.t("$(terminal) Complete setup in terminal"), command: 'gemini.completeSetupInTerminal' },
			{ label: vscode.l10n.t("$(project) Set Google Cloud project ID"), description: context.project(), command: 'gemini.setProjectId' },
			{ label: vscode.l10n.t("$(versions) Install or change Gemini CLI version..."), description: context.cli(), command: 'gemini.installCliVersion' },
			{ label: vscode.l10n.t("$(plug) Check agent connection"), command: 'gemini.checkAgent' },
			{ label: vscode.l10n.t("$(output) Show log"), command: 'gemini.showLog' },
			{ label: vscode.l10n.t("$(report) Report a problem"), detail: vscode.l10n.t("A report with the versions, the last failed turn and the recent log, for you to read over and paste"), command: reportProblemCommand },
		];
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Troubleshoot Gemini: {0}", context.phase()) });
		if (picked) {
			await vscode.commands.executeCommand(picked.command);
		}
	});
}

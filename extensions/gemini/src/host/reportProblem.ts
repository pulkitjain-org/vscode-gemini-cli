/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gemini: Report a Problem. Puts a report in front of the user as an
// untitled document: the versions, the last failed turn in the chat in
// front, and the Gemini log's recent lines with their identity and any
// credential taken out (problemReport.ts). Nothing is sent anywhere; the
// user reads it over and pastes it where they report problems.

import * as os from 'node:os';
import * as vscode from 'vscode';
import { googleAccountsPath, readActiveAccount } from '../acp/accounts';
import { problemReport } from '../acp/problemReport';
import { getProjectSettings, productInfo } from './configuration';

export const reportProblemCommand = 'gemini.reportProblem';

export interface ReportProblemSources {
	/** The Gemini log's recent lines (recentLog.ts). */
	recent(): string[];
	/** Such as "0.66.0 (bundled)"; unset until the agent has started. */
	cli(): string | undefined;
	/** The last failed turn in the chat in front. */
	lastError(): { readonly kind: string; readonly message: string } | undefined;
}

export function registerReportProblem(sources: ReportProblemSources): vscode.Disposable {
	return vscode.commands.registerCommand(reportProblemCommand, async () => {
		const account = await readActiveAccount(googleAccountsPath(process.env, os.homedir())).catch(() => undefined);
		const project = getProjectSettings().resolved?.projectId;
		const report = problemReport({
			geminiCode: productInfo.version,
			vscode: vscode.version,
			os: `${process.platform} ${os.release()} (${process.arch})`,
			cli: sources.cli(),
			lastError: sources.lastError(),
			log: sources.recent(),
		}, {
			names: [account, project].filter((name): name is string => !!name),
			home: os.homedir(),
		});
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
		await vscode.window.showTextDocument(document, { preview: false });
		const copy = vscode.l10n.t("Copy");
		if (await vscode.window.showInformationMessage(vscode.l10n.t("Your problem report is ready. Read it over, then paste it where you report problems."), copy) === copy) {
			await vscode.env.clipboard.writeText(report);
		}
	});
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GeminiCode's error notifications. Each one offers Show Log after its own
// actions, and writes its message to the Gemini log first, so the log holds
// what the notification said, next to what led to it.

import * as vscode from 'vscode';

/** Writes a message to the Gemini log; registered in extension.ts, a command so the bundles loaded on demand reach the same log. */
export const logErrorCommand = '_gemini.logError';

/**
 * Shows `message` as an error with `actions` and Show Log, which opens the
 * Gemini log. Resolves with the action the user chose, or undefined for Show
 * Log or none.
 */
export async function showError(message: string, ...actions: string[]): Promise<string | undefined> {
	void vscode.commands.executeCommand(logErrorCommand, message).then(undefined, () => undefined);
	const showLog = vscode.l10n.t("Show Log");
	const choice = await vscode.window.showErrorMessage(message, ...actions, showLog);
	if (choice === showLog) {
		void vscode.commands.executeCommand('gemini.showLog');
		return undefined;
	}
	return choice;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Whether the chat folds each turn's steps under one line once the turn is
// done (webview-src/workFold.ts). `gemini.chat.foldFinishedWork` switches it live.

import * as vscode from 'vscode';

export function foldWorkOn(): boolean {
	return vscode.workspace.getConfiguration('gemini').get<boolean>('chat.foldFinishedWork', true);
}

/** Calls `listener` with the new value when `gemini.chat.foldFinishedWork` changes. */
export function onDidChangeFoldWork(listener: (on: boolean) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('gemini.chat.foldFinishedWork')) {
			listener(foldWorkOn());
		}
	});
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Spell check in the composers. GeminiCode leaves the system spell checker on
// (the workbench's geminiSpellCheck.ts); each page turns it off for itself and
// back on for its composer only. Chromium checks words outside the page's
// script, so typing costs nothing. `gemini.chat.spellCheck` switches it live.

import * as vscode from 'vscode';

export function spellCheckOn(): boolean {
	return vscode.workspace.getConfiguration('gemini').get<boolean>('chat.spellCheck', true);
}

/** Calls `listener` with the new value when `gemini.chat.spellCheck` changes. */
export function onDidChangeSpellCheck(listener: (on: boolean) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('gemini.chat.spellCheck')) {
			listener(spellCheckOn());
		}
	});
}

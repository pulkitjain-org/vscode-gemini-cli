/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

// The model the user picked last in any chat. New and reopened sessions
// start on it, so a pick sticks across agents and windows.

const lastModelKey = 'gemini.lastModel';
let storage: vscode.Memento | undefined;

export function initModelPreference(globalState: vscode.Memento): void {
	storage = globalState;
}

export function preferredModel(): string | undefined {
	return storage?.get<string>(lastModelKey);
}

export function rememberModel(modelId: string): void {
	void storage?.update(lastModelKey, modelId);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { defaultModel, SessionChoice } from '../acp/sessionSettings';

// The model the user picked last in any chat. New and reopened sessions
// start on it, so a pick sticks across agents and windows; until there is
// one, they start on the newest Flash model. Also the height
// the chat input was dragged to, shared by every chat the same way.

const lastModelKey = 'gemini.lastModel';
const composerHeightKey = 'gemini.composerHeight';
let storage: vscode.Memento | undefined;

export function initModelPreference(globalState: vscode.Memento): void {
	storage = globalState;
}

export function preferredModel(): string | undefined {
	return storage?.get<string>(lastModelKey);
}

/** The model a session opens on: the user's last pick while the agent still offers it, else the newest Flash. */
export function sessionModel(available: readonly SessionChoice[]): string | undefined {
	const picked = preferredModel();
	return picked && available.some(choice => choice.id === picked) ? picked : defaultModel(available);
}

export function rememberModel(modelId: string): void {
	void storage?.update(lastModelKey, modelId);
}

/** The height in pixels the user dragged the chat input to, or 0 for its natural height. */
export function preferredComposerHeight(): number {
	return storage?.get<number>(composerHeightKey) ?? 0;
}

export function rememberComposerHeight(height: number): void {
	void storage?.update(composerHeightKey, height > 0 ? Math.round(height) : undefined);
}

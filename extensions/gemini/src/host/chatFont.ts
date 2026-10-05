/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The text size of the chat and Agent Home (`gemini.chat.fontSize`). The
// views size everything else in em, so one number scales them.

import * as vscode from 'vscode';

const section = 'gemini';
const setting = 'chat.fontSize';
export const minChatFontSize = 10;
export const maxChatFontSize = 24;

/** The chat's text size in pixels, kept within what the views lay out well. */
export function chatFontSize(): number {
	const value = vscode.workspace.getConfiguration(section).get<number>(setting, 14);
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(maxChatFontSize, Math.max(minChatFontSize, Math.round(value))) : 14;
}

export function onDidChangeChatFontSize(listener: (size: number) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${section}.${setting}`) && listener(chatFontSize()));
}

/** Sets the size for the user, or removes their value when it is the default. */
export async function setChatFontSize(size: number): Promise<void> {
	const config = vscode.workspace.getConfiguration(section);
	const value = Math.min(maxChatFontSize, Math.max(minChatFontSize, Math.round(size)));
	await config.update(setting, value === config.inspect<number>(setting)?.defaultValue ? undefined : value, vscode.ConfigurationTarget.Global);
}

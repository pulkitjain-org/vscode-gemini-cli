/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat's reaction settings (`gemini.chat.reactions.*`) and the picker's
// Recent row, kept in global state so every chat and window shares it.

import * as vscode from 'vscode';
import { resolveMeanings, withRecent } from '../acp/reactions';

const recentKey = 'gemini.reactions.recent';
let storage: vscode.Memento | undefined;

export function initReactionRecents(globalState: vscode.Memento): void {
	storage = globalState;
}

/** The emoji used last, newest first. */
export function recentReactions(): string[] {
	const stored = storage?.get<unknown>(recentKey);
	return Array.isArray(stored) ? stored.filter((emoji): emoji is string => typeof emoji === 'string') : [];
}

export function rememberReaction(emoji: string): void {
	void storage?.update(recentKey, withRecent(recentReactions(), emoji));
}

/** Whether chats show the reaction button, picker and chips. */
export function reactionsOn(): boolean {
	return vscode.workspace.getConfiguration('gemini').get<boolean>('chat.reactions.enabled', true);
}

/** Whether the agent is asked to react to the user's prompts. */
export function agentReactionsOn(): boolean {
	return reactionsOn() && vscode.workspace.getConfiguration('gemini').get<boolean>('chat.reactions.agentReactions', true);
}

/** The fixed meanings with the user's and the workspace's edits. */
export function reactionMeanings(): ReadonlyMap<string, string | undefined> {
	return resolveMeanings(vscode.workspace.getConfiguration('gemini').get<unknown>('chat.reactions.meanings'));
}

/** Calls `listener` with {@link reactionsOn} when `gemini.chat.reactions.enabled` changes. */
export function onDidChangeReactions(listener: (on: boolean) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('gemini.chat.reactions.enabled')) {
			listener(reactionsOn());
		}
	});
}

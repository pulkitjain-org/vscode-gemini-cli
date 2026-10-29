/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { cliHome } from '../acp/cliSessions';
import { ModelListContext, proAccessFromQuota, terminalModelList } from '../acp/modelList';
import { readSettingsFile } from '../acp/projectSettings';
import { defaultModel, SessionChoice } from '../acp/sessionSettings';

// The model the user picked last in any chat. New and reopened sessions
// start on it, so a pick sticks across agents and windows; until there is
// one, they start on the newest Flash model. Also the height
// the chat input was dragged to, shared by every chat the same way.

const lastModelKey = 'gemini.lastModel';
const composerHeightKey = 'gemini.composerHeight';
const knownModelsKey = 'gemini.knownModels';
const followAgentKey = 'gemini.chat.followAgent';
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

/** Follow the agent, as the last chat left it (the + menu's switch); before 1.7 the setting `gemini.chat.followAgent`, still read where it is set. */
export function followAgentOn(): boolean {
	return storage?.get<boolean>(followAgentKey) ?? vscode.workspace.getConfiguration('gemini').get<boolean>('chat.followAgent', false);
}

export function rememberFollowAgent(on: boolean): void {
	void storage?.update(followAgentKey, on);
}

/** The height in pixels the user dragged the chat input to, or 0 for its natural height. */
export function preferredComposerHeight(): number {
	return storage?.get<number>(composerHeightKey) ?? 0;
}

export function rememberComposerHeight(height: number): void {
	void storage?.update(composerHeightKey, height > 0 ? Math.round(height) : undefined);
}

/** What the model list depends on besides the CLI's own list, kept in memory so opening a session reads no file. */
let gemma = true;
let quotaModels: () => readonly string[] | undefined = () => undefined;
let workspaceFolder: () => string | undefined = () => undefined;

/** Where the model list reads Pro access (today's quota) and the project folder from. */
export function initModelList(options: { readonly quotaModels: () => readonly string[] | undefined; readonly workspaceFolder: () => string | undefined }): void {
	quotaModels = options.quotaModels;
	workspaceFolder = options.workspaceFolder;
	void refreshGemma();
}

/** Reads `experimental.gemma` from the user's and the project's Gemini settings, project first, as the CLI merges them. */
async function refreshGemma(): Promise<void> {
	const folder = workspaceFolder();
	const [user, project] = await Promise.all([
		readSettingsFile(path.join(cliHome(), 'settings.json')),
		folder ? readSettingsFile(path.join(folder, '.gemini', 'settings.json')) : Promise.resolve({}),
	]);
	const flag = (settings: Record<string, unknown>) => (settings.experimental as { gemma?: unknown } | undefined)?.gemma;
	const value = flag(project) ?? flag(user);
	gemma = value !== false;
}

/** The models the picker lists: the terminal's `/model` list (see modelList.ts). */
export function sessionModelList(available: readonly SessionChoice[]): SessionChoice[] {
	rememberModels(available);
	const context: ModelListContext = { gemma, proAccess: proAccessFromQuota(quotaModels()) };
	// For the next session; this one uses what was read before, so opening it reads no file.
	void refreshGemma();
	return terminalModelList(available, context);
}

/** Keeps the CLI's last model list, so a popup can offer models while no agent runs; written only when it changes. */
function rememberModels(available: readonly SessionChoice[]): void {
	if (!available.length) {
		return;
	}
	const list = available.map(({ id, name, description, tier }) => ({ id, name, ...(description ? { description } : {}), ...(tier !== undefined ? { tier } : {}) }));
	if (JSON.stringify(list) !== JSON.stringify(storage?.get(knownModelsKey))) {
		void storage?.update(knownModelsKey, list);
	}
}

/** The models the picker would list, from the last list any session sent; empty before the first session. */
export function knownModelList(): SessionChoice[] {
	const saved = storage?.get<SessionChoice[]>(knownModelsKey);
	return Array.isArray(saved) && saved.length ? terminalModelList(saved, { gemma, proAccess: proAccessFromQuota(quotaModels()) }) : [];
}

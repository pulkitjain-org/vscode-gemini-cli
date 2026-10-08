/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The session's mode and model, as the agent reports them. Nothing here is
// hardcoded: the pickers show exactly what `session/new` returned, and a
// control disappears when the agent says it does not support changing it.

import type * as acp from '@agentclientprotocol/sdk';

export interface SessionChoice {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
}

export interface SessionSelector {
	readonly currentId: string;
	readonly available: readonly SessionChoice[];
}

export interface SessionSettings {
	readonly mode?: SessionSelector;
	readonly model?: SessionSelector;
}

/**
 * The unstable `models` field gemini-cli 0.62 still sends next to `modes`.
 * It is no longer in the SDK's types, so it is read defensively.
 */
interface LegacyModelState {
	readonly currentModelId?: unknown;
	readonly availableModels?: unknown;
}

function isChoiceList(value: unknown): value is readonly Record<string, unknown>[] {
	return Array.isArray(value) && value.every(v => typeof v === 'object' && v !== null);
}

export function readSessionSettings(response: acp.NewSessionResponse): SessionSettings {
	const settings: { mode?: SessionSelector; model?: SessionSelector } = {};
	const modes = response.modes;
	if (modes && modes.availableModes.length > 1) {
		settings.mode = {
			currentId: modes.currentModeId,
			available: modes.availableModes.map(m => ({ id: m.id, name: m.name, description: m.description ?? undefined })),
		};
	}
	const models = (response as { models?: LegacyModelState }).models;
	if (models && typeof models.currentModelId === 'string' && isChoiceList(models.availableModels)) {
		const available = models.availableModels.flatMap(m => typeof m.modelId === 'string'
			? [{ id: m.modelId, name: typeof m.name === 'string' ? m.name : m.modelId, description: typeof m.description === 'string' ? m.description : undefined }]
			: []);
		if (available.length > 1) {
			settings.model = { currentId: models.currentModelId, available };
		}
	}
	return settings;
}

/** Leaves out modes that `isAllowed` rejects, such as YOLO when admin policy turns it off. A picker with one mode left is hidden. */
export function filterModes(settings: SessionSettings, isAllowed: ((modeId: string) => boolean) | undefined): SessionSettings {
	const mode = settings.mode;
	if (!mode || !isAllowed) {
		return settings;
	}
	const available = mode.available.filter(choice => choice.id === mode.currentId || isAllowed(choice.id));
	return { ...settings, mode: available.length > 1 ? { ...mode, available } : undefined };
}

/**
 * The model a session starts on when the user has not picked one: the first
 * Flash model the agent offers, not Flash-Lite. gemini-cli lists its preview
 * models first, and only to accounts that can use them, so this is the newest
 * Flash the account has. Auto, the CLI's own default, makes a routing call
 * before every prompt (FINDINGS.md); a named model does not.
 */
export function defaultModel(available: readonly SessionChoice[]): string | undefined {
	return available.find(choice => /flash/i.test(choice.id) && !/lite/i.test(choice.id))?.id;
}

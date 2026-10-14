/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The model picker shows the list the terminal's `/model` shows. gemini-cli
// 0.63 builds the list it sends apps (`buildAvailableModels` in its ACP agent)
// apart from its terminal dialog (`ModelDialog`), so the two differ: the app
// list can name a model twice and has no Gemma models. These rules rebuild
// the terminal's list from what the CLI sends.

import type { SessionChoice } from './sessionSettings';

/** The Gemma models the terminal lists unless `experimental.gemma` is off. */
export const gemmaModels: readonly SessionChoice[] = [
	{ id: 'gemma-4-31b-it', name: 'gemma-4-31b-it' },
	{ id: 'gemma-4-26b-a4b-it', name: 'gemma-4-26b-a4b-it' },
];

export interface ModelListContext {
	/** Whether the user's or project's Gemini settings leave `experimental.gemma` on (the CLI's default). */
	readonly gemma: boolean;
	/** Whether the account can use Pro models; unknown when unset, which hides nothing. */
	readonly proAccess?: boolean;
}

/**
 * `available` as the terminal lists it: Auto first, then the preview models,
 * 2.5 Pro, Flash-Lite and Flash, then Gemma; each model once; no Pro models
 * for an account without Pro access. Models it doesn't know keep their place
 * after those.
 */
export function terminalModelList(available: readonly SessionChoice[], context: ModelListContext): SessionChoice[] {
	const seen = new Set<string>();
	const list: SessionChoice[] = [];
	for (const choice of [...available, ...(context.gemma ? gemmaModels : [])]) {
		if (!seen.has(choice.id)) {
			seen.add(choice.id);
			list.push(choice);
		}
	}
	const visible = context.proAccess === false ? list.filter(choice => !/pro/i.test(choice.id) || /^auto/i.test(choice.id)) : list;
	// A stable sort keeps the CLI's order within each group.
	return visible.map((choice, index) => ({ choice, index, rank: rankOf(choice.id) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(entry => entry.choice);
}

function rankOf(id: string): number {
	if (/^auto/i.test(id)) {
		return 0;
	}
	if (/^gemma/i.test(id)) {
		return 5;
	}
	if (/preview/i.test(id)) {
		return 1;
	}
	if (/pro/i.test(id)) {
		return 2;
	}
	if (/flash-lite/i.test(id)) {
		return 3;
	}
	if (/flash/i.test(id)) {
		return 4;
	}
	return 6;
}

/** Whether today's quota shows Pro access: a quota that lists models but no Pro model means none. Unknown without a quota. */
export function proAccessFromQuota(models: readonly string[] | undefined): boolean | undefined {
	if (!models?.length) {
		return undefined;
	}
	return models.some(model => /pro/i.test(model));
}

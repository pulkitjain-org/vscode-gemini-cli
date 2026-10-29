/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The model picker shows the list the terminal's `/model` shows. gemini-cli
// 0.63 builds the list it sends apps (`buildAvailableModels` in its ACP agent)
// apart from its terminal dialog (`ModelDialog`), so the two differ: the app
// list can name a model twice, has Flash and Flash-Lite the other way round
// and has no Gemma models. These rules rebuild the terminal's list from what
// the CLI sends (FINDINGS.md, "The model list").

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
 * `available` as the terminal lists it. gemini-cli 0.63 builds both lists from
 * the same groups: Auto, then the preview models, then 2.5 Pro, Flash and
 * Flash-Lite. The terminal puts Flash-Lite before Flash, adds Gemma, lists
 * each model once (the first time it appears) and hides Pro models from an
 * account without Pro access. Positions, not names, say which model is the
 * preview Flash: on Google sign-in it is `gemini-3.8-flash`, the same model as
 * the default Flash.
 *
 * With `experimental.dynamicModelConfiguration` the CLI sends both apps and
 * the terminal one list, already in order and with Gemma when the account has
 * it; its entries carry a `tier`, and only the Pro rule applies.
 */
export function terminalModelList(available: readonly SessionChoice[], context: ModelListContext): SessionChoice[] {
	const dynamic = available.some(choice => choice.tier !== undefined);
	const ordered = dynamic ? [...available] : [...flashLiteBeforeFlash(available), ...(context.gemma ? gemmaModels : [])];
	const seen = new Set<string>();
	return ordered.filter(choice => {
		if (seen.has(choice.id) || (context.proAccess === false && isPro(choice.id))) {
			return false;
		}
		seen.add(choice.id);
		return true;
	});
}

/** The CLI sends the default Flash and Flash-Lite last, in that order; the terminal lists them the other way round. */
function flashLiteBeforeFlash(available: readonly SessionChoice[]): readonly SessionChoice[] {
	const flash = available.at(-2);
	const flashLite = available.at(-1);
	if (!flash || !flashLite || !/flash/i.test(flash.id) || /lite/i.test(flash.id) || !/flash-lite/i.test(flashLite.id)) {
		return available;
	}
	return [...available.slice(0, -2), flashLite, flash];
}

/** As the CLI's `isProModel`; Auto stays, as on the terminal's first screen. */
function isPro(id: string): boolean {
	return /pro/i.test(id) && !/^auto/i.test(id);
}

/** Whether today's quota shows Pro access: a quota that lists models but no Pro model means none. Unknown without a quota. */
export function proAccessFromQuota(models: readonly string[] | undefined): boolean | undefined {
	if (!models?.length) {
		return undefined;
	}
	return models.some(model => /pro/i.test(model));
}

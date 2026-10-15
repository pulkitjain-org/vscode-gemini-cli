/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lets a right-click in `field` reach GeminiCode's spelling menu while spell
 * check is on. The webview host would otherwise take it for its own menu,
 * which has no suggestions.
 */
export function letSpellingMenuThrough(field: HTMLElement): void {
	field.addEventListener('contextmenu', event => {
		if (field.spellcheck) {
			event.stopPropagation();
		}
	});
}

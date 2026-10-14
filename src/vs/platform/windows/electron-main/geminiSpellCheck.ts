/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: spell check in GeminiCode's chat composers. windows.ts leaves
// Electron's system spell checker on; upstream's inputs and editors set
// spellcheck="false" on themselves, so only fields that opt in (the Gemini
// extension's composers) are checked. Words are checked by Chromium outside
// the page's script, so typing costs nothing. A composer lets a right-click
// through to here (the workbench's own menus take every other one); in a
// misspelled word this shows the system's suggestions and "Add to Dictionary",
// and anywhere else in the field Cut, Copy and Paste.

import electron from 'electron';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';

/** Shows spelling suggestions when a misspelled word is right-clicked in `webContents`. */
export function registerGeminiSpellCheckMenu(webContents: electron.WebContents): IDisposable {
	const onContextMenu = (_event: electron.Event, params: electron.ContextMenuParams) => {
		if (!params.isEditable) {
			return;
		}
		const word = params.misspelledWord;
		const template: electron.MenuItemConstructorOptions[] = [];
		if (word) {
			template.push(...params.dictionarySuggestions.slice(0, 6).map((suggestion: string) => ({
				label: suggestion,
				click: () => webContents.replaceMisspelling(suggestion),
			})));
			if (!template.length) {
				template.push({ label: localize('gemini.spell.none', "No Suggestions"), enabled: false });
			}
			template.push(
				{ type: 'separator' },
				{ label: localize('gemini.spell.add', "Add to Dictionary"), click: () => webContents.session.addWordToSpellCheckerDictionary(word) },
				{ type: 'separator' },
			);
		}
		template.push(
			{ role: 'cut', label: localize('gemini.spell.cut', "Cut") },
			{ role: 'copy', label: localize('gemini.spell.copy', "Copy") },
			{ role: 'paste', label: localize('gemini.spell.paste', "Paste") },
			{ role: 'selectAll', label: localize('gemini.spell.selectAll', "Select All") },
		);
		electron.Menu.buildFromTemplate(template).popup({ window: electron.BrowserWindow.fromWebContents(webContents) ?? undefined, frame: params.frame ?? undefined });
	};
	webContents.on('context-menu', onContextMenu);
	return toDisposable(() => {
		if (!webContents.isDestroyed()) {
			webContents.off('context-menu', onContextMenu);
		}
	});
}

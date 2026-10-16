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
// and anywhere else in the field Cut, Copy and Paste, in a menu the workbench
// draws (geminiContextMenu.ts).

import electron from 'electron';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IGeminiContextMenuEntry, showGeminiContextMenu } from './geminiContextMenu.js';

/** Shows spelling suggestions when a misspelled word is right-clicked in `webContents`. */
export function registerGeminiSpellCheckMenu(webContents: electron.WebContents): IDisposable {
	const onContextMenu = (_event: electron.Event, params: electron.ContextMenuParams) => {
		if (!params.isEditable) {
			return;
		}
		const word = params.misspelledWord;
		const entries: IGeminiContextMenuEntry[] = [];
		if (word) {
			entries.push(...params.dictionarySuggestions.slice(0, 6).map((suggestion: string) => ({
				label: suggestion,
				run: () => webContents.replaceMisspelling(suggestion),
			})));
			if (!entries.length) {
				entries.push({ label: localize('gemini.spell.none', "No Suggestions"), enabled: false });
			}
			entries.push(
				{ separator: true },
				{ label: localize('gemini.spell.add', "Add to Dictionary"), run: () => webContents.session.addWordToSpellCheckerDictionary(word) },
				{ separator: true },
			);
		}
		entries.push(
			{ role: 'cut', label: localize('gemini.spell.cut', "Cut"), commandId: 'editor.action.clipboardCutAction', run: () => webContents.cut() },
			{ role: 'copy', label: localize('gemini.spell.copy', "Copy"), commandId: 'editor.action.clipboardCopyAction', run: () => webContents.copy() },
			{ role: 'paste', label: localize('gemini.spell.paste', "Paste"), commandId: 'editor.action.clipboardPasteAction', run: () => webContents.paste() },
			{ role: 'selectAll', label: localize('gemini.spell.selectAll', "Select All"), commandId: 'editor.action.selectAll', run: () => webContents.selectAll() },
		);
		const win = electron.BrowserWindow.fromWebContents(webContents);
		if (win) {
			showGeminiContextMenu(win, webContents, params.x, params.y, entries);
		}
	};
	webContents.on('context-menu', onContextMenu);
	return toDisposable(() => {
		if (!webContents.isDestroyed()) {
			webContents.off('context-menu', onContextMenu);
		}
	});
}

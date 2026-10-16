/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: the menus the main process opens (a right-click in a page of
// the built-in browser, and in a chat composer) are shown by the workbench,
// so they follow `window.menuStyle` and the theme like every other menu.

/** Main asks the window to show a menu: `(request: IGeminiContextMenuRequest)`. */
export const GeminiShowContextMenuChannel = 'vscode:geminiShowContextMenu';

/**
 * The window answers when the menu closes: `(id: number, picked: number)`, -1
 * when nothing was picked. It answers `'native'` straight away when
 * `window.menuStyle` asks for the system's menu, which main then shows itself.
 */
export const GeminiContextMenuClosedChannel = 'vscode:geminiContextMenuClosed';

export interface IGeminiContextMenuItem {
	readonly label?: string;
	readonly enabled?: boolean;
	readonly separator?: true;
	/** A command whose keybinding is shown beside the item. */
	readonly commandId?: string;
}

export interface IGeminiContextMenuRequest {
	readonly id: number;
	/** Where to open the menu, in window coordinates (device-independent pixels). */
	readonly x: number;
	readonly y: number;
	readonly items: readonly IGeminiContextMenuItem[];
}

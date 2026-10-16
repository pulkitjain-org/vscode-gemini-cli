/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: opens a menu built in the main process through the window's
// workbench (contrib/gemini/electron-browser/geminiContextMenu.ts), so it is
// drawn in the app's theme like the workbench's own menus. When the user has
// set `window.menuStyle` to `native` the workbench hands it back, and it opens
// here as the system's menu.

import electron from 'electron';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { GeminiContextMenuClosedChannel, GeminiShowContextMenuChannel, IGeminiContextMenuItem } from '../../window/common/geminiContextMenu.js';

export interface IGeminiContextMenuEntry extends IGeminiContextMenuItem {
	readonly run?: () => void;
	/** For the system's menu: an Electron role, which runs the item itself. */
	readonly role?: electron.MenuItemConstructorOptions['role'];
	/** For the system's menu: the keybinding shown beside the item. */
	readonly accelerator?: string;
}

interface IPendingMenu {
	readonly win: electron.BrowserWindow;
	readonly target: electron.WebContents;
	readonly x: number;
	readonly y: number;
	readonly entries: readonly IGeminiContextMenuEntry[];
	readonly onClose?: () => void;
}

const pending = new Map<number, IPendingMenu>();
let lastId = 0;
let listening = false;

function onClosed(event: electron.IpcMainEvent, id: unknown, picked: unknown): void {
	const menu = typeof id === 'number' ? pending.get(id) : undefined;
	if (!menu || menu.win.isDestroyed() || menu.win.webContents !== event.sender) {
		return;
	}
	pending.delete(id as number);
	if (picked === 'native') {
		showNativeMenu(menu);
		return;
	}
	closed(menu);
	if (typeof picked === 'number') {
		menu.entries[picked]?.run?.();
	}
}

/** Gives the keyboard back to the page the menu was opened in. */
function closed({ win, target, onClose }: IPendingMenu): void {
	if (target !== win.webContents && !target.isDestroyed()) {
		target.focus();
	}
	onClose?.();
}

function showNativeMenu(shown: IPendingMenu): void {
	const { win, target, x, y, entries } = shown;
	if (!target.isDestroyed()) {
		target.focus();
	}
	const menu = electron.Menu.buildFromTemplate(entries.map(entry => entry.separator
		? { type: 'separator' as const }
		: entry.role
			? { role: entry.role, label: entry.label, enabled: entry.enabled !== false }
			: { label: entry.label, enabled: entry.enabled !== false, accelerator: entry.accelerator, click: () => entry.run?.() }));
	menu.once('menu-will-close', () => closed(shown));
	menu.popup({ window: win, x, y });
}

type EditRole = 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll';

/** The workbench commands whose keybindings show beside the edit roles. */
const roleCommands: { readonly [role in EditRole]?: string } = {
	cut: 'editor.action.clipboardCutAction',
	copy: 'editor.action.clipboardCopyAction',
	paste: 'editor.action.clipboardPasteAction',
	selectAll: 'editor.action.selectAll',
};

/**
 * The entries of an Electron `menu`. Edit roles run on `webContents`;
 * `keybindings` (command ID to accelerator) names the command of an item that
 * shows an accelerator.
 */
export function geminiContextMenuEntries(menu: electron.Menu, webContents: electron.WebContents, keybindings: { readonly [commandId: string]: string } = {}): IGeminiContextMenuEntry[] {
	const roles: { readonly [role in EditRole]: () => void } = {
		cut: () => webContents.cut(),
		copy: () => webContents.copy(),
		paste: () => webContents.paste(),
		pasteAndMatchStyle: () => webContents.pasteAndMatchStyle(),
		selectAll: () => webContents.selectAll(),
	};
	return menu.items.map((item): IGeminiContextMenuEntry => {
		if (item.type === 'separator') {
			return { separator: true };
		}
		const role = (Object.keys(roles) as EditRole[]).find(name => name.toLowerCase() === item.role?.toLowerCase());
		const accelerator = typeof item.accelerator === 'string' ? item.accelerator : undefined;
		const commandId = role ? roleCommands[role] : accelerator ? Object.keys(keybindings).find(id => keybindings[id] === accelerator) : undefined;
		return {
			label: item.label,
			enabled: item.enabled,
			commandId,
			role,
			accelerator,
			run: role ? roles[role] : () => item.click(),
		};
	});
}

/**
 * Shows `entries` at `x`, `y` (window coordinates, device-independent pixels)
 * in `win`'s workbench, for a right-click in `target`: the window's own
 * webContents or a page shown in it. `onClose` runs when the menu closes,
 * before the picked entry runs.
 */
export function showGeminiContextMenu(win: electron.BrowserWindow, target: electron.WebContents, x: number, y: number, entries: readonly IGeminiContextMenuEntry[], onClose?: () => void): void {
	if (!listening) {
		listening = true;
		validatedIpcMain.on(GeminiContextMenuClosedChannel, onClosed);
	}
	// A window shows one menu at a time: one it never answered (it reloaded or closed) is over.
	for (const [id, menu] of pending) {
		if (menu.win === win || menu.win.isDestroyed()) {
			pending.delete(id);
			menu.onClose?.();
		}
	}
	// The workbench draws the menu, so it takes the keyboard from the page.
	win.webContents.focus();
	const id = ++lastId;
	x = Math.round(x);
	y = Math.round(y);
	pending.set(id, { win, target, x, y, entries, onClose });
	const items = entries.map(({ label, enabled, separator, commandId }): IGeminiContextMenuItem => ({ label, enabled, separator, commandId }));
	win.webContents.send(GeminiShowContextMenuChannel, { id, x, y, items });
}

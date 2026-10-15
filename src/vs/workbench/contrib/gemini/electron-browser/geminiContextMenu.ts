/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: menus GeminiCode draws in the app's theme.
//
// Upstream defaults `window.menuStyle` to `native` on a stable Mac build, so
// every workbench menu (the browser's "Add to Gemini" chevron, right-clicks in
// the editor, the explorer and tabs, select boxes) would open as the system's
// menu. GeminiCode defaults it to `custom`; a user's own setting still wins.
// The menus the main process opens (a right-click in a page of the built-in
// browser, or in a chat composer) are shown here too: see
// platform/windows/electron-main/geminiContextMenu.ts.

import { getZoomFactor } from '../../../../base/browser/browser.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { hasNativeContextMenu } from '../../../../platform/window/common/window.js';
import { GeminiContextMenuClosedChannel, GeminiShowContextMenuChannel, IGeminiContextMenuRequest } from '../../../../platform/window/common/geminiContextMenu.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: { 'window.menuStyle': 'custom' } }]);

class GeminiContextMenus extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.geminiContextMenus';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
		const onShow = (_event: unknown, ...args: unknown[]) => this.show(args[0] as IGeminiContextMenuRequest);
		ipcRenderer.on(GeminiShowContextMenuChannel, onShow);
		this._register(toDisposable(() => ipcRenderer.removeListener(GeminiShowContextMenuChannel, onShow)));
	}

	private show(request: IGeminiContextMenuRequest): void {
		if (hasNativeContextMenu(this.configurationService)) {
			ipcRenderer.send(GeminiContextMenuClosedChannel, request.id, 'native');
			return;
		}
		let answered = false;
		const answer = (picked: number) => {
			if (!answered) {
				answered = true;
				ipcRenderer.send(GeminiContextMenuClosedChannel, request.id, picked);
			}
		};
		const commands = new Map<IAction, string>();
		const actions = request.items.map((item, index) => {
			if (item.separator) {
				return new Separator();
			}
			const action = toAction({ id: `gemini.contextMenu.${index}`, label: item.label ?? '', enabled: item.enabled !== false, run: () => answer(index) });
			if (item.commandId) {
				commands.set(action, item.commandId);
			}
			return action;
		});
		const zoom = getZoomFactor(mainWindow);
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: request.x / zoom, y: request.y / zoom }),
			getActions: () => actions,
			getKeyBinding: action => {
				const commandId = commands.get(action);
				return commandId ? this.keybindingService.lookupKeybinding(commandId) : undefined;
			},
			// A picked item hides the menu and then runs, in the same task.
			onHide: didCancel => didCancel ? answer(-1) : setTimeout(() => answer(-1)),
		});
	}
}

registerWorkbenchContribution2(GeminiContextMenus.ID, GeminiContextMenus, WorkbenchPhase.BlockRestore);

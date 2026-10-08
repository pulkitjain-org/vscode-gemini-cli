/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's "+" menu: the approval mode, attaching files and context,
// following the agent, the model, usage and the slash commands, in one
// searchable list, so the composer itself holds only the input, the Write
// and Preview tabs, the model and Send.

import { format } from './chatLogic';
import { setLabel } from './dom';
import { Menu, type MenuSection } from './menu';
import { closePicker, startCommand, startMention } from './picker';
import { contextPercent, toggleUsage } from './usage';
import { state, strings, ui, vscode } from './view';

const { plusButton: button, input } = ui;

let page: 'main' | 'model' = 'main';

setLabel(button, strings.plusMenu);

/** A codicon for each of gemini-cli's approval modes. */
export function modeIcon(id: string): string {
	switch (id) {
		case 'default': return 'shield';
		case 'autoEdit': return 'edit';
		case 'plan': return 'checklist';
		case 'yolo': return 'warning';
		default: return 'circle-large-outline';
	}
}

const menu = new Menu({
	element: ui.plusMenu,
	anchor: button,
	label: strings.plusMenu,
	search: () => strings.menuSearch,
	sections,
	empty: () => strings.noCommands,
	inside: [ui.modeChip],
	returnFocus: () => input,
	onOpen: () => {
		closePicker();
		page = 'main';
	},
	onKey: event => {
		if (page === 'main' || ((event.key === 'ArrowLeft' || event.key === 'Backspace') && menu.text)) {
			return false;
		}
		if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Backspace') {
			show('main');
			return true;
		}
		return false;
	},
});

export function openPlusMenu(): void {
	menu.open();
}

export function closePlusMenu(focusInput = true): void {
	menu.close(focusInput);
}

/** The mode, model or follow state changed: an open menu shows it. */
export function updatePlusMenu(): void {
	menu.render();
}

function sections(): MenuSection[] {
	const model = state.settings.model;
	if (page === 'model') {
		return [{
			rows: [
				{ icon: 'arrow-left', name: strings.back, run: () => show('main') },
				...(model?.available ?? []).map(choice => ({
					icon: 'sparkle', name: choice.name, detail: choice.description, checked: choice.id === model?.currentId,
					run: () => {
						vscode.postMessage({ type: 'setModel', id: choice.id });
						closePlusMenu();
					},
				})),
			],
		}];
	}
	const mode = state.settings.mode;
	const result: MenuSection[] = [];
	if (mode) {
		result.push({
			heading: strings.mode,
			rows: mode.available.map(choice => ({
				icon: modeIcon(choice.id), name: choice.name, detail: choice.description, checked: choice.id === mode.currentId,
				run: () => {
					vscode.postMessage({ type: 'setMode', id: choice.id });
					closePlusMenu();
				},
			})),
		});
	}
	result.push({
		rows: [
			{ icon: 'files', name: strings.menuFiles, detail: strings.menuFilesDetail, tooltip: strings.attachFiles, run: () => { closePlusMenu(); vscode.postMessage({ type: 'pickFiles' }); } },
			{ icon: 'mention', name: strings.menuContext, detail: strings.menuContextDetail, run: () => { closePlusMenu(false); startMention(); } },
			{
				icon: 'eye', name: strings.menuFollow, detail: strings.menuFollowDetail, switchOn: state.following,
				tooltip: state.following ? strings.followAgentOn : strings.followAgent,
				run: () => vscode.postMessage({ type: 'setFollow', on: !state.following }),
			},
		],
	});
	const percent = contextPercent();
	result.push({
		rows: [
			...(model ? [{ icon: 'sparkle', name: strings.model, detail: model.available.find(choice => choice.id === model.currentId)?.name, submenu: true, run: () => show('model') }] : []),
			{ icon: 'graph', name: strings.usage, detail: percent === undefined ? undefined : format(strings.menuUsageDetail, percent), run: () => { closePlusMenu(false); toggleUsage(); } },
			{ icon: 'library', name: strings.menuCommands, detail: '/', run: () => { closePlusMenu(false); startCommand(); } },
		],
	});
	return result;
}

function show(next: 'main' | 'model'): void {
	page = next;
	menu.clearQuery();
	menu.render();
}

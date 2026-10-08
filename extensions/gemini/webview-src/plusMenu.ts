/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The composer's "+" menu: the approval mode, attaching files and context,
// following the agent, the model, usage and the slash commands, in one
// searchable list, so the composer itself holds only the input, the Write
// and Preview tabs, the model and Send.

import { format } from './chatLogic';
import { el, icon, setLabel } from './dom';
import { closePicker, startCommand, startMention } from './picker';
import { contextPercent, toggleUsage } from './usage';
import { state, strings, ui, vscode } from './view';

const { plusButton: button, plusMenu: menu, input } = ui;

interface Row {
	readonly icon: string;
	readonly name: string;
	readonly detail?: string;
	/** A tick, for the current mode or model. */
	readonly checked?: boolean;
	/** An on/off switch, with its state. */
	readonly switchOn?: boolean;
	/** Opens a list of its own. */
	readonly submenu?: boolean;
	/** The row's tooltip, when the name and detail do not say enough. */
	readonly tooltip?: string;
	run(): void;
}

type Section = { readonly heading?: string; readonly rows: readonly Row[] };

let page: 'main' | 'model' = 'main';
let query = '';
let active = 0;
let rows: Row[] = [];
const search = el('input', 'plus-search');
search.type = 'text';
search.placeholder = strings.menuSearch;
search.setAttribute('aria-label', strings.menuSearch);

setLabel(button, strings.plusMenu);
menu.setAttribute('aria-label', strings.plusMenu);

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

export function openPlusMenu(): void {
	closePicker();
	page = 'main';
	query = '';
	search.value = '';
	active = 0;
	menu.hidden = false;
	button.setAttribute('aria-expanded', 'true');
	render();
	search.focus();
}

export function closePlusMenu(focusInput = true): void {
	if (menu.hidden) {
		return;
	}
	menu.hidden = true;
	button.setAttribute('aria-expanded', 'false');
	if (focusInput) {
		input.focus();
	}
}

/** The mode, model or follow state changed: an open menu shows it. */
export function updatePlusMenu(): void {
	if (!menu.hidden) {
		render();
	}
}

function sections(): Section[] {
	if (page === 'model') {
		const model = state.settings.model;
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
	const model = state.settings.model;
	const result: Section[] = [];
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
	query = '';
	search.value = '';
	active = 0;
	render();
	search.focus();
}

function matches(row: Row): boolean {
	const q = query.trim().toLowerCase();
	return !q || row.name.toLowerCase().includes(q) || !!row.detail?.toLowerCase().includes(q);
}

function render(): void {
	rows = [];
	const list = el('div', 'plus-list');
	let first = true;
	for (const section of sections()) {
		const shown = section.rows.filter(matches);
		if (!shown.length) {
			continue;
		}
		if (!first) {
			list.append(el('div', 'plus-separator'));
		}
		first = false;
		if (section.heading && !query.trim()) {
			list.append(el('div', 'plus-heading', section.heading));
		}
		for (const row of shown) {
			list.append(renderRow(row, rows.length));
			rows.push(row);
		}
	}
	if (!rows.length) {
		list.append(el('div', 'plus-empty', strings.noCommands));
	}
	active = Math.min(active, Math.max(0, rows.length - 1));
	menu.replaceChildren(search, list);
	highlight();
}

function renderRow(row: Row, index: number): HTMLElement {
	const node = el('div', `plus-row${row.checked ? ' checked' : ''}`);
	node.id = `plus-row-${index}`;
	node.setAttribute('role', row.switchOn !== undefined ? 'menuitemcheckbox' : row.checked !== undefined ? 'menuitemradio' : 'menuitem');
	if (row.switchOn !== undefined || row.checked !== undefined) {
		node.setAttribute('aria-checked', String(row.switchOn ?? row.checked));
	}
	node.append(icon(row.icon, `plus-icon plus-icon-${row.icon}`), el('span', 'plus-name', row.name));
	if (row.detail) {
		node.append(el('span', 'plus-detail', row.detail));
	}
	if (row.checked) {
		node.append(icon('check', 'plus-end'));
	} else if (row.switchOn !== undefined) {
		node.append(el('span', `plus-switch${row.switchOn ? ' on' : ''}`));
	} else if (row.submenu) {
		node.append(icon('chevron-right', 'plus-end'));
	}
	node.title = row.tooltip ?? (row.detail ? `${row.name}: ${row.detail}` : row.name);
	node.addEventListener('mousemove', () => {
		if (active !== index) {
			active = index;
			highlight();
		}
	});
	node.addEventListener('mousedown', event => event.preventDefault());
	node.addEventListener('click', () => row.run());
	return node;
}

function highlight(): void {
	menu.querySelectorAll('.plus-row').forEach((node, i) => node.classList.toggle('active', i === active));
	const current = menu.querySelector<HTMLElement>(`#plus-row-${active}`);
	current?.scrollIntoView({ block: 'nearest' });
	if (current) {
		search.setAttribute('aria-activedescendant', current.id);
	}
}

search.addEventListener('input', () => {
	query = search.value;
	active = 0;
	render();
	search.focus();
});

search.addEventListener('keydown', event => {
	switch (event.key) {
		case 'ArrowDown':
		case 'ArrowUp':
			if (rows.length) {
				active = (active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
				highlight();
			}
			break;
		case 'Enter':
			rows[active]?.run();
			break;
		case 'ArrowRight':
			if (!rows[active]?.submenu) {
				return;
			}
			rows[active].run();
			break;
		case 'ArrowLeft':
		case 'Backspace':
			if (page === 'main' || search.value) {
				return;
			}
			show('main');
			break;
		case 'Escape':
			if (page !== 'main') {
				show('main');
			} else {
				closePlusMenu();
			}
			break;
		case 'Tab':
			closePlusMenu(false);
			return;
		default:
			return;
	}
	event.preventDefault();
	event.stopPropagation();
});

button.addEventListener('click', () => menu.hidden ? openPlusMenu() : closePlusMenu());

document.addEventListener('mousedown', event => {
	const target = event.target as Node | null;
	if (!menu.hidden && target && !menu.contains(target) && !button.contains(target) && !ui.modeChip.contains(target)) {
		closePlusMenu(false);
	}
});

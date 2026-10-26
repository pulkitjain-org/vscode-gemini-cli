/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Home's menus: the composer's "+", folder, mode and From Your Tools menus,
// and a dashboard row's "..." menu. A chunk of its own, with the menu class,
// which Home loads once it has settled or on the first click on one of their
// buttons, so Home's startup script stays small. Show All and Customize
// (homePopups.ts) get the same menu class from here, so opening one menu
// closes the others.

import type { HomeAction, HomeButton, HomeCard, HomeRow, HomeStrings, HomeView } from '../src/host/panelProtocol';
import { Menu, type MenuRow, type MenuSection } from './menu';
import { modeIcon } from './modeIcon';

export { Menu };

/** What the menus need from Home. */
export interface HomeMenusHost {
	readonly strings: HomeStrings;
	/** The view Home shows now. */
	view(): HomeView | undefined;
	/** The folder and the approval mode the next agent starts in, and picking them. */
	folder(): string;
	pickFolder(folder: string): void;
	mode(): string;
	pickMode(mode: string): void;
	pickFiles(): void;
	addFolder(): void;
	run(action: HomeAction): void;
	logo(tool: 'jira' | 'gitlab', size: number): Element;
	/** Home's themed tooltip, for the rows. */
	tip(node: HTMLElement, tip: string): void;
	/** Where focus goes when a row's menu closes and its button is gone. */
	fallbackFocus(): HTMLElement;
}

export interface HomeMenus {
	readonly Menu: typeof Menu;
	/** Opens the menu of the composer's button `anchor`, as its first click would have. */
	open(anchor: HTMLElement): void;
	/** Opens, or closes when open from it, the "..." menu of a row with `items`. */
	openRow(anchor: HTMLElement, items: readonly HomeButton[]): void;
	/** Draws the open menu again, as when the view changed. */
	render(): void;
}

export function createHomeMenus(host: HomeMenusHost): HomeMenus {
	const { strings } = host;
	const byId = (id: string) => document.getElementById(id)!;
	const menu = (anchor: string, label: string, sections: () => readonly MenuSection[], empty = () => '') => new Menu({
		element: byId(`${anchor}-menu`),
		anchor: byId(anchor),
		label,
		sections,
		empty,
		tip: host.tip,
	});

	/** A row per mode the next agent can start in; picking one closes `open`. */
	const modeRows = (open: () => Menu): MenuRow[] => (host.view()?.modes ?? []).map(choice => ({
		icon: modeIcon(choice.id),
		name: choice.name,
		detail: choice.description,
		checked: choice.id === host.mode(),
		run: () => {
			host.pickMode(choice.id);
			open().close();
		},
	}));

	const plusMenu: Menu = menu('plus', strings.plusMenu, () => [
		{ heading: strings.mode, rows: modeRows(() => plusMenu) },
		{ rows: [{ icon: 'files', name: strings.files, detail: strings.filesDetail, run: () => { plusMenu.close(); host.pickFiles(); } }] },
	]);

	/** "From Your Tools...": the tickets and merge requests on the cards, each starting an agent or a review on it. */
	const fromToolsMenu: Menu = menu('from-tools', strings.fromTools, () => {
		const cards = host.view()?.dashboard.cards ?? [];
		const rowsOf = (id: HomeCard['id'], tool: 'jira' | 'gitlab', actionOf: (row: HomeRow) => HomeAction | undefined): MenuRow[] =>
			(cards.find(card => card.id === id)?.rows ?? []).flatMap(row => {
				const action = actionOf(row);
				return row.key && action ? [{
					iconElement: () => host.logo(tool, 14),
					name: `${row.key} ${row.title}`,
					detail: [row.detail, row.pill?.text].filter(Boolean).join(' · '),
					run: () => {
						fromToolsMenu.close();
						host.run(action);
					},
				}] : [];
			});
		const tickets = rowsOf('tickets', 'jira', row => row.menu?.[0]?.action);
		const mergeRequests = rowsOf('mergeRequests', 'gitlab', row => row.button?.action);
		return [
			...tickets.length ? [{ heading: strings.tickets, rows: tickets }] : [],
			...mergeRequests.length ? [{ heading: strings.mergeRequests, rows: mergeRequests }] : [],
		];
	}, () => strings.fromToolsEmpty);

	const modeMenu: Menu = menu('mode', strings.mode, () => [{ rows: modeRows(() => modeMenu) }]);

	const folderMenu: Menu = menu('workspace', strings.workspace, () => [
		{
			rows: (host.view()?.workspaces ?? []).map(w => ({
				icon: 'folder',
				name: w.name,
				detail: w.description,
				checked: w.folder === host.folder(),
				run: () => {
					host.pickFolder(w.folder);
					folderMenu.close();
				},
			})),
		},
		{ rows: [{ icon: 'add', name: strings.addFolder, run: () => { folderMenu.close(); host.addFolder(); } }] },
	], () => strings.noWorkspace);

	/** The "..." menu of a row; moved into the row it opens for. */
	let rowItems: readonly HomeButton[] = [];
	let rowAnchor: HTMLElement | undefined;
	const rowMenuElement = byId('row-menu');
	const rowMenu: Menu = new Menu({
		element: rowMenuElement,
		anchor: document.createElement('button'),
		label: strings.moreActions,
		sections: () => [{ rows: rowItems.map(item => ({ name: item.label, run: () => { rowMenu.close(); host.run(item.action); } })) }],
		empty: () => '',
		returnFocus: () => rowAnchor?.isConnected ? rowAnchor : host.fallbackFocus(),
		tip: host.tip,
	});

	const composerMenus = [plusMenu, fromToolsMenu, modeMenu, folderMenu];
	const anchors = ['plus', 'from-tools', 'mode', 'workspace'].map(byId);
	return {
		Menu,
		open(anchor) {
			composerMenus[anchors.indexOf(anchor)]?.open();
		},
		openRow(anchor, items) {
			if (rowMenu.isOpen && rowAnchor === anchor) {
				rowMenu.close();
				return;
			}
			rowItems = items;
			rowAnchor = anchor;
			anchor.parentElement!.append(rowMenuElement);
			rowMenu.open();
		},
		render() {
			for (const each of composerMenus) {
				each.render();
			}
		},
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Home's Show All popup and Customize menu, a chunk of its own that Home
// loads the first time either opens, so Home's startup script stays small.
// Show All shows a card's whole list, which the extension keeps current while
// it is open; Customize turns cards on and off, orders them and picks the
// branch the Quality card reads.

import type { FromHome, HomeCard, HomeCardId, HomeDashboard, HomeList, HomeRow } from '../src/host/panelProtocol';
import type { HomeStrings } from '../src/host/panelStrings';
import type { Menu } from './menu';
import { button, el, icon } from './panelDom';

/** What the popups need from Home. */
export interface HomePopupsHost {
	readonly strings: HomeStrings;
	post(message: FromHome): void;
	/** Home's own menu class, so Customize closes as Home's other menus open. */
	readonly Menu: typeof Menu;
	/** Home's themed tooltip. */
	tip(node: HTMLElement, tip: string): void;
	readonly customizeButton: HTMLElement;
	readonly customizeElement: HTMLElement;
	/** The dashboard Home shows now. */
	dashboard(): HomeDashboard | undefined;
	/** How Home draws a row (`inList` for this popup, which has room for the repository), a group's heading, a tool's logo and a query. */
	dashRow(row: HomeRow, inList: boolean): HTMLElement;
	groupHeading(row: HomeRow): HTMLElement;
	logo(tool: HomeRow['tool'], size: number): Element;
	queryText(text: string): HTMLElement;
}

export interface HomePopups {
	/** Opens `card`'s whole list: its rows at once, then the rest when the extension sends them. */
	showList(card: HomeCard): void;
	/** Whether Show All's popup is open. */
	readonly listOpen: boolean;
	closeList(): void;
	openCustomize(): void;
	/** Shows a new dashboard in whichever of the two is open. */
	update(dash: HomeDashboard): void;
}

export function createHomePopups(host: HomePopupsHost): HomePopups {
	const { strings } = host;

	const listDialog = el('dialog', 'dash-list-dialog');
	const listBody = el('div', 'dash-list-body');
	const listHead = el('div', 'dash-card-head dash-list-head');
	const listTitle = el('h2');
	listTitle.id = 'dash-list-title';
	listDialog.setAttribute('aria-labelledby', listTitle.id);
	const listFilter = el('input', 'dash-list-filter');
	listFilter.type = 'search';
	listFilter.placeholder = strings.filterList;
	listFilter.setAttribute('aria-label', strings.filterList);
	const listRows = el('div', 'dash-rows dash-list-rows');
	listBody.append(listHead, listFilter, listRows);
	listDialog.append(listBody);
	document.body.append(listDialog);
	/** The list in the popup, and the card it is for. */
	let shownList: HomeList | undefined;
	let listCard: HomeCardId | undefined;

	function renderList(list: HomeList, total = list.rows.length): void {
		shownList = list;
		const close = button('icon-button dash-list-close', '', () => listDialog.close(), 'close', strings.close);
		host.tip(close, strings.close);
		listHead.replaceChildren(list.tool ? host.logo(list.tool, 16) : icon(list.icon ?? 'list-flat'), listTitle, el('span', 'dash-list-count'), ...list.query ? [host.queryText(list.query)] : [], close);
		listTitle.textContent = list.title;
		listHead.dataset.total = String(total);
		listFilter.hidden = total <= 8;
		renderListRows();
	}

	/** The rows that match the filter, under their groups' headings. */
	function renderListRows(): void {
		const list = shownList;
		if (!list) {
			return;
		}
		const words = listFilter.value.trim().toLowerCase();
		const nodes: HTMLElement[] = [];
		let group: HomeRow | undefined;
		let headed: HomeRow | undefined;
		for (const row of list.rows) {
			group = row.group ? row : group;
			if (words && ![row.type?.name, row.key, row.repo, row.title, row.detail, row.pill?.text].some(text => text?.toLowerCase().includes(words))) {
				continue;
			}
			if (group && group !== headed) {
				nodes.push(host.groupHeading(group));
				headed = group;
			}
			nodes.push(host.dashRow(row, true));
		}
		const shown = nodes.filter(node => node.classList.contains('dash-row')).length;
		listRows.replaceChildren(...nodes.length ? nodes : [el('p', 'dash-note muted', strings.noMatches)]);
		const count = listHead.querySelector('.dash-list-count');
		if (count) {
			count.textContent = words ? `${shown} / ${listHead.dataset.total}` : listHead.dataset.total ?? '';
		}
	}

	listFilter.addEventListener('input', renderListRows);
	listDialog.addEventListener('close', () => {
		listCard = undefined;
		shownList = undefined;
		host.post({ type: 'showList' });
	});
	// A click on the scrim, outside the popup's body, closes it.
	listDialog.addEventListener('click', event => {
		if (event.target === listDialog) {
			listDialog.close();
		}
	});

	const customizeMenu: Menu = new host.Menu({
		element: host.customizeElement,
		anchor: host.customizeButton,
		label: strings.customize,
		sections: () => {
			const dash = host.dashboard();
			if (!dash) {
				return [];
			}
			return [
				{
					heading: strings.cards,
					rows: dash.layout.flatMap((card, i) => [{
						name: card.title,
						switchOn: card.visible,
						run: () => host.post({ type: 'layout', card: card.id, visible: !card.visible }),
					}, ...i > 0 ? [{
						icon: 'arrow-up',
						name: `${strings.moveUp}: ${card.title}`,
						run: () => host.post({ type: 'layout', card: card.id, move: -1 }),
					}] : []]),
				},
				...dash.releaseBranches.length ? [{
					heading: strings.qualityBranch,
					rows: [...dash.releaseBranches].reverse().slice(0, 6).map(branch => ({
						icon: 'git-branch',
						name: branch,
						checked: branch === (dash.qualityBranch ?? dash.releaseBranches[dash.releaseBranches.length - 1]),
						run: () => {
							host.post({ type: 'qualityBranch', branch });
							customizeMenu.close();
						},
					})),
				}] : [],
			];
		},
		empty: () => '',
		tip: host.tip,
	});

	return {
		showList(card) {
			listCard = card.id;
			listFilter.value = '';
			renderList({ card: card.id, title: card.title, rows: card.rows, ...card.tool ? { tool: card.tool } : {}, ...card.icon ? { icon: card.icon } : {}, ...card.query ? { query: card.query } : {} }, card.total);
			listDialog.showModal();
			(listFilter.hidden ? listDialog.querySelector<HTMLElement>('.dash-list-close') : listFilter)?.focus();
			host.post({ type: 'showList', card: card.id });
		},
		get listOpen() {
			return listDialog.open;
		},
		closeList() {
			listDialog.close();
		},
		openCustomize() {
			customizeMenu.open();
		},
		update(dash) {
			// An open Customize menu shows the switches and order just saved, so the next click reads the new state.
			customizeMenu.render();
			if (listDialog.open && dash.list && dash.list.card === listCard) {
				renderList(dash.list);
			}
		},
	};
}

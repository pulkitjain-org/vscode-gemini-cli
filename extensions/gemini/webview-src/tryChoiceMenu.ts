/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Try button's chevron menu, on the Changes panel, Home's agent cards and
// a project chat's thread cards: Try in Workspace, Merge Back and, with GitLab
// connected, Open Merge Request, the current one ticked. The page posts the
// pick, which the host runs and remembers for the repository. The menu class
// comes from the page's own bundle or chunk, so no page carries two copies.

import type { TryChoice } from '../src/host/panelProtocol';
import type { TryChoiceStrings } from '../src/host/panelStrings';
import type { Menu, MenuOptions } from './menu';

export interface TryChoiceMenu {
	/** Opens under `anchor`, or closes when already open from it; `pick` runs with the row picked. */
	toggle(anchor: HTMLElement, current: TryChoice, mergeRequests: boolean, pick: (choice: TryChoice) => void): void;
}

export function createTryChoiceMenu(MenuClass: new (options: MenuOptions) => Menu, strings: TryChoiceStrings, tip?: (node: HTMLElement, tip: string) => void): TryChoiceMenu {
	const element = document.createElement('div');
	element.className = 'try-choice-menu';
	element.hidden = true;
	// An anchor of its own, so no button gets the menu's own click handler.
	const hiddenAnchor = document.createElement('span');
	hiddenAnchor.hidden = true;
	document.body.append(element, hiddenAnchor);
	let state: { anchor: HTMLElement; current: TryChoice; mergeRequests: boolean; pick(choice: TryChoice): void } | undefined;
	const row = (choice: TryChoice, icon: string, name: string, detail: string) => ({
		icon, name, detail,
		checked: state?.current === choice,
		run: () => {
			menu.close();
			state?.pick(choice);
		},
	});
	const menu = new MenuClass({
		element,
		anchor: hiddenAnchor,
		label: strings.title,
		// In the page's body, so placed by its button each time: under it, or over it near the bottom, its right edge on the button's.
		onOpen: () => {
			const box = (state?.anchor ?? hiddenAnchor).getBoundingClientRect();
			const width = Math.min(340, innerWidth - 16);
			element.style.width = `${width}px`;
			element.style.left = `${Math.max(8, Math.min(box.right - width, innerWidth - width - 8))}px`;
			const below = innerHeight - box.bottom > 220;
			element.style.top = below ? `${box.bottom + 4}px` : 'auto';
			element.style.bottom = below ? 'auto' : `${innerHeight - box.top + 4}px`;
		},
		sections: () => [{
			heading: strings.title,
			rows: [
				row('try', 'beaker', strings.tryIn, strings.tryInDetail),
				row('merge', 'git-merge', strings.mergeBack, strings.mergeBackDetail),
				...state?.mergeRequests ? [row('mr', 'git-pull-request', strings.openMr, strings.openMrDetail)] : [],
			],
		}],
		empty: () => '',
		tip,
	});
	return {
		toggle(anchor, current, mergeRequests, pick) {
			if (menu.isOpenFrom(anchor)) {
				menu.close();
				return;
			}
			state = { anchor, current, mergeRequests, pick };
			menu.setAnchor(anchor);
			menu.open();
		},
	};
}

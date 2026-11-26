/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Connections page's menu of the repositories Sync Design System can
// write to, in the theme rather than a quick pick. A chunk of its own, loaded
// on the first click on Sync in a window with more than one, so the page's
// script stays small.

import type { ConnectionRowView } from '../src/host/connectionsProtocol';
import { Menu } from './menu';

type Repos = NonNullable<ConnectionRowView['designSystemRepos']>;

export interface RepoMenu {
	/** Opens under `anchor`, or closes when already open from it; `pick` runs with the repository's root. */
	toggle(anchor: HTMLElement, repos: Repos, pick: (root: string) => void): void;
}

export function createRepoMenu(label: string): RepoMenu {
	const element = document.createElement('div');
	element.className = 'repo-menu';
	element.hidden = true;
	// An anchor of its own: the page draws its buttons again on every update.
	const hiddenAnchor = document.createElement('span');
	hiddenAnchor.hidden = true;
	document.body.append(element, hiddenAnchor);
	let state: { anchor: HTMLElement; repos: Repos; pick(root: string): void } | undefined;
	const menu = new Menu({
		element,
		anchor: hiddenAnchor,
		label,
		// Under its button, or over it near the bottom, its right edge on the button's.
		onOpen: () => {
			const box = (state?.anchor ?? hiddenAnchor).getBoundingClientRect();
			const width = Math.min(380, innerWidth - 16);
			element.style.width = `${width}px`;
			element.style.left = `${Math.max(8, Math.min(box.right - width, innerWidth - width - 8))}px`;
			const below = innerHeight - box.bottom > 220;
			element.style.top = below ? `${box.bottom + 4}px` : 'auto';
			element.style.bottom = below ? 'auto' : `${innerHeight - box.top + 4}px`;
		},
		returnFocus: () => state?.anchor.isConnected ? state.anchor : document.body,
		sections: () => [{
			heading: label,
			rows: (state?.repos ?? []).map(repo => ({
				icon: 'repo',
				name: repo.name,
				detail: repo.path,
				run: () => {
					menu.close();
					state?.pick(repo.root);
				},
			})),
		}],
		empty: () => '',
	});
	return {
		toggle(anchor, repos, pick) {
			if (menu.isOpenFrom(anchor)) {
				menu.close();
				return;
			}
			state = { anchor, repos, pick };
			menu.setAnchor(anchor);
			menu.open();
		},
	};
}

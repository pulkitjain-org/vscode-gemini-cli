/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A <select> drawn as a button and one of our menus (menu.ts), so choosing
// opens a list in the theme's colours rather than the system's menu, which a
// webview's <select> opens on macOS. The <select> stays, hidden, as the value:
// code reads and sets `value` and listens for `change` as before.

import { Menu } from './menu';
import { el, icon } from './panelDom';

export interface SelectMenu {
	/** The button and its menu, to put where the <select> would go. */
	readonly element: HTMLElement;
	/** Shows the <select>'s value and state again, after code changed them. */
	sync(): void;
	dispose(): void;
}

let count = 0;

/** Wraps `select`, which must hold its options and value already; the button takes its id, so a label still points at it. */
export function selectMenu(select: HTMLSelectElement, label: string): SelectMenu {
	const element = el('div', 'select-menu');
	const button = el('button', `select-menu-button ${select.className}`.trim());
	button.type = 'button';
	if (select.id) {
		button.id = select.id;
		select.removeAttribute('id');
	}
	const text = el('span', 'select-menu-text');
	button.append(text, icon('chevron-down'));
	const list = el('div', 'select-menu-list');
	list.id = `select-menu-${++count}`;
	list.hidden = true;
	select.hidden = true;
	select.tabIndex = -1;
	element.append(select, button, list);

	const sync = () => {
		const current = select.selectedOptions[0];
		text.textContent = current?.text ?? '';
		button.title = current?.text ?? '';
		button.disabled = select.disabled;
	};
	// Fixed, so a scrolling popup doesn't clip it; below the button, or above when there is more room there.
	const place = () => {
		const box = button.getBoundingClientRect();
		const below = window.innerHeight - box.bottom - 8;
		const above = box.top - 8;
		const up = below < 160 && above > below;
		list.style.left = `${box.left}px`;
		list.style.minWidth = `${box.width}px`;
		list.style.maxWidth = `${Math.max(box.width, window.innerWidth - box.left - 8)}px`;
		list.style.top = up ? '' : `${box.bottom + 4}px`;
		list.style.bottom = up ? `${window.innerHeight - box.top + 4}px` : '';
		list.style.maxHeight = `${Math.min(320, up ? above : below)}px`;
	};
	const menu: Menu = new Menu({
		element: list,
		anchor: button,
		label,
		sections: () => [{
			rows: [...select.options].map(option => ({
				name: option.text,
				checked: option.selected,
				run: () => {
					menu.close();
					if (select.value !== option.value) {
						select.value = option.value;
						sync();
						select.dispatchEvent(new Event('change', { bubbles: true }));
					}
				},
			})),
		}],
		empty: () => '',
		onOpen: place,
	});
	// The list would stay where it opened while the page under it scrolls.
	const onScroll = (event: Event) => {
		if (menu.isOpen && !list.contains(event.target as Node)) {
			menu.close(false);
		}
	};
	document.addEventListener('scroll', onScroll, true);
	window.addEventListener('resize', onScroll);
	// The arrow keys open it, as they do a <select>.
	button.addEventListener('keydown', event => {
		if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !menu.isOpen) {
			event.preventDefault();
			menu.open();
		}
	});
	select.addEventListener('change', sync);
	sync();
	return {
		element,
		sync,
		dispose: () => {
			menu.dispose();
			document.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onScroll);
		},
	};
}

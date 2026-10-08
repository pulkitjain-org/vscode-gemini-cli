/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A pop-up list for the chat's "+" menu, model, branch and folder, and Agent
// Home's folder, so none of them opens a system menu or the Command Palette.
// Rows can be filtered by an optional search field and picked with the arrow
// keys. Styled by media/menu.css.

import { el, icon } from './panelDom';

export interface MenuRow {
	readonly icon?: string;
	readonly name: string;
	readonly detail?: string;
	/** Quiet text at the row's end, such as a time. */
	readonly end?: string;
	/** A tick, for the current choice. */
	readonly checked?: boolean;
	/** An on/off switch, with its state. */
	readonly switchOn?: boolean;
	/** Opens a list of its own. */
	readonly submenu?: boolean;
	/** The row's tooltip, when the name and detail do not say enough. */
	readonly tooltip?: string;
	run(): void;
}

export interface MenuSection {
	readonly heading?: string;
	readonly rows: readonly MenuRow[];
}

export interface MenuOptions {
	/** The pop-up's element, hidden while closed. */
	readonly element: HTMLElement;
	/** The button that opens it. */
	readonly anchor: HTMLElement;
	readonly label: string;
	/** The search field's placeholder, read on every render; without it the menu has no field. */
	readonly search?: () => string;
	/** A title over the rows, such as the folder's name and path. */
	readonly title?: () => { readonly name: string; readonly detail?: string } | undefined;
	/** The rows matching `query`; rows are filtered by name and detail unless `filters` is set. */
	readonly sections: (query: string) => readonly MenuSection[];
	/** Whether `sections` filters by itself. */
	readonly filters?: boolean;
	/** Shown when no row matches. */
	readonly empty: () => string;
	/** Keys the menu handles before the defaults; returns whether it did. */
	readonly onKey?: (event: KeyboardEvent) => boolean;
	/** Other elements clicks on which do not close the menu. */
	readonly inside?: readonly HTMLElement[];
	/** Where focus goes once the menu closes; the anchor by default. */
	readonly returnFocus?: () => HTMLElement;
	readonly onOpen?: () => void;
}

const menus: Menu[] = [];

/** Closes every open menu, as another pop-up opens. */
export function closeMenus(): void {
	menus.forEach(menu => menu.close(false));
}

export class Menu {
	private query = '';
	private active = 0;
	private rows: MenuRow[] = [];
	private readonly field?: HTMLInputElement;

	constructor(private readonly options: MenuOptions) {
		menus.push(this);
		const { element, anchor } = options;
		element.classList.add('menu');
		element.setAttribute('role', 'menu');
		element.setAttribute('aria-label', options.label);
		anchor.setAttribute('aria-haspopup', 'menu');
		anchor.setAttribute('aria-expanded', 'false');
		if (options.search) {
			this.field = el('input', 'menu-search');
			this.field.type = 'text';
			this.field.addEventListener('input', () => {
				this.query = this.field!.value;
				this.active = 0;
				this.render();
			});
			this.field.addEventListener('keydown', event => this.onKey(event));
		} else {
			element.tabIndex = -1;
			element.addEventListener('keydown', event => this.onKey(event));
		}
		anchor.addEventListener('click', () => this.isOpen ? this.close() : this.open());
		document.addEventListener('mousedown', event => {
			const target = event.target as Node | null;
			if (this.isOpen && target && !element.contains(target) && !anchor.contains(target) && !options.inside?.some(node => node.contains(target))) {
				this.close(false);
			}
		});
	}

	get isOpen(): boolean {
		return !this.options.element.hidden;
	}

	get text(): string {
		return this.query;
	}

	open(): void {
		closeMenus();
		this.options.onOpen?.();
		this.query = '';
		this.active = 0;
		if (this.field) {
			this.field.value = '';
		}
		this.options.element.hidden = false;
		this.options.anchor.setAttribute('aria-expanded', 'true');
		this.render();
		(this.field ?? this.options.element).focus();
	}

	close(restoreFocus = true): void {
		if (!this.isOpen) {
			return;
		}
		this.options.element.hidden = true;
		this.options.anchor.setAttribute('aria-expanded', 'false');
		if (restoreFocus) {
			(this.options.returnFocus?.() ?? this.options.anchor).focus();
		}
	}

	/** Clears the search, as when moving to another page of the menu. */
	clearQuery(): void {
		this.query = '';
		this.active = 0;
		if (this.field) {
			this.field.value = '';
		}
	}

	/** Draws the rows again, as after what they show changed; does nothing while closed. */
	render(): void {
		if (!this.isOpen) {
			return;
		}
		const options = this.options;
		const element = options.element;
		const nodes: HTMLElement[] = [];
		const title = options.title?.();
		if (title) {
			nodes.push(el('div', 'menu-title', title.name));
			if (title.detail) {
				nodes.push(el('div', 'menu-subtitle', title.detail));
			}
		}
		if (this.field) {
			this.field.placeholder = options.search!();
			this.field.setAttribute('aria-label', this.field.placeholder);
			nodes.push(this.field);
		}
		const list = el('div', 'menu-list');
		this.rows = [];
		const q = this.query.trim().toLowerCase();
		for (const section of options.sections(this.query)) {
			const shown = options.filters || !q ? section.rows : section.rows.filter(row => row.name.toLowerCase().includes(q) || !!row.detail?.toLowerCase().includes(q));
			if (!shown.length) {
				continue;
			}
			if (this.rows.length) {
				list.append(el('div', 'menu-separator'));
			}
			if (section.heading && !q) {
				list.append(el('div', 'menu-heading', section.heading));
			}
			for (const row of shown) {
				list.append(this.renderRow(row, this.rows.length));
				this.rows.push(row);
			}
		}
		if (!this.rows.length) {
			list.append(el('div', 'menu-empty', options.empty()));
		}
		nodes.push(list);
		this.active = Math.min(this.active, Math.max(0, this.rows.length - 1));
		element.replaceChildren(...nodes);
		this.highlight();
		if (this.field && document.activeElement !== this.field) {
			this.field.focus();
		}
	}

	private renderRow(row: MenuRow, index: number): HTMLElement {
		const node = el('div', `menu-row${row.checked ? ' checked' : ''}`);
		node.id = `${this.options.element.id}-row-${index}`;
		node.setAttribute('role', row.switchOn !== undefined ? 'menuitemcheckbox' : row.checked !== undefined ? 'menuitemradio' : 'menuitem');
		if (row.switchOn !== undefined || row.checked !== undefined) {
			node.setAttribute('aria-checked', String(row.switchOn ?? row.checked));
		}
		if (row.icon) {
			const rowIcon = icon(row.icon);
			rowIcon.classList.add('menu-icon');
			node.append(rowIcon);
		}
		node.append(el('span', 'menu-name', row.name));
		if (row.detail) {
			node.append(el('span', 'menu-detail', row.detail));
		}
		const end = el('span', 'menu-end');
		if (row.end) {
			end.append(el('span', undefined, row.end));
		}
		if (row.checked) {
			end.append(icon('check'));
		} else if (row.switchOn !== undefined) {
			end.append(el('span', `menu-switch${row.switchOn ? ' on' : ''}`));
		} else if (row.submenu) {
			end.append(icon('chevron-right'));
		}
		if (end.childElementCount) {
			node.append(end);
		}
		node.title = row.tooltip ?? (row.detail ? `${row.name}: ${row.detail}` : row.name);
		node.addEventListener('mousemove', () => {
			if (this.active !== index) {
				this.active = index;
				this.highlight();
			}
		});
		node.addEventListener('mousedown', event => event.preventDefault());
		node.addEventListener('click', () => row.run());
		return node;
	}

	private highlight(): void {
		this.options.element.querySelectorAll('.menu-row').forEach((node, i) => node.classList.toggle('active', i === this.active));
		const current = this.options.element.querySelector<HTMLElement>(`#${this.options.element.id}-row-${this.active}`);
		current?.scrollIntoView({ block: 'nearest' });
		if (current) {
			(this.field ?? this.options.element).setAttribute('aria-activedescendant', current.id);
		}
	}

	private onKey(event: KeyboardEvent): void {
		if (this.options.onKey?.(event)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const rows = this.rows;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
				if (rows.length) {
					this.active = (this.active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
					this.highlight();
				}
				break;
			case 'Enter':
				rows[this.active]?.run();
				break;
			case 'ArrowRight':
				if (!rows[this.active]?.submenu) {
					return;
				}
				rows[this.active].run();
				break;
			case 'Escape':
				this.close();
				break;
			case 'Tab':
				this.close(false);
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The webviews' menus and tooltips as screen readers meet them, and the Run
// chevrons sharing one menu rather than leaving one behind per click.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HTMLElement, HTMLInputElement } from 'happy-dom';
import { page, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;

/** What the tests use of menu.ts's `Menu` and tooltip.ts's `setTip`. */
type MenuRow = { readonly name: string; readonly checked?: boolean; run(): void };
let Menu: new (options: { element: HTMLElement; anchor: HTMLElement; label: string; search?: () => string; sections: () => { heading?: string; rows: MenuRow[] }[]; empty: () => string }) => { dispose(): void };
let setTip: (node: HTMLElement, tip: string) => void;

function attributes(node: HTMLElement | null | undefined, names: readonly string[]): Record<string, string | null | undefined> {
	return Object.fromEntries(names.map(name => [name, node?.getAttribute(name)]));
}

beforeAll(async () => {
	await showChatPage();
	await startScript('chat');
	Menu = (await startScript('menu')).Menu as typeof Menu;
	setTip = (await startScript('tooltip')).setTip as typeof setTip;
});

describe('a menu with a search field', () => {
	it('is a combobox over a listbox of options, following the highlighted row', () => {
		const anchor = document.createElement('button');
		const element = document.createElement('div');
		element.hidden = true;
		document.body.append(anchor, element);
		const menu = new Menu({
			element,
			anchor,
			label: 'Reviewers',
			search: () => 'Search people',
			sections: () => [{ heading: 'Team', rows: ['Ada', 'Grace'].map(name => ({ name, checked: name === 'Ada', run: () => undefined })) }],
			empty: () => 'Nobody',
		});
		anchor.click();
		const field = element.querySelector('input') as HTMLInputElement;
		field.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'ArrowDown' }));
		const list = element.querySelector('.menu-list') as HTMLElement;
		const rows = [...element.querySelectorAll('.menu-row')] as HTMLElement[];
		expect({
			popup: attributes(element, ['role', 'aria-label']),
			anchor: attributes(anchor, ['aria-haspopup', 'aria-expanded']),
			field: attributes(field, ['role', 'aria-expanded', 'aria-autocomplete']),
			controls: field.getAttribute('aria-controls') === list.id,
			list: attributes(list, ['role', 'aria-label']),
			rows: rows.map(row => attributes(row, ['role', 'aria-selected', 'aria-checked'])),
			active: field.getAttribute('aria-activedescendant') === rows[1].id,
		}).toEqual({
			popup: { 'role': 'dialog', 'aria-label': 'Reviewers' },
			anchor: { 'aria-haspopup': 'dialog', 'aria-expanded': 'true' },
			field: { 'role': 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list' },
			controls: true,
			list: { 'role': 'listbox', 'aria-label': 'Reviewers' },
			rows: [{ 'role': 'option', 'aria-selected': 'false', 'aria-checked': 'true' }, { 'role': 'option', 'aria-selected': 'true', 'aria-checked': 'false' }],
			active: true,
		});
		menu.dispose();
	});
});

describe('a themed tooltip', () => {
	it('describes its control while it is up, unless it only repeats the control\'s name', () => {
		const described = document.createElement('button');
		described.textContent = 'Merge';
		const named = document.createElement('button');
		named.setAttribute('aria-label', 'Copy');
		document.body.append(described, named);
		setTip(described, 'Merge the thread back into main');
		setTip(named, 'Copy');
		described.dispatchEvent(new page.PointerEvent('pointermove', { bubbles: true }));
		const tip = document.getElementById(described.getAttribute('aria-describedby') ?? '');
		const shown = { role: tip?.getAttribute('role'), text: tip?.textContent };
		named.dispatchEvent(new page.PointerEvent('pointermove', { bubbles: true }));
		expect({ shown, after: described.getAttribute('aria-describedby'), named: named.getAttribute('aria-describedby') })
			.toEqual({ shown: { role: 'tooltip', text: 'Merge the thread back into main' }, after: null, named: null });
	});
});

describe('the Run chevrons', () => {
	it('share one menu and one document listener, however many blocks and clicks', () => {
		sendToPage({ type: 'run', run: { mode: 'alwaysAsk', places: ['shop'] } });
		const reply = ['First:', '```sh\nnpm test\n```', 'Then:', '```sh\nnpm run build\n```', 'Last:', '```bash\nls\n```'].join('\n\n');
		sendToPage({ type: 'reset', items: [{ id: 'u1', kind: 'user', text: 'How do I build?' }, { id: 'a1', kind: 'agent', text: reply }], busy: false, status: { phase: 'ready', text: '' }, settings: {} });
		const listen = vi.spyOn(document, 'addEventListener');
		const chevrons = [...document.querySelectorAll('.code-more')] as HTMLElement[];
		expect(chevrons).toHaveLength(3);
		for (const chevron of [...chevrons, ...chevrons]) {
			chevron.click();
		}
		const opened = { menus: document.querySelectorAll('.run-menu').length, open: !(document.querySelector('.run-menu') as HTMLElement).hidden, expanded: chevrons.map(chevron => chevron.getAttribute('aria-expanded')) };
		chevrons[2].click();
		expect({ opened, closed: (document.querySelector('.run-menu') as HTMLElement).hidden, listeners: listen.mock.calls.filter(([type]) => type === 'mousedown').length })
			.toEqual({ opened: { menus: 1, open: true, expanded: ['false', 'false', 'true'] }, closed: true, listeners: 1 });
		listen.mockRestore();
	});
});

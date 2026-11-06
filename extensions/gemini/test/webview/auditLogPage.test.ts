/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Audit log page's Day and Tool filters are themed menus, not bare
// <select>s, and the page lets each go when it draws itself again.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HTMLElement, HTMLSelectElement } from 'happy-dom';
import type { AuditPageView, AuditStrings } from '../../src/host/auditProtocol';
import { hostExport, page, posted, sendToPage, startScript } from './pages';

const { document } = page;

function view(day = '2026-11-05'): AuditPageView {
	return {
		day, days: ['2026-11-05', '2026-11-04'], folder: '~/Library/Application Support/GeminiCode/audit', unfinished: 0,
		rows: [
			{ id: 'a1', time: '09:12:01', caller: 'agent - SHOP-1 Cart total', tool: 'jira_transition', toolKind: 'jira', effect: 'SHOP-1 to In Progress', answered: 'you - Allow once', remote: 'SHOP-1', state: 'done' },
			{ id: 'a2', time: '09:30:44', caller: 'UI - Open merge request', tool: 'openMergeRequest', toolKind: 'gitlab', effect: '!41', answered: 'you - button', state: 'open' },
		],
	};
}

beforeAll(async () => {
	// The page's strings, as its host builds them (shell() needs nothing of the page).
	const AuditPage = await hostExport<{ prototype: { shell(): { strings: AuditStrings } } }>('src/host/auditPage.ts', 'AuditPage');
	const strings = AuditPage.prototype.shell().strings;
	document.body.className = 'settings-page audit-page';
	document.body.innerHTML = `<main id="page" class="settings audit"></main><script type="module" data-strings='${JSON.stringify(strings).replace(/'/g, '&#39;')}'></script>`;
	let saved: unknown;
	Object.assign(globalThis, {
		acquireVsCodeApi: () => ({ postMessage: (message: { type: string }) => posted.push(message), getState: () => saved, setState: (state: unknown) => saved = state }),
	});
	await startScript('auditLog');
	posted.length = 0;
});

const buttons = () => [...document.querySelectorAll('.audit-filters .select-menu-button')] as HTMLElement[];

describe('the Audit log page', () => {
	it('draws Day and Tool as themed menus over hidden selects, and filters from a row picked', () => {
		sendToPage({ type: 'view', view: view() });
		const selects = [...document.querySelectorAll('select')] as HTMLSelectElement[];
		const before = { hidden: selects.map(select => select.hidden), shown: buttons().map(button => button.textContent?.trim()), rows: document.querySelectorAll('tbody tr').length };
		buttons()[1].click();
		const rows = [...document.querySelectorAll('.audit-filters .menu-row')] as HTMLElement[];
		rows.find(row => row.textContent?.trim() === 'Jira')!.click();
		expect({ before, names: rows.map(row => row.querySelector('.menu-name')?.textContent), after: { shown: buttons().map(button => button.textContent?.trim()), rows: document.querySelectorAll('tbody tr').length } }).toEqual({
			before: { hidden: [true, true], shown: ['2026-11-05', 'All'], rows: 2 },
			names: ['All', 'Jira', 'GitLab'],
			after: { shown: ['2026-11-05', 'Jira'], rows: 1 },
		});
	});

	it('asks the host for another day from the Day menu', () => {
		buttons()[0].click();
		([...document.querySelectorAll('.audit-filters .menu-row')] as HTMLElement[]).find(row => row.textContent?.trim() === '2026-11-04')!.click();
		expect(posted.filter(message => message.type === 'day')).toEqual([{ type: 'day', day: '2026-11-04' }]);
	});

	it('lets the filters\' menus go when it draws itself again: each view adds two menus\' document listeners and removes the last view\'s', () => {
		const added = vi.spyOn(document, 'addEventListener');
		const removed = vi.spyOn(document, 'removeEventListener');
		for (const day of ['2026-11-04', '2026-11-05', '2026-11-04']) {
			sendToPage({ type: 'view', view: view(day) });
		}
		const count = (calls: unknown[][], type: string) => calls.filter(([name]) => name === type).length;
		const listeners = { mousedown: [count(added.mock.calls, 'mousedown'), count(removed.mock.calls, 'mousedown')], scroll: [count(added.mock.calls, 'scroll'), count(removed.mock.calls, 'scroll')] };
		added.mockRestore();
		removed.mockRestore();
		expect(listeners).toEqual({ mousedown: [6, 6], scroll: [6, 6] });
	});
});

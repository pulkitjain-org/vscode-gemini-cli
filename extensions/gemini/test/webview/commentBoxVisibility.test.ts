/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The Jira comment box's Visible to is a themed menu over a hidden <select>,
// with Jira's roles and groups as its sections, and no native tooltip.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLDialogElement, HTMLElement, HTMLSelectElement } from 'happy-dom';
import type { HomeStrings } from '../../src/host/panelStrings';
import { page, showHomePage, startScript } from './pages';

const { document } = page;

type Box = { open(action: { kind: 'comment'; key: string; title: string; visibility?: string }): void; onMessage(message: unknown): void };
let box: Box;
const posted: unknown[] = [];

beforeAll(async () => {
	await showHomePage();
	const strings = JSON.parse((document.querySelector('script[data-strings]') as HTMLElement).dataset.strings ?? '{}') as HomeStrings;
	// Not in happy-dom: a dialog's modal state.
	const dialog = page.HTMLDialogElement.prototype as unknown as { showModal?: () => void };
	dialog.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
	const module = await startScript('commentBox');
	box = (module.createCommentBox as (host: unknown) => Box)({
		strings,
		post: (message: unknown) => posted.push(message),
		renderMarkdown: async () => [],
		toAdf: async () => ({ type: 'doc', version: 1, content: [] }),
	});
});

const visibility = () => document.querySelector('.dash-comment-visible') as HTMLElement;

describe('the comment box\'s Visible to', () => {
	it('is a themed menu over the hidden select, with Jira\'s roles and groups as sections, and the themed tip', () => {
		box.open({ kind: 'comment', key: 'SHOP-1', title: 'Cart total is wrong', visibility: 'Developers' });
		box.onMessage({ type: 'commentOptions', key: 'SHOP-1', roles: ['Developers', 'Administrators'], groups: ['jira-software-users'] });
		const select = visibility().querySelector('select') as HTMLSelectElement;
		const button = visibility().querySelector('.select-menu-button') as HTMLElement;
		const before = { hidden: select.hidden, value: select.value, shown: button.textContent?.trim(), tip: button.dataset.tip, titled: document.querySelectorAll('.dash-comment-dialog [title]').length };
		button.click();
		const headings = [...visibility().querySelectorAll('.menu-heading')].map(node => node.textContent);
		const rows = [...visibility().querySelectorAll('.menu-row')] as HTMLElement[];
		rows.find(row => row.querySelector('.menu-name')?.textContent === 'jira-software-users')!.click();
		expect({ before, headings, names: rows.map(row => row.querySelector('.menu-name')?.textContent), after: { value: select.value, shown: button.textContent?.trim(), open: !(visibility().querySelector('.select-menu-list') as HTMLElement).hidden } }).toEqual({
			before: { hidden: true, value: 'role:Developers', shown: 'Developers', tip: 'Who can see this comment in Jira', titled: 0 },
			headings: ['Project roles', 'Groups'],
			names: ['Everyone who can see the ticket', 'Developers', 'Administrators', 'jira-software-users'],
			after: { value: 'group:jira-software-users', shown: 'jira-software-users', open: false },
		});
	});
});

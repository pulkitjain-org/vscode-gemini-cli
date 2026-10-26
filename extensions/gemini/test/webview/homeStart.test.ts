/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Home's composer: one chooser of where the new agent works (here, on its own
// branch, or as a project), with a line on the one picked; themed tooltips in
// place of native ones; and the menus and popups, chunks loaded on first use.

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement, HTMLTextAreaElement } from 'happy-dom';
import type { HomeCard, HomeView } from '../../src/host/panelProtocol';
import { page, posted, sendToPage, showHomePage, startScript } from './pages';

const { document } = page;
const byId = (id: string) => document.getElementById(id) as HTMLElement;

const tickets: HomeCard = {
	id: 'tickets', title: 'My tickets', tool: 'jira', query: 'assignee = currentUser()', total: 9,
	rows: [{ type: { name: 'Bug', icon: 'bug', color: 'red' }, key: 'SHOP-1', title: 'Cart total is wrong', button: { label: 'Start', action: { kind: 'command', command: 'gemini.start' }, title: 'Start an agent on SHOP-1' }, menu: [{ label: 'Log Time', action: { kind: 'command', command: 'gemini.logTime' } }] }],
};

function view(options: { git?: boolean; projects?: boolean; ownBranch?: boolean } = {}): HomeView {
	return {
		workspaces: [{ name: 'shop', description: '~/work', folder: '/work/shop', git: options.git ?? true, index: { state: 'ready', label: 'Indexed' } }],
		active: [],
		earlier: [],
		...options.projects ?? true ? { projects: [] } : {},
		ownBranch: !!options.ownBranch,
		modes: [{ id: 'default', name: 'Default', description: 'Asks before edits' }, { id: 'autoEdit', name: 'Auto Edit', description: 'Edits without asking' }],
		dashboard: {
			greeting: 'Good morning', context: 'shop', tools: [{ id: 'jira', name: 'Jira', tone: 'ok', label: 'Jira: connected' }], quickActions: [], needs: [], needsQuery: 'agent waiting',
			cards: [tickets], layout: [{ id: 'tickets', title: 'My tickets', visible: true }, { id: 'gemini', title: 'Gemini', visible: false }], releaseBranches: [], refreshing: false,
		},
	};
}

/** The chooser as the user sees it: the choices shown, the one checked, and the checked one's tooltip. */
function chooser() {
	const group = byId('start-as');
	const checked = [...group.querySelectorAll('[aria-checked="true"]')] as HTMLElement[];
	return {
		shown: group.hidden ? [] : [...group.querySelectorAll('[role="radio"]')].filter(node => !(node as HTMLElement).hidden).map(node => node.textContent),
		checked: checked.map(node => node.textContent),
		hint: group.hidden ? '' : checked[0]?.dataset.tip ?? '',
	};
}

function choice(label: string): HTMLElement {
	return [...document.querySelectorAll('#start-as [role="radio"]')].find(node => node.textContent === label) as HTMLElement;
}

function startTask(text: string): { type: string;[key: string]: unknown } | undefined {
	const prompt = document.getElementById('prompt') as unknown as HTMLTextAreaElement;
	prompt.value = text;
	prompt.dispatchEvent(new page.Event('input'));
	posted.length = 0;
	byId('start').click();
	return posted.find(message => message.type === 'start');
}

beforeAll(async () => {
	await showHomePage();
	// The menus' chunk from its source, as the built page loads media/homeMenus.js.
	const script = document.querySelector('script[data-home-menus]') as HTMLElement;
	script.dataset.homeMenus = path.join(__dirname, '..', '..', 'webview-src', 'homeMenus.ts');
	script.dataset.homePopups = path.join(__dirname, '..', '..', 'webview-src', 'homePopups.ts');
	await startScript('home');
});

describe('Home\'s new-agent chooser', () => {
	it('offers Here, On Its Own Branch and As a Project in a Git folder, with a line on the one picked', () => {
		sendToPage({ type: 'view', view: view() });
		const before = chooser();
		choice('On Its Own Branch').click();
		expect({ before, after: chooser() }).toEqual({
			before: { shown: ['Here', 'On Its Own Branch', 'As a Project'], checked: ['Here'], hint: 'Works in this folder, on your current branch.' },
			after: { shown: ['Here', 'On Its Own Branch', 'As a Project'], checked: ['On Its Own Branch'], hint: 'A new branch and folder, merged back when done.' },
		});
	});

	it('starts the agent the way picked: on its own branch, as a project, or here', () => {
		choice('On Its Own Branch').click();
		const branch = startTask('Fix the cart');
		choice('As a Project').click();
		const project = startTask('Split checkout');
		choice('Here').click();
		const here = startTask('Add a test');
		expect([branch, project, here].map(message => ({ ownBranch: message?.ownBranch, project: message?.project, text: message?.text }))).toEqual([
			{ ownBranch: true, project: undefined, text: 'Fix the cart' },
			{ ownBranch: false, project: true, text: 'Split checkout' },
			{ ownBranch: false, project: undefined, text: 'Add a test' },
		]);
	});

	it('moves between the choices with the arrow keys', () => {
		choice('Here').click();
		byId('start-as').dispatchEvent(new page.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		const once = chooser().checked;
		byId('start-as').dispatchEvent(new page.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		byId('start-as').dispatchEvent(new page.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		expect({ once, wrapped: chooser().checked, focused: document.activeElement?.textContent }).toEqual({ once: ['On Its Own Branch'], wrapped: ['As a Project'], focused: 'As a Project' });
	});

	it('leaves out what the folder can\'t do: no project while Projects are off, and no choice at all outside Git', () => {
		choice('As a Project').click();
		sendToPage({ type: 'view', view: view({ projects: false }) });
		const noProjects = chooser();
		sendToPage({ type: 'view', view: view({ git: false }) });
		const noGit = chooser();
		const message = startTask('Rename a file');
		expect({ noProjects, noGit, ownBranch: message?.ownBranch, project: message?.project }).toEqual({
			noProjects: { shown: ['Here', 'On Its Own Branch'], checked: ['Here'], hint: 'Works in this folder, on your current branch.' },
			noGit: { shown: [], checked: ['Here'], hint: '' },
			ownBranch: false,
			project: undefined,
		});
	});
});

describe('Home\'s tooltips', () => {
	it('are the themed ones: no native title anywhere on the page, and each control keeps its tip', () => {
		sendToPage({ type: 'view', view: view() });
		const tip = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.dataset.tip;
		expect({
			titled: [...document.body.querySelectorAll('[title]')].map(node => node.outerHTML.slice(0, 60)),
			tips: [tip('#refresh'), tip('#customize'), tip('#helpers'), tip('#workspace'), tip('#mode'), tip('#index-state'), tip('.dash-tool'), tip('.dash-row-title'), tip('.dash-type'), tip('.dash-query'), tip('.dash-row .secondary'), tip('.dash-row-more .icon-button')],
		}).toEqual({
			titled: [],
			tips: ['Refresh', 'Customize', 'MCP servers, skills, rules and hooks your agents load', 'Workspace: ~/work/shop', 'Mode: Default', 'Indexed', 'Jira: connected', 'Cart total is wrong', 'Bug', 'assignee = currentUser()', 'Start an agent on SHOP-1', 'More Actions'],
		});
	});

	it('calls Project Helpers Agent Setup', () => {
		expect(byId('helpers').textContent).toBe('Agent Setup');
	});
});

describe('Home\'s menus', () => {
	it('load on the first click on a menu\'s button and open, with themed tooltips on their rows', async () => {
		const mode = document.getElementById('mode') as HTMLElement;
		mode.click();
		const menu = byId('mode-menu');
		await expect.poll(() => menu.hidden).toBe(false);
		const rows = [...menu.querySelectorAll('.menu-row')] as HTMLElement[];
		const before = { expanded: mode.getAttribute('aria-expanded'), rows: rows.map(row => row.dataset.tip), titled: rows.filter(row => row.hasAttribute('title')).length };
		rows[1].click();
		expect({ before, label: mode.textContent, open: !menu.hidden }).toEqual({
			before: { expanded: 'true', rows: ['Default: Asks before edits', 'Auto Edit: Edits without asking'], titled: 0 },
			label: 'Auto Edit',
			open: false,
		});
	});

	it('give Show All\'s popup and Customize the themed tooltips too', async () => {
		(document.querySelector('.dash-show-all') as HTMLElement).click();
		await expect.poll(() => !!document.querySelector('.dash-list-close')).toBe(true);
		const close = document.querySelector('.dash-list-close') as HTMLElement;
		const list = { close: close.dataset.tip, titled: document.querySelector('.dash-list-dialog')!.querySelectorAll('[title]').length };
		close.click();
		byId('customize').click();
		const customize = byId('customize-menu');
		await expect.poll(() => customize.hidden).toBe(false);
		expect({ list, customize: [...customize.querySelectorAll('.menu-row')].filter(row => !(row as HTMLElement).dataset.tip || row.hasAttribute('title')).length })
			.toEqual({ list: { close: 'Close', titled: 0 }, customize: 0 });
	});

	it('open a row\'s "..." menu in the row, and close it from the same button', async () => {
		const more = document.querySelector('.dash-row-more .icon-button') as HTMLElement;
		more.click();
		const menu = byId('row-menu');
		await expect.poll(() => menu.hidden).toBe(false);
		const opened = { inRow: more.parentElement!.contains(menu), rows: [...menu.querySelectorAll('.menu-row')].map(row => row.textContent) };
		more.click();
		await expect.poll(() => menu.hidden).toBe(true);
		expect(opened).toEqual({ inRow: true, rows: ['Log Time'] });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Home gets a new view every moment while agents work. It patches what
// changed in place, so the pointer's hover and the keyboard's focus stay put.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { HomeAgent, HomeCard, HomeView } from '../../src/host/panelProtocol';
import { page, sendToPage, showHomePage, startScript } from './pages';

const { document } = page;

const working: HomeAgent = { id: 'a1', title: 'Fix the cart', workspace: 'shop', state: 'working', status: 'Reading files', updated: 'now', buttons: [{ do: 'stop', label: 'Stop', icon: 'debug-stop' }, { do: 'open', label: 'Open', primary: true }] };
const done: HomeAgent = { id: 'a2', title: 'Add a test', workspace: 'shop', state: 'done', status: 'Done', branch: 'gemini/test', changes: '+12 -3 in 2 files', updated: '5m', buttons: [{ do: 'review', label: 'Review', icon: 'diff' }, { do: 'mergeBack', label: 'Try in Workspace', icon: 'beaker' }, { do: 'tryMenu', label: '', icon: 'chevron-down' }, { do: 'open', label: 'Open', primary: true }] };
const tickets: HomeCard = { id: 'tickets', title: 'Tickets', tool: 'jira', rows: [{ key: 'SHOP-1', title: 'Cart total is wrong', button: { label: 'Start', action: { kind: 'command', command: 'gemini.start' } } }] };

function view(active: readonly HomeAgent[], cards: readonly HomeCard[] = [tickets]): HomeView {
	return {
		workspaces: [{ name: 'shop', description: '~/work', folder: '/work/shop', git: true }],
		active,
		earlier: [],
		ownBranch: false,
		modes: [{ id: 'default', name: 'Default', description: 'Asks before edits' }],
		dashboard: { greeting: 'Good morning', context: 'shop', tools: [], quickActions: [], cards, layout: [], releaseBranches: [], refreshing: false },
	};
}

function cardOf(id: string): HTMLElement {
	const title = [...document.querySelectorAll('.card .title')].find(node => node.textContent === (id === 'a1' ? working.title : done.title));
	return title!.closest('.card') as HTMLElement;
}

function buttonIn(node: HTMLElement, label: string): HTMLElement {
	return [...node.querySelectorAll('button')].find(button => button.textContent === label) as HTMLElement;
}

beforeAll(async () => {
	await showHomePage();
	await startScript('home');
});

describe('Home', () => {
	it('patches an agent\'s card in place, keeping focus on its button', () => {
		sendToPage({ type: 'view', view: view([working, done]) });
		const card = cardOf('a1');
		const stop = buttonIn(card, 'Stop');
		stop.focus();
		sendToPage({ type: 'view', view: view([{ ...working, status: 'Editing cart.ts', updated: '1m' }, done]) });
		expect({
			same: cardOf('a1') === card,
			status: card.querySelector('.card-status')?.textContent,
			updated: card.querySelector('.card-head .muted')?.textContent,
			button: buttonIn(card, 'Stop') === stop,
			focused: document.activeElement === stop,
		}).toEqual({ same: true, status: 'Editing cart.ts', updated: '1m', button: true, focused: true });
	});

	it('keeps focus on the button drawn in place of the focused one when the card\'s buttons change', () => {
		sendToPage({ type: 'view', view: view([working, done]) });
		const card = cardOf('a1');
		buttonIn(card, 'Open').focus();
		sendToPage({ type: 'view', view: view([{ ...working, state: 'done', status: 'Done', changes: '+1 -0 in 1 file', branch: 'gemini/cart', buttons: done.buttons }, done]) });
		expect({ same: cardOf('a1') === card, buttons: [...card.querySelectorAll('button')].map(button => button.textContent || button.getAttribute('aria-label')), focused: document.activeElement === buttonIn(card, 'Open') })
			.toEqual({ same: true, buttons: ['Review', 'Try in Workspace', 'Other ways to take the work', 'Open'], focused: true });
	});

	it('keeps an unchanged dashboard card as it is, and drops an agent that is gone', () => {
		sendToPage({ type: 'view', view: view([working, done]) });
		const card = document.querySelector('[data-card="tickets"]');
		const start = buttonIn(card as HTMLElement, 'Start');
		start.focus();
		sendToPage({ type: 'view', view: view([done]) });
		expect({ same: document.querySelector('[data-card="tickets"]') === card, focused: document.activeElement === start, agents: document.querySelectorAll('#active .card').length })
			.toEqual({ same: true, focused: true, agents: 1 });
	});

	it('opens an agent from the card\'s Open button, not a focusable card around it', () => {
		const card = cardOf('a2');
		expect({ tabIndex: card.getAttribute('tabindex'), open: !!buttonIn(card, 'Open') }).toEqual({ tabIndex: null, open: true });
	});
});

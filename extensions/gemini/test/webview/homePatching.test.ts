/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Home gets a new view every moment while agents work. It patches what
// changed in place, so the pointer's hover and the keyboard's focus stay put.
// The Agents card is the one agent list on Home.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { HomeCard, HomeRow, HomeView } from '../../src/host/panelProtocol';
import { page, posted, sendToPage, showHomePage, startScript } from './pages';

const { document } = page;

const working: HomeRow = { icon: 'circle-filled', title: 'Fix the cart', pill: { text: 'working', tone: 'info' }, open: { kind: 'agent', id: 'a1', do: 'open' } };
const done: HomeRow = { icon: 'circle-filled', title: 'Add a test', pill: { text: 'ready to review', tone: 'ok' }, open: { kind: 'agent', id: 'a2', do: 'open' }, button: { label: 'Review', action: { kind: 'agent', id: 'a2', do: 'review' } } };
const tickets: HomeCard = { id: 'tickets', title: 'Your tickets', tool: 'jira', rows: [{ key: 'SHOP-1', title: 'Cart total is wrong', button: { label: 'Start', action: { kind: 'command', command: 'gemini.start' } } }] };

function agents(rows: readonly HomeRow[]): HomeCard {
	return { id: 'agents', title: 'Agents', tool: 'gemini', rows, ...rows.length ? {} : { note: 'No agents at work. Describe a task above to start one.' } };
}

function view(cards: readonly HomeCard[]): HomeView {
	return {
		workspaces: [{ name: 'shop', description: '~/work', folder: '/work/shop', git: true }],
		ownBranch: false,
		modes: [{ id: 'default', name: 'Default', description: 'Asks before edits' }],
		dashboard: { greeting: 'Good morning', context: 'shop', quickActions: [], cards, layout: [], releaseBranches: [], refreshing: false },
	};
}

function card(id: string): HTMLElement {
	return document.querySelector(`[data-card="${id}"]`) as HTMLElement;
}

function buttonIn(node: HTMLElement, label: string): HTMLElement {
	return [...node.querySelectorAll('button')].find(button => button.textContent === label) as HTMLElement;
}

beforeAll(async () => {
	await showHomePage();
	await startScript('home');
});

describe('Home', () => {
	it('keeps an unchanged card as it is, with focus on its button, while another card changes', () => {
		sendToPage({ type: 'view', view: view([tickets, agents([working, done])]) });
		const ticketsCard = card('tickets');
		const start = buttonIn(ticketsCard, 'Start');
		start.focus();
		sendToPage({ type: 'view', view: view([tickets, agents([{ ...working, pill: { text: 'needs you', tone: 'warn' } }, done])]) });
		expect({
			same: card('tickets') === ticketsCard,
			focused: document.activeElement === start,
			pills: [...card('agents').querySelectorAll('.dash-pill')].map(pill => pill.textContent),
		}).toEqual({ same: true, focused: true, pills: ['needs you', 'ready to review'] });
	});

	it('drops an agent that is gone, and lists the agents nowhere but the Agents card', () => {
		sendToPage({ type: 'view', view: view([tickets, agents([done])]) });
		expect({
			rows: [...card('agents').querySelectorAll('.dash-row-title')].map(row => row.textContent),
			elsewhere: document.querySelectorAll('.card, #active, #earlier').length,
		}).toEqual({ rows: ['Add a test'], elsewhere: 0 });
	});

	it('opens an agent from its row\'s title, and its changes from Review', () => {
		posted.length = 0;
		const row = card('agents');
		(row.querySelector('.dash-row-title') as HTMLElement).click();
		buttonIn(row, 'Review').click();
		expect(posted).toEqual([
			{ type: 'action', action: { kind: 'agent', id: 'a2', do: 'open' } },
			{ type: 'action', action: { kind: 'agent', id: 'a2', do: 'review' } },
		]);
	});

	it('says so on the Agents card when there are no agents', () => {
		sendToPage({ type: 'view', view: view([agents([])]) });
		expect(card('agents').querySelector('.dash-note')?.textContent).toBe('No agents at work. Describe a task above to start one.');
	});
});

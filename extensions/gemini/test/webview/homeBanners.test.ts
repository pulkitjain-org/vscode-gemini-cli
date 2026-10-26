/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Home's banners: one per team server that is down, with Retry, and one per
// server that refused the token, with Replace Token. Cards keep their last
// results, with the time.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { HomeBanner, HomeCard, HomeView } from '../../src/host/panelProtocol';
import { page, posted, sendToPage, showHomePage, startScript } from './pages';

const { document } = page;
const byId = (id: string) => document.getElementById(id) as HTMLElement;

const gitlabDown: HomeBanner = { tool: 'gitlab', tone: 'warn', text: 'GitLab is unreachable, probably the VPN. Showing results from 10:42.', button: { label: 'Retry', action: { kind: 'retry', tool: 'gitlab' } } };
const jiraRefused: HomeBanner = { tool: 'jira', tone: 'error', text: 'Jira rejected your token.', button: { label: 'Replace Token...', action: { kind: 'command', command: 'gemini.connections' }, primary: true } };
const mergeRequests: HomeCard = { id: 'mergeRequests', title: 'Pending on me', tool: 'gitlab', stale: true, asOf: '10:42', rows: [{ key: '!482', title: 'Rate limit login' }] };

function view(banners?: readonly HomeBanner[]): HomeView {
	return {
		workspaces: [{ name: 'shop', description: '~/work', folder: '/work/shop', git: true }],
		active: [],
		earlier: [],
		ownBranch: false,
		modes: [],
		dashboard: {
			greeting: 'Good morning', context: 'shop', tools: [], quickActions: [], needs: [], needsQuery: '', cards: [mergeRequests], layout: [], releaseBranches: [], refreshing: false,
			...banners ? { banners } : {},
		},
	};
}

/** The banners as shown: tone, text and button. */
function shown() {
	const box = byId('banners');
	return box.hidden ? [] : [...box.querySelectorAll('.dash-banner')].map(node => ({
		tone: node.classList.contains('error') ? 'error' : 'warn',
		text: node.querySelector('span')?.textContent,
		button: node.querySelector('button')?.textContent,
	}));
}

beforeAll(async () => {
	await showHomePage();
	await startScript('home');
});

describe('Home\'s team banners', () => {
	it('show one per server, with Retry for one that is down and Replace Token for a refused token', () => {
		sendToPage({ type: 'view', view: view([jiraRefused, gitlabDown]) });
		expect(shown()).toEqual([
			{ tone: 'error', text: 'Jira rejected your token.', button: 'Replace Token...' },
			{ tone: 'warn', text: 'GitLab is unreachable, probably the VPN. Showing results from 10:42.', button: 'Retry' },
		]);
	});

	it('run their buttons: Retry checks the server again, Replace Token opens Connections', () => {
		posted.length = 0;
		for (const button of document.querySelectorAll('#banners button')) {
			(button as HTMLElement).click();
		}
		expect(posted).toEqual([
			{ type: 'action', action: { kind: 'command', command: 'gemini.connections' } },
			{ type: 'action', action: { kind: 'retry', tool: 'gitlab' } },
		]);
	});

	it('clear by themselves when the extension drops them', () => {
		sendToPage({ type: 'view', view: view([gitlabDown]) });
		const one = shown().length;
		sendToPage({ type: 'view', view: view() });
		expect({ one, none: shown(), hidden: byId('banners').hidden }).toEqual({ one: 1, none: [], hidden: true });
	});

	it('leave the cards their last results, with the time', () => {
		const card = document.querySelector('[data-card="mergeRequests"]')!;
		expect({ stale: card.classList.contains('stale'), time: card.querySelector('.dash-as-of')?.textContent, rows: card.querySelectorAll('.dash-row').length })
			.toEqual({ stale: true, time: '10:42', rows: 1 });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// A project chat's side panel: threads waiting to start, each thread's and
// the project's requests, and the banner while today's quota holds threads.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLButtonElement } from 'happy-dom';
import type { ProjectPanel } from '../../src/host/chatProtocol';
import { page, posted, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;

const panel: ProjectPanel = {
	name: 'Checkout redesign',
	counts: { queued: 1, working: 1, waiting: 0, planned: 0, done: 1, merged: 0 },
	threads: [
		{ id: 't1', title: 'Payment form', state: 'working', requests: '148 requests' },
		{ id: 't2', title: 'Address autocomplete', state: 'done', requests: '63 requests' },
		{ id: 't3', title: 'Order summary', state: 'queued', detail: 'Starts when a running thread finishes · 4 of 4 running' },
	],
	requests: 'This project: 211 requests across 2 threads',
	held: 'Holding 2 new threads: today\'s quota is 92% used. They start when it resets at 20:39.',
};

beforeAll(async () => {
	await showChatPage({ project: true });
	await startScript('chat');
	sendToPage({ type: 'reset', items: [], busy: false, status: { phase: 'ready', text: '' }, settings: {} });
	sendToPage({ type: 'projectPanel', panel });
});

describe('the project panel', () => {
	it('lists a queued thread with when it starts, each thread\'s requests and the project\'s', () => {
		const aside = document.getElementById('project-panel')!;
		const rows = [...aside.querySelectorAll('.panel-thread')] as unknown as HTMLButtonElement[];
		rows[2].click();
		rows[0].click();
		expect({
			rows: rows.map(row => [row.querySelector('.panel-thread-title')?.textContent, row.querySelector('.panel-thread-requests')?.textContent ?? null, row.querySelector('.panel-thread-detail')?.textContent ?? null, row.disabled]),
			counts: [...aside.querySelectorAll('.panel-row')].map(row => row.textContent).filter(text => /waiting to start|working|done/.test(text ?? '')),
			total: aside.querySelector('.panel-requests')?.textContent,
			opened: posted.filter(message => message.type === 'threadAction').map(message => message.thread),
		}).toEqual({
			rows: [
				['Payment form', '148 requests', null, false],
				['Address autocomplete', '63 requests', null, false],
				['Order summary', null, panel.threads[2].detail, true],
			],
			counts: ['1 waiting to start', '1 working', '1 done, ready to merge'],
			total: panel.requests,
			opened: ['t1'],
		});
	});

	it('shows the quota hold with Start Anyway', () => {
		posted.length = 0;
		const held = document.querySelector('.panel-held')!;
		([...held.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Start Anyway') as unknown as HTMLButtonElement | undefined)?.click();
		expect({ text: held.querySelector('.panel-held-text')?.textContent, sent: posted }).toEqual({ text: panel.held, sent: [{ type: 'threadAction', thread: '', action: 'startAnyway' }] });
	});
});

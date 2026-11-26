/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// What the chat tells a screen reader: a question the agent waits on, and the
// composer's @ menu as a combobox.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLTextAreaElement } from 'happy-dom';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { page, posted, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;
const input = () => document.getElementById('input') as HTMLTextAreaElement;
const prompt: TranscriptItem = { id: 'u1', kind: 'user', text: 'Fix the cart' };

const permission: TranscriptItem = {
	id: 'p1', kind: 'permission', title: 'Edit cart.ts', diffPaths: [],
	options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
};

beforeAll(async () => {
	await showChatPage();
	// The time to the first output is a developer's figure, shown with developer tools on.
	(document.querySelector('script[data-strings]') as unknown as { dataset: Record<string, string> }).dataset.developer = 'true';
	await startScript('chat');
	sendToPage({ type: 'reset', items: [prompt], busy: true, status: { phase: 'ready', text: '' }, settings: {} });
});

describe('a question from the agent', () => {
	it('is announced while the user types, without taking focus from the composer', () => {
		input().focus();
		sendToPage({ type: 'items', items: [permission] });
		expect({ announced: document.getElementById('announce')!.textContent, focused: document.activeElement === input() })
			.toEqual({ announced: 'Gemini is waiting for your answer: Edit cart.ts', focused: true });
	});
});

describe('the composer', () => {
	it('has a name', () => {
		expect(input().getAttribute('aria-label')).toBe('Message to Gemini');
	});

	it('is a combobox while its @ menu is open, following the highlighted file', () => {
		const field = input();
		field.focus();
		field.value = 'see @car';
		field.setSelectionRange(field.value.length, field.value.length);
		field.dispatchEvent(new page.Event('input'));
		const search = posted.findLast(message => message.type === 'searchFiles');
		sendToPage({ type: 'files', requestId: search?.requestId, files: [{ path: '/w/cart.ts', relative: 'src/cart.ts' }, { path: '/w/card.ts', relative: 'src/card.ts' }] });
		field.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		const picker = document.getElementById('picker')!;
		const attributes = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, field.getAttribute(name)]));
		const names = ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant'];
		expect({ ...attributes(names), list: picker.getAttribute('role'), label: picker.getAttribute('aria-label'), active: document.getElementById('picker-1')?.getAttribute('aria-selected') })
			.toEqual({ 'role': 'combobox', 'aria-expanded': 'true', 'aria-controls': 'picker', 'aria-autocomplete': 'list', 'aria-activedescendant': 'picker-1', list: 'listbox', label: 'Files to attach', active: 'true' });
		field.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(attributes(names)).toEqual(Object.fromEntries(names.map(name => [name, null])));
	});
});

describe('a turn\'s end', () => {
	it('writes its times from the host\'s templates, with the numbers and units as the locale writes them', () => {
		sendToPage({ type: 'foldWork', on: false });
		sendToPage({ type: 'reset', items: [prompt, { id: 'e1', kind: 'turnEnd', durationMs: 125_000, firstTokenMs: 1400 }, { id: 'u2', kind: 'user', text: 'Again' }, { id: 'e2', kind: 'turnEnd', durationMs: 9000, firstTokenMs: 380 }], busy: false, status: { phase: 'ready', text: '' }, settings: {} });
		expect([...document.querySelectorAll('.turn-end')].map(end => [end.querySelector('.worked-for')?.textContent, end.querySelector('.first-token')?.textContent]))
			.toEqual([['Worked for 2m 5s', 'first token 1.4 s'], ['Worked for 9s', 'first token 380 ms']]);
	});
});

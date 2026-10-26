/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Opening, closing and updating the chat's rows keeps the keyboard where the
// user left it, and a streaming thought keeps the text selected in it.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLDetailsElement, HTMLElement } from 'happy-dom';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { page, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;

type ToolCall = Extract<TranscriptItem, { kind: 'toolCall' }>;

function toolCall(id: string, title: string, toolKind = 'read', output = 'output of ' + id): ToolCall {
	return { id, kind: 'toolCall', title, toolKind, status: 'completed', locations: [], details: [{ type: 'text', text: output }] };
}

const prompt: TranscriptItem = { id: 'u1', kind: 'user', text: 'Look at the cart' };

function reset(items: readonly TranscriptItem[], busy = false): void {
	sendToPage({ type: 'reset', items, busy, status: { phase: 'ready', text: '' }, settings: {} });
}

function only<T = HTMLElement>(selector: string): T {
	const found = document.querySelectorAll(selector);
	expect(found).toHaveLength(1);
	return found[0] as T;
}

function press(node: HTMLElement, key: string): void {
	node.dispatchEvent(new page.KeyboardEvent('keydown', { key, bubbles: true }));
}

beforeAll(async () => {
	await showChatPage();
	await startScript('chat');
});

describe('a tool call without folding', () => {
	beforeAll(() => sendToPage({ type: 'foldWork', on: false }));

	it('opens and closes in place, keeping focus on its row, and builds its output on first open', () => {
		reset([prompt, toolCall('t1', 'Read cart.ts'), { id: 'e1', kind: 'turnEnd', durationMs: 4000 }]);
		const card = only('.tool-call');
		const row = card.querySelector('.tool-row') as HTMLElement;
		expect(card.querySelector('.tool-body')).toBeNull();
		row.focus();
		row.click();
		expect({ focused: document.activeElement === row, same: only('.tool-call') === card, expanded: row.getAttribute('aria-expanded'), output: card.querySelector('.tool-output')?.textContent }).toEqual({ focused: true, same: true, expanded: 'true', output: 'output of t1' });
		press(row, 'Enter');
		expect({ focused: document.activeElement === row, expanded: row.getAttribute('aria-expanded'), open: card.classList.contains('expanded') }).toEqual({ focused: true, expanded: 'false', open: false });
	});

	it('moves focus to the row drawn in place of the focused one', () => {
		reset([prompt, toolCall('t1', 'Read cart.ts'), { id: 'e1', kind: 'turnEnd', durationMs: 4000 }]);
		const row = only('.tool-row');
		row.focus();
		sendToPage({ type: 'items', items: [toolCall('t1', 'Read cart.ts and more')] });
		const drawn = only('.tool-row');
		expect({ replaced: drawn !== row, focused: document.activeElement === drawn }).toEqual({ replaced: true, focused: true });
	});
});

describe('a turn that folds', () => {
	beforeAll(() => sendToPage({ type: 'foldWork', on: true }));

	it('opens and closes its fold in place, keeping focus on the fold\'s line', () => {
		reset([prompt, toolCall('t1', 'Read cart.ts'), { id: 'a1', kind: 'agent', text: 'Done.' }, { id: 'e1', kind: 'turnEnd', durationMs: 4000 }]);
		const head = only('.work-head');
		head.focus();
		head.click();
		expect({ focused: document.activeElement === head, same: only('.work-head') === head, expanded: head.getAttribute('aria-expanded'), steps: document.querySelectorAll('.work-body .tool-call').length }).toEqual({ focused: true, same: true, expanded: 'true', steps: 1 });
		press(head, ' ');
		expect({ focused: document.activeElement === head, expanded: head.getAttribute('aria-expanded') }).toEqual({ focused: true, expanded: 'false' });
	});

	it('keeps focus on the fold\'s line while new steps redraw it', () => {
		reset([prompt, toolCall('t1', 'Read cart.ts')], true);
		const head = only('.work-head');
		head.focus();
		sendToPage({ type: 'items', items: [toolCall('t2', 'Search for total', 'search')] });
		const drawn = only('.work-head');
		expect({ replaced: drawn !== head, focused: document.activeElement === drawn }).toEqual({ replaced: true, focused: true });
	});

	it('opens and closes a run of steps in place, keeping focus on its line', () => {
		reset([prompt, toolCall('t1', 'Read cart.ts'), toolCall('t2', 'Read total.ts'), { id: 'a1', kind: 'agent', text: 'Done.' }, { id: 'e1', kind: 'turnEnd', durationMs: 4000 }]);
		only('.work-head').click();
		const row = only('.work-run-row');
		row.focus();
		row.click();
		expect({ focused: document.activeElement === row, same: only('.work-run-row') === row, expanded: row.getAttribute('aria-expanded'), calls: document.querySelectorAll('.work-run-calls .tool-call').length }).toEqual({ focused: true, same: true, expanded: 'true', calls: 2 });
		row.click();
		expect({ focused: document.activeElement === row, expanded: row.getAttribute('aria-expanded') }).toEqual({ focused: true, expanded: 'false' });
	});

	it('streams a thought into the same element, keeping it open and the text selected in it', () => {
		reset([prompt, { id: 'th1', kind: 'thought', text: 'Checking the cart' }], true);
		const thought = only<HTMLDetailsElement>('details.thought');
		thought.open = true;
		const text = thought.querySelector('.thought-text')!.firstChild!;
		const selection = page.getSelection()!;
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 8);
		selection.removeAllRanges();
		selection.addRange(range);
		sendToPage({ type: 'items', items: [{ kind: 'append', id: 'th1', append: ' totals' }] });
		expect({
			same: only('details.thought') === thought,
			open: thought.open,
			text: thought.querySelector('.thought-text')!.textContent,
			selected: selection.toString(),
		}).toEqual({ same: true, open: true, text: 'Checking the cart totals', selected: 'Checking' });
	});
});

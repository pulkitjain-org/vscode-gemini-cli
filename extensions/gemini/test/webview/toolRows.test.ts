/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The chat's rows as controls: an expandable tool row is a plain line whose
// chevron and title are one button, with the file and diff chips beside it as
// buttons of their own; a title that opens the one file it names is a link to
// the keyboard too; a shell block's result reads as text beside its language;
// the compact line shows only the context figure the CLI counted.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { page, posted, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;

const prompt: TranscriptItem = { id: 'u1', kind: 'user', text: 'Look at the cart' };

function reset(items: readonly TranscriptItem[]): void {
	sendToPage({ type: 'reset', items, busy: false, status: { phase: 'ready', text: '' }, settings: {} });
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
	sendToPage({ type: 'foldWork', on: false });
});

describe('an expandable tool row', () => {
	it('is a plain line with one toggle button and the chips beside it, which Return opens and closes', () => {
		reset([prompt, {
			id: 't1', kind: 'toolCall', title: 'Edit cart.ts', toolKind: 'edit', status: 'completed',
			locations: [{ path: '/w/src/cart.ts', line: 4 }], details: [{ type: 'text', text: 'wrote 3 lines' }, { type: 'diff', path: '/w/src/cart.ts', added: 3, removed: 1 }],
		}]);
		const row = only('.tool-row');
		const toggle = row.querySelector(':scope > button.tool-toggle') as HTMLElement;
		const chips = [...row.querySelectorAll(':scope > button.chip')].map(chip => chip.textContent);
		const before = toggle.getAttribute('aria-expanded');
		toggle.click();
		expect({
			role: row.getAttribute('role'), tabIndex: row.getAttribute('tabindex'), title: toggle.querySelector('.tool-title')?.textContent,
			nested: toggle.querySelectorAll('button').length, chips, before, after: toggle.getAttribute('aria-expanded'), output: only('.tool-output').textContent,
		}).toEqual({ role: null, tabIndex: null, title: 'Edit cart.ts', nested: 0, chips: ['cart.ts:4', '+3-1'], before: 'false', after: 'true', output: 'wrote 3 lines' });
		toggle.click();
		expect({ expanded: toggle.getAttribute('aria-expanded'), open: only('.tool-call').classList.contains('expanded') }).toEqual({ expanded: 'false', open: false });
	});

	it('opens from a click on the rest of the line, and not from a chip', () => {
		reset([prompt, { id: 't2', kind: 'toolCall', title: 'Read cart.ts', toolKind: 'read', status: 'completed', locations: [{ path: '/w/src/cart.ts' }], details: [{ type: 'text', text: 'the file' }] }]);
		posted.length = 0;
		(only('.tool-row > button.chip') as HTMLElement).click();
		const afterChip = only('.tool-toggle').getAttribute('aria-expanded');
		only('.tool-row').click();
		expect({ afterChip, posted, afterRow: only('.tool-toggle').getAttribute('aria-expanded') }).toEqual({ afterChip: 'false', posted: [{ type: 'openLocation', path: '/w/src/cart.ts', line: undefined }], afterRow: 'true' });
	});
});

describe('a title that opens the file it names', () => {
	it('is a link the keyboard reaches, named by the path, and Return opens it', () => {
		reset([prompt, { id: 't3', kind: 'toolCall', title: 'Read cart.ts', toolKind: 'read', status: 'completed', locations: [{ path: '/w/src/cart.ts', line: 12 }], details: [] }]);
		posted.length = 0;
		const title = only('.tool-title.tool-link');
		press(title, 'Enter');
		expect({ role: title.getAttribute('role'), tabIndex: title.tabIndex, label: title.getAttribute('aria-label'), chips: document.querySelectorAll('.tool-row .chip').length, posted })
			.toEqual({ role: 'link', tabIndex: 0, label: '/w/src/cart.ts', chips: 0, posted: [{ type: 'openLocation', path: '/w/src/cart.ts', line: 12 }] });
	});
});

describe('a shell block that ran', () => {
	const reply: TranscriptItem = { id: 'a1', kind: 'agent', text: 'Run it:\n\n```sh\nnpm test\n```\n' };

	it('shows the exit code the terminal reported as text beside the language, and Send Output among the actions only when it failed', () => {
		reset([prompt, reply]);
		sendToPage({ type: 'runView', view: { mode: 'ask', places: ['shop'] } });
		sendToPage({ type: 'runState', text: 'npm test\n', state: { kind: 'done', exitCode: 0 } });
		const passed = { language: only('.code-language').textContent, tone: only('.run-status').className, send: document.querySelectorAll('.run-send').length };
		sendToPage({ type: 'runState', text: 'npm test\n', state: { kind: 'done', exitCode: 2 } });
		const failed = { language: only('.code-language').textContent, tone: only('.run-status').className, send: document.querySelectorAll('.code-header > .run-send').length, status: document.querySelectorAll('.run-status').length };
		expect({ passed, failed }).toEqual({
			passed: { language: 'shexit 0', tone: 'run-status passed', send: 0 },
			failed: { language: 'shexit 2', tone: 'run-status failed', send: 1, status: 1 },
		});
	});

	it('shows no time, which the shell does not report, and only a mark when it reported no exit code', () => {
		reset([prompt, reply]);
		sendToPage({ type: 'runState', text: 'npm test\n', state: { kind: 'done', ms: 1200 } });
		expect({ language: only('.code-language').textContent, mark: only('.run-status .codicon').className.includes('codicon-check') }).toEqual({ language: 'sh', mark: true });
	});
});

describe('the compact line', () => {
	it('names the context figure the CLI counted, and no figure when it counted none', () => {
		reset([prompt, { id: 'c1', kind: 'compact', state: 'done', before: 48000, kept: 2, from: 's1', to: 's2' }]);
		const counted = only('.compact-label span:last-child').textContent;
		reset([prompt, { id: 'c2', kind: 'compact', state: 'done', kept: 2, from: 's1', to: 's2' }]);
		expect({ counted, uncounted: only('.compact-label span:last-child').textContent }).toEqual({ counted: 'Compressed from 48K tokens of context', uncounted: 'Compressed' });
	});
});

describe('a confirm-class card', () => {
	it('marks the class with the shared pill in the warn tone', () => {
		reset([prompt, { id: 'p1', kind: 'permission', title: 'Comment on ACME-1', diffPaths: [], confirm: true, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }]);
		expect(only('.permission-pill').className).toBe('permission-pill warn');
	});
});

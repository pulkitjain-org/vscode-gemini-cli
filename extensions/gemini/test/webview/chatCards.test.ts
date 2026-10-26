/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The chat's notices and cards, drawn by the real page: a failed turn's ways
// out, the stall notice, a permission card answered from the chat box, the
// warning about another agent's changes, and a long tool output's Show All.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HTMLButtonElement, HTMLElement, HTMLTextAreaElement } from 'happy-dom';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { page, posted, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;
const mac = /Mac/.test(page.navigator.platform);

const prompt: TranscriptItem = { id: 'u1', kind: 'user', text: 'Add rate limiting and run the tests' };
const settings = { model: { currentId: 'flash', available: [{ id: 'flash', name: 'Gemini Flash' }, { id: 'pro', name: 'Gemini Pro' }] } };

function reset(items: readonly TranscriptItem[], busy = false): void {
	sendToPage({ type: 'reset', items, busy, status: { phase: 'ready', text: '' }, settings });
	posted.length = 0;
}

function buttons(root: HTMLElement): HTMLButtonElement[] {
	return [...root.querySelectorAll('button')] as unknown as HTMLButtonElement[];
}

function byText(root: HTMLElement, text: string): HTMLButtonElement {
	const found = buttons(root).find(node => node.textContent?.trim() === text);
	expect(found, text).toBeDefined();
	return found!;
}

function only(selector: string): HTMLElement {
	const found = document.querySelectorAll(selector);
	expect(found, selector).toHaveLength(1);
	return found[0] as unknown as HTMLElement;
}

/** A key pressed in the chat box; whether it got past the page (to the composer and the workbench). */
function pressInComposer(init: { key: string; code?: string; alt?: boolean; command?: boolean }): boolean {
	const input = document.getElementById('input') as unknown as HTMLTextAreaElement;
	input.focus();
	let reachedWindow = false;
	const seen = () => reachedWindow = true;
	page.addEventListener('keydown', seen);
	input.dispatchEvent(new page.KeyboardEvent('keydown', {
		key: init.key, code: init.code ?? init.key, bubbles: true, cancelable: true,
		altKey: !!init.alt, metaKey: !!init.command && mac, ctrlKey: !!init.command && !mac,
	}));
	page.removeEventListener('keydown', seen);
	return reachedWindow;
}

beforeAll(async () => {
	await showChatPage();
	await startScript('chat');
	sendToPage({ type: 'foldWork', on: false });
});

beforeEach(() => {
	posted.length = 0;
});

describe('a failed turn\'s notice', () => {
	it('offers its ways out: Retry and Continue ask the host, Sign In and Show Log run commands', () => {
		reset([prompt, { id: 'n1', kind: 'notice', severity: 'error', text: 'Quota used up for gemini-3.8-flash.', actions: ['retry', 'switchModel', 'signIn', 'showLog'] }, { id: 'n2', kind: 'notice', severity: 'info', text: 'The turn reached the request limit.', actions: ['continue'] }]);
		const [quota, limit] = [...document.querySelectorAll('.notice.has-actions')] as unknown as HTMLElement[];
		expect(buttons(quota).map(node => [node.textContent, node.className])).toEqual([['Retry', 'primary'], ['Switch Model…', 'secondary'], ['Sign In', 'secondary'], ['Show Log', 'link-button']]);
		byText(quota, 'Retry').click();
		byText(quota, 'Sign In').click();
		byText(quota, 'Show Log').click();
		byText(limit, 'Continue').click();
		expect(posted).toEqual([
			{ type: 'noticeAction', itemId: 'n1', action: 'retry' },
			{ type: 'command', command: 'gemini.signIn' },
			{ type: 'command', command: 'gemini.showLog' },
			{ type: 'noticeAction', itemId: 'n2', action: 'continue' },
		]);
	});

	it('opens the model menu beside Send with Switch Model', () => {
		reset([prompt, { id: 'n1', kind: 'notice', severity: 'error', text: 'Quota used up.', actions: ['retry', 'switchModel'] }]);
		const menu = document.getElementById('model-menu') as unknown as HTMLElement;
		expect(menu.hidden).toBe(true);
		byText(only('.notice.has-actions'), 'Switch Model…').click();
		expect(menu.hidden).toBe(false);
		page.document.body.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	});

	it('keeps a notice without ways out a plain line', () => {
		reset([prompt, { id: 'n1', kind: 'notice', severity: 'info', text: 'Stopped.' }]);
		expect([document.querySelectorAll('.notice.has-actions').length, only('.notice').textContent]).toEqual([0, 'Stopped.']);
	});
});

describe('the stall notice', () => {
	it('shows at the end of the running turn with Stop and Show Log, and goes when anything arrives', () => {
		reset([prompt, { id: 't1', kind: 'toolCall', title: 'Read cart.ts', toolKind: 'read', status: 'completed', locations: [], details: [] }], true);
		sendToPage({ type: 'stall', stall: { text: 'No response from Gemini for 45 s. It may be retrying a busy server.', actions: ['stop', 'showLog'] } });
		const stall = only('.stall-notice');
		expect([stall.textContent?.startsWith('No response from Gemini for 45 s.'), document.getElementById('transcript')?.lastElementChild === stall]).toEqual([true, true]);
		byText(stall, 'Stop').click();
		byText(stall, 'Show Log').click();
		expect(posted).toEqual([{ type: 'stop' }, { type: 'command', command: 'gemini.showLog' }]);
		sendToPage({ type: 'stall', stall: undefined });
		expect(document.querySelectorAll('.stall-notice')).toHaveLength(0);
	});
});

describe('a permission card', () => {
	const card = (id: string, extra: Partial<Extract<TranscriptItem, { kind: 'permission' }>> = {}): TranscriptItem => ({
		id, kind: 'permission', title: 'npx vitest run test/auth', diffPaths: [], prefixes: ['npx vitest'],
		options: [
			{ optionId: 'proceed_always', name: 'Allow npx vitest for this session', kind: 'allow_always' },
			{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
			{ optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
		],
		...extra,
	});
	const keys = mac ? ['⌥⌘↩', '⌥⌘S', 'Esc'] : ['Ctrl+Alt+Enter', 'Ctrl+Alt+S', 'Esc'];

	it('names the prefix it allows for the session, and shows the keys on the newest waiting card only', () => {
		reset([prompt, card('p1'), card('p2')], true);
		const [older, newest] = [...document.querySelectorAll('.permission')] as unknown as HTMLElement[];
		expect([older.classList.contains('newest'), newest.classList.contains('newest')]).toEqual([false, true]);
		expect(buttons(newest).map(node => node.textContent)).toEqual([`Allow once${keys[0]}`, `Allow npx vitest for this session${keys[1]}`, `Reject${keys[2]}`]);
		expect(newest.querySelector('code')?.textContent).toBe('npx vitest');
		expect(newest.querySelector('.permission-key-hint')?.textContent).toBe(`Answer from the chat box: ${keys[0]} allows once, ${keys[1]} allows for this session, ${keys[2]} rejects.`);
	});

	it('is answered from the chat box, and the keys go no further', () => {
		reset([prompt, card('p1')], true);
		const passed = [
			pressInComposer({ key: 'Enter', alt: true, command: true }),
			pressInComposer({ key: mac ? 'ß' : 's', code: 'KeyS', alt: true, command: true }),
			pressInComposer({ key: 'Escape' }),
		];
		expect(passed).toEqual([false, false, false]);
		expect(posted).toEqual([
			{ type: 'permission', id: 'p1', optionId: 'proceed_once' },
			{ type: 'permission', id: 'p1', optionId: 'proceed_always' },
			{ type: 'permission', id: 'p1', optionId: 'cancel' },
		]);
	});

	it('leaves the keys to the composer when no card waits', () => {
		reset([prompt, card('p1', { answer: { kind: 'selected', name: 'Allow' } })], true);
		expect(pressInComposer({ key: mac ? 'ß' : 's', code: 'KeyS', alt: true, command: true })).toBe(true);
		expect(posted.filter(message => message.type === 'permission')).toEqual([]);
	});

	it('offers no session key on a confirm-class card', () => {
		reset([prompt, card('p1', { confirm: true, prefixes: undefined, options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }] })], true);
		expect(only('.permission-key-hint').textContent).toBe(`Answer from the chat box: ${keys[0]} allows once, ${keys[2]} rejects.`);
		expect(pressInComposer({ key: mac ? 'ß' : 's', code: 'KeyS', alt: true, command: true })).toBe(true);
	});

	it('warns when another agent has unreviewed changes in the file, with Show Its Changes', () => {
		reset([prompt, card('p1', { title: 'Edit src/auth/login.ts', prefixes: undefined, diffPaths: ['/w/src/auth/login.ts'], others: [{ agent: 'a2', title: 'Login fix' }] })], true);
		const warning = only('.permission-shared');
		expect(warning.textContent).toBe('"Login fix" also has unreviewed changes in this file.Edits from both agents will mix. Give this agent its own branch to keep them apart.Show Its Changes');
		byText(warning, 'Show Its Changes').click();
		expect(posted).toEqual([{ type: 'showAgentChanges', agent: 'a2' }]);
	});
});

describe('a tool call', () => {
	it('says on its row when an edit made without a card shares a file with another agent', () => {
		reset([prompt, { id: 't1', kind: 'toolCall', title: 'Edit login.ts', toolKind: 'edit', status: 'completed', locations: [], details: [{ type: 'diff', path: '/w/login.ts', added: 12, removed: 3 }], others: [{ agent: 'a2', title: 'Login fix' }] }]);
		const note = only('.tool-shared');
		expect(note.textContent).toBe('"Login fix" also has unreviewed changes in this file.Show Its Changes');
		byText(note, 'Show Its Changes').click();
		expect(posted).toEqual([{ type: 'showAgentChanges', agent: 'a2' }]);
	});

	it('shows a long output\'s first and last lines, and the whole of it from the host with Show All', () => {
		const head = Array.from({ length: 20 }, (_, i) => `commit ${i}`).join('\n');
		const long: TranscriptItem = { id: 't2', kind: 'toolCall', title: 'git log --stat -200', toolKind: 'execute', status: 'completed', locations: [], details: [{ type: 'text', text: head, tail: '2 files changed', hiddenLines: 1240 }] };
		reset([prompt, long]);
		(only('.tool-call .tool-row') as unknown as HTMLButtonElement).click();
		const gap = only('.tool-output-gap');
		expect(gap.textContent).toBe(`${(1240).toLocaleString()} lines hidden·Show All`);
		byText(gap, 'Show All').click();
		expect(posted).toEqual([{ type: 'showOutput', itemId: 't2', part: 0 }]);
		sendToPage({ type: 'output', itemId: 't2', part: 0, text: 'the whole log' });
		expect([document.querySelectorAll('.tool-output-trimmed').length, only('.tool-output').textContent]).toEqual([0, 'the whole log']);
		// Drawn again, as after a reset, it still shows the whole output.
		reset([prompt, long]);
		(only('.tool-call .tool-row') as unknown as HTMLButtonElement).click();
		expect(only('.tool-output').textContent).toBe('the whole log');
	});

	it('says so when the host no longer keeps the whole output', () => {
		reset([prompt, { id: 't3', kind: 'toolCall', title: 'git log', toolKind: 'execute', status: 'completed', locations: [], details: [{ type: 'text', text: 'a', tail: 'z', hiddenLines: 100 }] }]);
		(only('.tool-call .tool-row') as unknown as HTMLButtonElement).click();
		sendToPage({ type: 'output', itemId: 't3', part: 0, text: undefined });
		expect(only('.tool-output-gap').textContent).toBe('The full output is no longer kept.');
	});
});

describe('tooltips', () => {
	it('uses the themed tooltip, never a native title, on tool rows, chips and saved prompts', () => {
		reset([
			{ id: 'u2', kind: 'user', text: 'Look', attachments: [{ kind: 'file', label: 'cart.ts', path: '/w/cart.ts' }] },
			{ id: 't1', kind: 'toolCall', title: 'Read src/cart.ts', toolKind: 'read', status: 'completed', locations: [{ path: '/w/src/cart.ts' }, { path: '/w/src/other.ts', line: 3 }], details: [{ type: 'diff', path: '/w/src/cart.ts', added: 1, removed: 0 }] },
		]);
		const transcript = document.getElementById('transcript') as unknown as HTMLElement;
		expect([transcript.querySelectorAll('[title]').length, transcript.querySelectorAll('[data-tip]').length > 3]).toEqual([0, true]);
	});
});

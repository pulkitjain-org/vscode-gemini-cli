/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// A long chat draws its latest turns and a slot per older one; a slot is
// drawn in its place as it comes near the view and taken out again once far
// from it (webview-src/virtualBlocks.ts). The observers are stand-ins here,
// driven by the tests.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { page, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;

interface FakeObserver {
	readonly callback: (entries: { target: unknown; isIntersecting: boolean }[]) => void;
	readonly rootMargin: string;
	readonly watched: Set<HTMLElement>;
}

/** The observers the view made, with what each watches. */
const observers: FakeObserver[] = [];
let elements: Map<string, HTMLElement>;

function observer(which: 'near' | 'far'): FakeObserver {
	const margins = observers.map(found => parseInt(found.rootMargin, 10));
	const wanted = which === 'near' ? Math.min(...margins) : Math.max(...margins);
	return observers.find(found => parseInt(found.rootMargin, 10) === wanted)!;
}

function turn(index: number, answer = `Answer ${index}`): TranscriptItem[] {
	return [
		{ id: `u${index}`, kind: 'user', text: `Question ${index}` },
		{ id: `t${index}`, kind: 'toolCall', title: `Read file ${index}`, toolKind: 'read', status: 'completed', locations: [], details: [] },
		{ id: `a${index}`, kind: 'agent', text: answer },
		{ id: `e${index}`, kind: 'turnEnd', durationMs: 4000 },
	];
}

function reset(turns: number): void {
	sendToPage({ type: 'reset', items: Array.from({ length: turns }, (_, i) => turn(i)).flat(), busy: false, status: { phase: 'ready', text: '' }, settings: {} });
}

function transcript(): HTMLElement {
	return document.getElementById('transcript') as HTMLElement;
}

function slots(): HTMLElement[] {
	return [...transcript().querySelectorAll('.turn-slot')] as HTMLElement[];
}

function drawn(): HTMLElement[] {
	return [...transcript().children].filter(child => !child.classList.contains('turn-slot')) as HTMLElement[];
}

function isSlot(node: HTMLElement | undefined): boolean {
	return !!node?.classList.contains('turn-slot');
}

/** Tells the near observer that `slot` came into reach of the view. */
function comeNear(slot: HTMLElement): void {
	observer('near').callback([{ target: slot, isIntersecting: true }]);
}

/** Tells the far observer that every drawn element it watches is far from the view. */
function allFar(): void {
	observer('far').callback([...observer('far').watched].filter(node => node.isConnected).map(target => ({ target, isIntersecting: false })));
}

beforeAll(async () => {
	Object.assign(globalThis, {
		IntersectionObserver: class {
			private readonly entry: FakeObserver;
			constructor(callback: FakeObserver['callback'], options: { rootMargin: string }) {
				this.entry = { callback, rootMargin: options.rootMargin, watched: new Set() };
				observers.push(this.entry);
			}
			observe(node: HTMLElement) {
				this.entry.watched.add(node);
			}
			unobserve(node: HTMLElement) {
				this.entry.watched.delete(node);
			}
			disconnect() {
				this.entry.watched.clear();
			}
		},
	});
	await showChatPage();
	await startScript('chat');
	elements = (await startScript('view')).elements as Map<string, HTMLElement>;
	sendToPage({ type: 'foldWork', on: true });
});

describe('a chat of 100 turns', () => {
	it('opens with its latest 15 turns drawn and a slot for each older one, which the outline scrolls to', () => {
		reset(100);
		expect({
			slots: slots().length,
			drawn: drawn().length,
			first: drawn()[0].textContent?.trim(),
			latestPromptIsSlot: isSlot(elements.get('u99')),
			oldPromptIsSlot: isSlot(elements.get('u3')),
			oldReplyShares: elements.get('e3') === elements.get('u3'),
			watchedSlots: observer('near').watched.size,
		}).toEqual({ slots: 85, drawn: 60, first: 'Question 85', latestPromptIsSlot: false, oldPromptIsSlot: true, oldReplyShares: true, watchedSlots: 85 });
	});

	it('draws a turn in its slot\'s place as it comes near, between its neighbours, and watches it', () => {
		reset(100);
		const slot = elements.get('u3')!;
		comeNear(slot);
		const prompt = elements.get('u3')!;
		const end = elements.get('e3')!;
		expect({
			slotGone: slot.isConnected,
			prompt: prompt.textContent?.trim(),
			settled: prompt.classList.contains('settled') && end.classList.contains('settled'),
			before: prompt.previousElementSibling === elements.get('u2'),
			after: end.nextElementSibling === elements.get('u4'),
			turnChildren: [prompt, prompt.nextElementSibling, end.previousElementSibling, end].map(node => node?.className.split(' ')[0]),
			slots: slots().length,
			watchedFar: [...observer('far').watched].every(node => node.isConnected) && observer('far').watched.has(end),
		}).toEqual({ slotGone: false, prompt: 'Question 3', settled: true, before: true, after: true, turnChildren: ['user-turn', 'work-fold', 'message', 'turn-end'], slots: 84, watchedFar: true });
	});

	it('takes a drawn turn out again once it is far from the view', () => {
		reset(100);
		comeNear(elements.get('u3')!);
		comeNear(elements.get('u7')!);
		expect(drawn().length).toBe(68);
		allFar();
		expect({ drawn: drawn().length, slots: slots().length, slotAgain: isSlot(elements.get('u3')) && isSlot(elements.get('a7')), height: elements.get('u3')!.style.height }).toEqual({ drawn: 60, slots: 85, slotAgain: true, height: '320px' });
	});

	it('keeps a turn the user has focus in', () => {
		reset(100);
		comeNear(elements.get('u3')!);
		(elements.get('u3')!.nextElementSibling!.querySelector('.work-head') as HTMLElement).focus();
		allFar();
		expect({ drawn: drawn().length, focused: document.activeElement?.className }).toEqual({ drawn: 64, focused: expect.stringContaining('work-head') });
	});

	it('updates an item in a slot in the model only, and draws it as it is when the slot comes near', () => {
		reset(100);
		const slot = elements.get('u3')!;
		sendToPage({ type: 'items', items: [{ id: 'a3', kind: 'agent', text: 'A later answer' }] });
		expect({ same: elements.get('a3') === slot, drawn: drawn().length, shown: !!transcript().textContent?.includes('A later answer') }).toEqual({ same: true, drawn: 60, shown: false });
		comeNear(slot);
		expect(elements.get('a3')!.textContent?.trim()).toBe('A later answer');
	});

	it('releases the oldest drawn turns as the chat grows, taking them out once far from the view', () => {
		reset(100);
		for (let index = 100; index < 140; index++) {
			sendToPage({ type: 'items', items: turn(index) });
		}
		expect({ drawn: drawn().length, slots: slots().length, released: observer('far').watched.size }).toEqual({ drawn: 220, slots: 85, released: 120 });
		allFar();
		expect({ drawn: drawn().length, slots: slots().length, first: drawn()[0].textContent?.trim(), oldest: isSlot(elements.get('u114')) }).toEqual({ drawn: 100, slots: 115, first: 'Question 115', oldest: true });
	});
});

describe('a chat of 100 turns without folding', () => {
	beforeAll(() => sendToPage({ type: 'foldWork', on: false }));

	it('has a slot per item, and draws one item as its slot comes near', () => {
		reset(100);
		const slot = elements.get('t3')!;
		comeNear(slot);
		expect({ slots: slots().length, drawn: drawn().length, item: elements.get('t3')!.className.split(' ')[0], own: elements.get('u3') !== elements.get('t3') }).toEqual({ slots: 339, drawn: 61, item: 'tool-call', own: true });
	});

	it('draws only the latest items of a short chat', () => {
		reset(10);
		expect({ slots: slots().length, drawn: drawn().length }).toEqual({ slots: 0, drawn: 40 });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The side question panel draws a streamed answer a few times a second, not
// once per chunk (each draw parses the whole answer), and once more when it
// ends; the end is announced once, from the host, not by a live region.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLElement } from 'happy-dom';
import { page, startScript } from './pages';

const { document } = page;

type Side = { type: 'side'; id: number; state: 'open' | 'asked' | 'text' | 'done' | 'error'; question?: string; text?: string };
let onSide: (message: Side, host: unknown) => void;
let host: unknown;
let renders = 0;
const announced: string[] = [];

const strings = {
	title: 'Side question', note: 'The agent keeps working', placeholder: 'Ask about the chat', ask: 'Ask', close: 'Close', earlier: 'Earlier', later: 'Later',
	empty: 'Nothing asked yet', answering: 'Answering', stop: 'Stop', sendToAgent: 'Send to Agent', sendToAgentTip: 'Puts the answer in the message box', fork: 'Fork', forkTip: 'A chat of its own',
	copy: 'Copy', copied: 'Copied', hint: 'Enter asks', readCode: 'Read the code too', readCodeTip: 'Workers read the folder first',
};

beforeAll(async () => {
	onSide = (await startScript('sideChat')).onSide as typeof onSide;
	const composer = document.createElement('form');
	document.body.append(composer);
	host = {
		strings, composer, readsCode: true,
		post: () => undefined,
		renderMarkdown: (text: string) => {
			renders++;
			const node = document.createElement('p');
			node.textContent = text;
			return [node];
		},
		setDraft: () => undefined,
		setLabel: (node: HTMLElement, label: string) => node.setAttribute('aria-label', label),
		announce: (text: string) => announced.push(text),
	};
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('the side question panel', () => {
	it('draws a streamed answer at most every 150 ms and once at its end, announcing the end once', async () => {
		onSide({ type: 'side', id: 1, state: 'asked', question: 'Why is the cart wrong?' }, host);
		const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');
		for (let i = 1; i <= 30; i++) {
			onSide({ type: 'side', id: 1, state: 'text', text: words(i) }, host);
		}
		const atOnce = renders;
		// The question's own draw was a moment ago: the first chunk waits out the interval, and the others join it.
		await wait(200);
		const streamed = renders;
		onSide({ type: 'side', id: 1, state: 'done', text: words(30) }, host);
		const panel = document.querySelector('.side-chat') as HTMLElement;
		expect({
			atOnce, streamed, renders,
			text: panel.querySelector('.side-chat-answer')?.textContent,
			live: panel.querySelector('.side-chat-body')?.getAttribute('aria-live'),
			announced,
			titled: panel.querySelectorAll('[title]').length,
			actions: [...panel.querySelectorAll('.side-chat-actions button')].map(button => button.textContent),
		}).toEqual({
			atOnce: 0, streamed: 1, renders: 2,
			text: words(30),
			live: null,
			announced: [words(30)],
			titled: 0,
			actions: ['Send to Agent', 'Fork', 'Copy'],
		});
	});
});

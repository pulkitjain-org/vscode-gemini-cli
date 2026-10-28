/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The side question panel (/btw, ⌥⌘;): a question about the chat, answered
// while the agent keeps working, above the message box. Its own chunk
// (media/sideChat.js), loaded the first time a side question is asked
// (sideChatLoader.ts); everything it shares with the chat comes in `SideHost`.

import type { SideStrings, ToWebview } from '../src/host/chatProtocol';
import { sideSteeringDraft, type SideExchange } from '../src/acp/sideChat';

/** What the panel uses of the chat's own modules. */
export interface SideHost {
	readonly strings: SideStrings;
	/** The message box's form: the panel sits just above it. */
	readonly composer: HTMLElement;
	post(message: { readonly type: 'sideAsk'; readonly question: string } | { readonly type: 'sideCancel' } | { readonly type: 'requestFork'; readonly message: string }): void;
	renderMarkdown(text: string): Node[];
	/** Puts text in the message box, to edit and send. */
	setDraft(text: string): void;
	setLabel(node: HTMLElement, label: string): void;
	announce(text: string): void;
}

type SideMessage = Extract<ToWebview, { readonly type: 'side' }>;

interface Shown {
	readonly id: number;
	readonly question: string;
	text: string;
	state: 'asking' | 'done' | 'error';
}

let host: SideHost;
let panel: HTMLElement | undefined;
let input: HTMLTextAreaElement;
let body: HTMLElement;
let actions: HTMLElement;
let position: HTMLElement;
/** Every answer this chat got on the side, oldest first, and the one shown. */
const shown: Shown[] = [];
let at = -1;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function button(className: string, label: string, onClick: () => void, tip?: string): HTMLButtonElement {
	const node = el('button', className, label);
	node.type = 'button';
	node.addEventListener('click', onClick);
	if (tip) {
		host.setLabel(node, tip);
	}
	return node;
}

/** Takes in the host's news of a side question, opening the panel when it isn't open. */
export function onSide(message: SideMessage, from: SideHost): void {
	host = from;
	build();
	if (message.state === 'open') {
		input.focus();
		return;
	}
	let entry = shown.find(item => item.id === message.id);
	if (message.state === 'asked') {
		entry = { id: message.id, question: message.question ?? '', text: '', state: 'asking' };
		shown.push(entry);
		at = shown.length - 1;
		input.value = '';
	} else if (entry) {
		entry.text = message.text ?? entry.text;
		entry.state = message.state === 'text' ? 'asking' : message.state === 'done' ? 'done' : 'error';
		if (message.state === 'done') {
			host.announce(entry.text);
		}
	}
	if (entry && shown[at] === entry) {
		draw();
	}
}

/** Opens the panel empty, for ⌥⌘; pressed in the view. */
export function openSide(from: SideHost): void {
	host = from;
	build();
	input.focus();
}

function build(): void {
	if (panel?.isConnected) {
		return;
	}
	const text = host.strings;
	panel = el('section', 'side-chat');
	panel.setAttribute('aria-label', text.title);
	const head = el('div', 'side-chat-head');
	position = el('span', 'side-chat-position');
	const earlier = button('icon-button side-chat-step', '‹', () => step(-1), text.earlier);
	const later = button('icon-button side-chat-step', '›', () => step(1), text.later);
	const close = button('icon-button side-chat-close', '×', () => closePanel(), text.close);
	head.append(el('span', 'side-chat-title', text.title), el('span', 'side-chat-note', text.note), position, earlier, later, close);
	body = el('div', 'side-chat-body');
	body.setAttribute('aria-live', 'polite');
	actions = el('div', 'side-chat-actions');
	const form = el('form', 'side-chat-form');
	input = el('textarea', 'side-chat-input');
	input.rows = 1;
	input.placeholder = text.placeholder;
	input.setAttribute('aria-label', text.placeholder);
	const ask = el('button', 'side-chat-ask', text.ask);
	ask.type = 'submit';
	form.append(input, ask);
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (input.value.trim()) {
			host.post({ type: 'sideAsk', question: input.value.trim() });
		}
	});
	input.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			form.requestSubmit();
		}
	});
	panel.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closePanel();
		} else if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target !== input) {
			event.preventDefault();
			step(event.key === 'ArrowLeft' ? -1 : 1);
		}
	});
	panel.append(head, body, actions, form, el('div', 'side-chat-hint', text.hint));
	host.composer.before(panel);
	draw();
}

function step(by: number): void {
	const next = at + by;
	if (next >= 0 && next < shown.length) {
		at = next;
		draw();
	}
}

/** Shows the answer at `at`, with what can be done with it. */
function draw(): void {
	const text = host.strings;
	const entry = shown[at];
	position.textContent = shown.length > 1 ? `${at + 1}/${shown.length}` : '';
	body.replaceChildren();
	actions.replaceChildren();
	if (!entry) {
		body.append(el('p', 'side-chat-empty', text.empty));
		return;
	}
	body.append(el('div', 'side-chat-question', entry.question));
	const answer = el('div', `side-chat-answer markdown${entry.state === 'error' ? ' side-chat-error' : ''}`);
	if (entry.text) {
		answer.append(...entry.state === 'error' ? [document.createTextNode(entry.text)] : host.renderMarkdown(entry.text));
	} else {
		answer.append(el('span', 'side-chat-thinking', text.answering));
	}
	body.append(answer);
	if (entry.state === 'asking') {
		actions.append(button('secondary', text.stop, () => host.post({ type: 'sideCancel' })));
		return;
	}
	if (entry.state === 'done') {
		const exchange: SideExchange = { question: entry.question, answer: entry.text };
		actions.append(
			button('primary', text.sendToAgent, () => {
				host.setDraft(sideSteeringDraft(exchange));
				closePanel();
			}, text.sendToAgentTip),
			button('secondary', text.fork, () => host.post({ type: 'requestFork', message: entry.question }), text.forkTip),
			button('secondary', text.copy, () => void navigator.clipboard.writeText(entry.text).then(() => host.announce(text.copied), () => undefined)),
		);
	}
}

function closePanel(): void {
	if (shown[at]?.state === 'asking') {
		host.post({ type: 'sideCancel' });
	}
	panel?.remove();
	panel = undefined;
}

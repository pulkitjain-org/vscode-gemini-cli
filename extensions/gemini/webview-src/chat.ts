/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's webview. It renders the transcript items the extension
// sends (src/acp/chatTranscript.ts) and posts prompts back. Agent text is
// only ever set with textContent, never parsed as HTML.

import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { ChatStrings, FromWebview, ToWebview, ViewStatus } from '../src/host/chatProtocol';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const strings: ChatStrings = JSON.parse(document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.strings ?? '{}');

function byId<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

const transcript = byId<HTMLElement>('transcript');
const status = byId<HTMLElement>('status');
const form = byId<HTMLFormElement>('composer');
const input = byId<HTMLTextAreaElement>('input');
const sendButton = byId<HTMLButtonElement>('send');
const stopButton = byId<HTMLButtonElement>('stop');
const clearButton = byId<HTMLButtonElement>('clear');

input.placeholder = strings.placeholder;
sendButton.textContent = strings.send;
stopButton.textContent = strings.stop;
clearButton.textContent = strings.clear;

const elements = new Map<string, HTMLElement>();
let busy = false;

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

function render(item: TranscriptItem): HTMLElement {
	switch (item.kind) {
		case 'user':
		case 'agent':
			return el('div', `message ${item.kind}`, item.text);
		case 'thought': {
			const details = el('details', 'thought');
			details.append(el('summary', undefined, strings.thinking), el('div', 'thought-text', item.text));
			return details;
		}
		case 'toolCall': {
			const card = el('div', `tool-call status-${item.status}`);
			const header = el('div', 'tool-header');
			header.append(el('span', 'tool-title', item.title), el('span', 'tool-status', item.status.replace('_', ' ')));
			card.append(header);
			for (const location of item.locations) {
				card.append(el('div', 'tool-location', location));
			}
			for (const detail of item.details) {
				switch (detail.type) {
					case 'text':
						card.append(el('pre', 'tool-output', detail.text));
						break;
					case 'diff': {
						const diff = el('div', 'tool-diff', `${detail.path} `);
						diff.append(el('span', 'added', `+${detail.added}`), ' ', el('span', 'removed', `-${detail.removed}`));
						card.append(diff);
						break;
					}
					case 'terminal':
						card.append(el('div', 'tool-location', strings.terminal));
						break;
				}
			}
			return card;
		}
		case 'plan': {
			const plan = el('div', 'plan');
			const list = el('ul');
			for (const entry of item.entries) {
				list.append(el('li', `plan-${entry.status}`, entry.content));
			}
			plan.append(el('div', 'plan-title', strings.plan), list);
			return plan;
		}
		case 'permission':
			return renderPermission(item);
		case 'other':
			return el('div', 'notice', strings.unknownUpdate.replace('{0}', item.type));
		case 'notice':
			return el('div', `notice ${item.severity}`, item.text);
	}
}

function renderPermission(item: Extract<TranscriptItem, { kind: 'permission' }>): HTMLElement {
	const card = el('div', `permission${item.answer ? ' answered' : ''}`);
	card.append(el('div', 'permission-title', item.title));
	for (const filePath of item.diffPaths) {
		const link = el('button', 'link', strings.reviewChanges.replace('{0}', basename(filePath)));
		link.type = 'button';
		link.title = filePath;
		link.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', id: item.id, path: filePath }));
		card.append(link);
	}
	if (item.answer) {
		card.append(el('div', 'permission-answer', item.answer.kind === 'selected' ? strings.permissionAnswered.replace('{0}', item.answer.name) : strings.permissionCancelled));
		return card;
	}
	const actions = el('div', 'permission-actions');
	for (const option of item.options) {
		// Allow options are the primary action; rejections look secondary.
		const button = el('button', option.kind.startsWith('reject') ? 'secondary' : undefined, option.name);
		button.type = 'button';
		button.addEventListener('click', () => vscode.postMessage({ type: 'permission', id: item.id, optionId: option.optionId }));
		actions.append(button);
	}
	card.append(actions);
	return card;
}

function basename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() ?? filePath;
}

function upsert(item: TranscriptItem): void {
	const existing = elements.get(item.id);
	const node = render(item);
	if (existing) {
		// Keep a thought open if the user opened it while it streamed.
		if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
			node.open = existing.open;
		}
		existing.replaceWith(node);
	} else {
		transcript.querySelector('.empty')?.remove();
		transcript.append(node);
	}
	elements.set(item.id, node);
	transcript.scrollTop = transcript.scrollHeight;
}

function showEmpty(): void {
	if (!transcript.children.length) {
		transcript.append(el('div', 'empty', strings.empty));
	}
}

function setBusy(value: boolean): void {
	busy = value;
	stopButton.hidden = !value;
	sendButton.disabled = value;
	clearButton.disabled = value;
}

function setStatus(value: ViewStatus): void {
	status.textContent = value.text;
	status.className = `status ${value.phase}`;
	status.hidden = !value.text;
}

function submit(): void {
	const text = input.value;
	if (busy || !text.trim()) {
		return;
	}
	vscode.postMessage({ type: 'prompt', text });
	input.value = '';
}

form.addEventListener('submit', event => {
	event.preventDefault();
	submit();
});
input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		submit();
	}
});
stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
clearButton.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
	const message = event.data;
	switch (message.type) {
		case 'reset':
			transcript.replaceChildren();
			elements.clear();
			for (const item of message.items) {
				upsert(item);
			}
			showEmpty();
			setBusy(message.busy);
			setStatus(message.status);
			break;
		case 'item':
			upsert(message.item);
			break;
		case 'busy':
			setBusy(message.busy);
			break;
		case 'status':
			setStatus(message.status);
			break;
	}
});

vscode.postMessage({ type: 'ready' });
input.focus();

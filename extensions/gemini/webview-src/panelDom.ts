/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Element helpers for every webview: the pages (changes.ts, home.ts, settings.ts and
// the others), which don't load the chat view's modules, and the chat, whose dom.ts
// passes them on. applyTextEdit and readFileBase64 are the chat's composer's and
// Home's comment box's. Nothing runs on import.

import type { TextEdit } from './markdownEdit';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

/** A codicon, hidden from screen readers; `extra` adds classes, such as a spinner's. */
export function icon(name: string, extra = ''): HTMLElement {
	const node = el('i', `codicon codicon-${name}${extra ? ` ${extra}` : ''}`);
	node.setAttribute('aria-hidden', 'true');
	return node;
}

/** A button with an optional icon and label; an icon-only one gets `tooltip` as its name. */
export function button(className: string, label: string, onClick: () => void, iconName?: string, tooltip?: string): HTMLButtonElement {
	const node = el('button', className);
	node.type = 'button';
	if (iconName) {
		node.append(icon(iconName));
	}
	if (label) {
		node.append(el('span', undefined, label));
	}
	if (tooltip) {
		node.title = tooltip;
		node.setAttribute('aria-label', tooltip);
	}
	node.addEventListener('click', event => {
		event.stopPropagation();
		onClick();
	});
	return node;
}

/** What makes an element the same one after its page is drawn again: its `data-focus-key`, else its kind and what it says. */
function identity(node: HTMLElement): string {
	return node.dataset.focusKey ?? [node.tagName, node.getAttribute('type'), node.getAttribute('aria-label'), node.getAttribute('placeholder'), node.textContent].join('|');
}

/**
 * Runs `draw`, which draws `root` again, and puts focus back where it was:
 * on the same element if it is still there, else on the one drawn in its
 * place (the same `identity`, the same one of its kind), with a text field's
 * caret, selection and scroll, so the user types on uninterrupted. Nothing
 * else ever gets focus, so a key meant for one button never reaches another.
 */
export function keepFocus(root: HTMLElement, draw: () => void): void {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !root.contains(active)) {
		draw();
		return;
	}
	const id = identity(active);
	const twins = () => [...root.querySelectorAll<HTMLElement>(active.tagName)].filter(node => identity(node) === id);
	const nth = twins().indexOf(active);
	const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : undefined;
	const caret = field && [field.selectionStart, field.selectionEnd, field.selectionDirection, field.scrollTop] as const;
	draw();
	if (document.activeElement === active && active.isConnected) {
		return;
	}
	const next = active.isConnected ? active : twins()[nth];
	next?.focus({ preventScroll: true });
	if (caret && caret[0] !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && next.selectionStart !== null) {
		next.setSelectionRange(caret[0], caret[1], caret[2] ?? undefined);
		next.scrollTop = caret[3];
	}
}

/** The localized strings the extension put on the script tag. */
export function pageStrings<T>(): T {
	return JSON.parse(document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.strings ?? '{}');
}

export function format(template: string, ...values: (string | number)[]): string {
	return template.replace(/\{(\d+)\}/g, (match, i) => i < values.length ? String(values[Number(i)]) : match);
}

/** Applies `edit` to `input` as one step the user can undo. */
export function applyTextEdit(input: HTMLTextAreaElement, edit: TextEdit): void {
	input.setSelectionRange(edit.start, edit.end);
	// insertText keeps the textarea's undo history; setRangeText would not.
	const done = edit.text ? document.execCommand('insertText', false, edit.text) : edit.start === edit.end || document.execCommand('delete');
	if (!done) {
		input.setRangeText(edit.text, edit.start, edit.end);
		input.dispatchEvent(new Event('input'));
	}
	input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

/** A file's contents as base64, without the data URL's header. */
export function readFileBase64(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

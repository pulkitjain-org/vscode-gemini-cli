/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Element helpers for the page webviews (changes.ts, home.ts and settings.ts), which
// don't load the chat view's modules, and two the chat's composer shares with
// Home's comment box: applyTextEdit and readFileBase64. Nothing runs on import.

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

export function icon(name: string): HTMLElement {
	const node = el('i', `codicon codicon-${name}`);
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

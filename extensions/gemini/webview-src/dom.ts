/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Small helpers for building the chat view's elements.

import { strings } from './view';

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

export function icon(name: string, extra = ''): HTMLElement {
	const node = el('i', `codicon codicon-${name}${extra ? ` ${extra}` : ''}`);
	node.setAttribute('aria-hidden', 'true');
	return node;
}

export function button(className: string, label: string, onClick: () => void, iconName?: string): HTMLButtonElement {
	const node = el('button', className);
	node.type = 'button';
	if (iconName) {
		node.append(icon(iconName));
	}
	if (label) {
		node.append(el('span', undefined, label));
	}
	node.addEventListener('click', event => {
		event.stopPropagation();
		onClick();
	});
	return node;
}

/** Sets the tooltip and the accessible name together, as icon-only controls need both. */
export function setLabel(node: HTMLElement, label: string): void {
	node.title = label;
	node.setAttribute('aria-label', label);
}

/** A button that copies `text()` and briefly shows a check mark. */
export function copyButton(className: string, label: string, text: () => string): HTMLButtonElement {
	const copy = button(`icon-button ${className}`, '', () => {
		void navigator.clipboard.writeText(text()).then(() => {
			copy.replaceChildren(icon('check'));
			setLabel(copy, strings.copied);
			setTimeout(() => {
				copy.replaceChildren(icon('copy'));
				setLabel(copy, label);
			}, 1500);
		});
	}, 'copy');
	setLabel(copy, label);
	return copy;
}

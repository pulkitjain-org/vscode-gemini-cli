/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Small helpers for building the chat view's elements: the pages' own
// (panelDom.ts), and those that need the chat's strings or tooltips.

import { button, icon } from './panelDom';
import { setTip } from './tooltip';
import { strings } from './view';

export { button, el, icon } from './panelDom';
export { setTip };

/** Sets the tooltip and the accessible name together, as icon-only controls need both. */
export function setLabel(node: HTMLElement, label: string): void {
	setTip(node, label);
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

/** How long the pointer rests on something before `onIntent` takes it as a step toward clicking it. */
const intentDelayMs = 150;

/**
 * Calls `callback` once the pointer has rested on `node` for a moment, or
 * the keyboard focuses it: the user is likely to click it next. A pointer
 * that only passes over does nothing.
 */
export function onIntent(node: HTMLElement, callback: () => void): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	node.addEventListener('pointerenter', () => {
		clearTimeout(timer);
		timer = setTimeout(callback, intentDelayMs);
	});
	node.addEventListener('pointerleave', () => clearTimeout(timer));
	node.addEventListener('focus', callback);
}

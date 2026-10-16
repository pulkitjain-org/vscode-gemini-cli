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
	setTip(node, label);
	node.setAttribute('aria-label', label);
}

/**
 * Gives `node` a themed tooltip, shown on hover and keyboard focus. The
 * webview's native `title` tooltips are the system's, slow to appear and
 * unthemed, against the rule that every popup uses the app's own look.
 */
export function setTip(node: HTMLElement, tip: string): void {
	node.removeAttribute('title');
	node.dataset.tip = tip;
	if (shownFor === node && tooltip && !tooltip.hidden) {
		tooltip.textContent = tip;
	}
}

const tipDelayMs = 350;
let tooltip: HTMLElement | undefined;
/** The control whose tooltip shows, or is about to. */
let shownFor: HTMLElement | undefined;
let tipTimer: ReturnType<typeof setTimeout> | undefined;

function showTip(target: HTMLElement): void {
	const tip = target.dataset.tip;
	if (!tip || !target.isConnected) {
		return;
	}
	tooltip ??= document.body.appendChild(el('div', 'gemini-tooltip'));
	tooltip.setAttribute('role', 'tooltip');
	tooltip.textContent = tip;
	tooltip.hidden = false;
	// Above the control, or below it at the top of the view; kept inside the view.
	const box = target.getBoundingClientRect();
	const size = tooltip.getBoundingClientRect();
	const left = Math.min(Math.max(4, box.left + box.width / 2 - size.width / 2), window.innerWidth - size.width - 4);
	const top = box.top - size.height - 6 >= 4 ? box.top - size.height - 6 : box.bottom + 6;
	tooltip.style.left = `${Math.round(left)}px`;
	tooltip.style.top = `${Math.round(top)}px`;
}

function hideTip(): void {
	clearTimeout(tipTimer);
	tipTimer = undefined;
	shownFor = undefined;
	if (tooltip) {
		tooltip.hidden = true;
	}
}

function tipTarget(event: Event): HTMLElement | undefined {
	return event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') ?? undefined : undefined;
}

function scheduleTip(target: HTMLElement | undefined): void {
	if (target === shownFor) {
		return;
	}
	hideTip();
	if (target) {
		shownFor = target;
		tipTimer = setTimeout(() => showTip(target), tipDelayMs);
	}
}

// Moving the pointer, not just entering, so a tooltip hidden by scrolling or a click comes back.
document.addEventListener('pointermove', event => scheduleTip(tipTarget(event)), { passive: true });
document.documentElement.addEventListener('pointerleave', hideTip);
document.addEventListener('focusin', event => scheduleTip(event.target instanceof HTMLElement && event.target.matches(':focus-visible') ? tipTarget(event) : undefined));
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('keydown', hideTip, true);
document.addEventListener('wheel', hideTip, { capture: true, passive: true });
window.addEventListener('blur', hideTip);

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

/** Sizes the view's text, which everything else is sized from; anything but a number keeps the app's UI size. */

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

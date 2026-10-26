/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Themed tooltips for controls, for the chat (dom.ts) and Home: shown on
// hover and on keyboard focus, styled by menu.css. Importing it starts the
// listeners; a control opts in with `setTip`. While a control's tip is up, or
// about to be, the control is described by it (`aria-describedby`), as a
// native `title` would be.

/**
 * Gives `node` a themed tooltip, shown on hover and keyboard focus. The
 * webview's native `title` tooltips are the system's, slow to appear and
 * unthemed, against the rule that every popup uses the app's own look.
 */
export function setTip(node: HTMLElement, tip: string): void {
	node.removeAttribute('title');
	node.dataset.tip = tip;
	if (shownFor === node && tooltip) {
		tooltip.textContent = tip;
	}
}

const tipDelayMs = 350;
let tooltip: HTMLElement | undefined;
/** The control whose tooltip shows, or is about to. */
let shownFor: HTMLElement | undefined;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
/** The control the tooltip describes, and the description it had of its own. */
let described: { readonly node: HTMLElement; readonly own: string | null } | undefined;

function tipElement(): HTMLElement {
	if (!tooltip) {
		tooltip = document.createElement('div');
		tooltip.id = 'gemini-tooltip';
		tooltip.className = 'gemini-tooltip';
		tooltip.setAttribute('role', 'tooltip');
		// In the top layer, so it shows over a modal dialog too (Home's popups).
		tooltip.popover = 'manual';
		document.body.append(tooltip);
	}
	return tooltip;
}

/** Describes `target` by its tip from now, so a screen reader reads it with the control; not when the tip is the control's name already. */
function describe(target: HTMLElement): void {
	const tip = target.dataset.tip;
	if (!tip || tip === target.getAttribute('aria-label') || tip === target.textContent?.trim()) {
		return;
	}
	const node = tipElement();
	node.textContent = tip;
	const own = target.getAttribute('aria-describedby');
	target.setAttribute('aria-describedby', own ? `${own} ${node.id}` : node.id);
	described = { node: target, own };
}

function undescribe(): void {
	if (described) {
		const { node, own } = described;
		if (own === null) {
			node.removeAttribute('aria-describedby');
		} else {
			node.setAttribute('aria-describedby', own);
		}
		described = undefined;
	}
}

function showTip(target: HTMLElement): void {
	const tip = target.dataset.tip;
	if (!tip || !target.isConnected) {
		return;
	}
	const tooltip = tipElement();
	tooltip.textContent = tip;
	tooltip.hidden = false;
	// Shown again each time, so it stacks over a dialog opened since.
	if (tooltip.matches(':popover-open')) {
		tooltip.hidePopover();
	}
	tooltip.showPopover();
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
	undescribe();
	if (tooltip) {
		tooltip.hidden = true;
		if (tooltip.matches(':popover-open')) {
			tooltip.hidePopover();
		}
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
		describe(target);
		tipTimer = setTimeout(() => showTip(target), tipDelayMs);
	}
}

// One set of listeners per page: a chunk with its own copy of this module (Home's comment box) only sets tips, and the page's shows them.
const listening = Symbol.for('gemini.tooltip');
if (!Object.hasOwn(window, listening)) {
	Object.defineProperty(window, listening, { value: true });
	// Moving the pointer, not just entering, so a tooltip hidden by scrolling or a click comes back.
	document.addEventListener('pointermove', event => scheduleTip(tipTarget(event)), { passive: true });
	document.documentElement.addEventListener('pointerleave', hideTip);
	document.addEventListener('focusin', event => scheduleTip(event.target instanceof HTMLElement && event.target.matches(':focus-visible') ? tipTarget(event) : undefined));
	document.addEventListener('focusout', hideTip);
	document.addEventListener('pointerdown', hideTip, true);
	document.addEventListener('keydown', hideTip, true);
	document.addEventListener('wheel', hideTip, { capture: true, passive: true });
	window.addEventListener('blur', hideTip);
}

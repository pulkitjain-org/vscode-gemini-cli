/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Long chats: a thin outline of your prompts down the right edge, and keys
// (⌥⌘↑ / ⌥⌘↓ on a Mac, Ctrl+Alt+↑ / ↓ elsewhere) to jump between them.
// Layout is read only on a jump, or once a frame while the view scrolls.

import { currentPrompt, promptStep } from './chatLogic';
import { button } from './dom';
import { elements, state, strings, ui } from './view';

const { transcript, outline } = ui;
const mac = /Mac/.test(navigator.platform);
/** Below this many prompts there is nothing to navigate. */
const minPrompts = 2;

let promptIds: string[] = [];
let ticks: HTMLButtonElement[] = [];
let active = -1;
let frame = 0;

function promptTops(): number[] {
	const base = transcript.getBoundingClientRect().top - transcript.scrollTop;
	return promptIds.map(id => (elements.get(id)?.getBoundingClientRect().top ?? 0) - base);
}

/** Scrolls prompt `index` to the top of the view. */
function jumpTo(index: number): void {
	const node = elements.get(promptIds[index]);
	if (!node) {
		return;
	}
	const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
	const top = promptTops()[index] - 12;
	transcript.scrollTo({ top, behavior });
	setActive(index);
}

function setActive(index: number): void {
	if (index === active) {
		return;
	}
	ticks[active]?.classList.remove('current');
	ticks[active]?.removeAttribute('aria-current');
	active = index;
	ticks[active]?.classList.add('current');
	ticks[active]?.setAttribute('aria-current', 'true');
}

function updateActive(): void {
	frame = 0;
	if (!outline.hidden) {
		// At the bottom the newest prompt is the one being read, even when its top is still below the view's.
		const atBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 4;
		setActive(atBottom ? promptIds.length - 1 : currentPrompt(promptTops(), transcript.scrollTop));
	}
}

/** Rebuilds the outline from the prompts; called on a reset and when a prompt arrives, not for every streamed update. */
export function updateOutline(): void {
	const ids = state.items.flatMap(item => item.kind === 'user' ? [item.id] : []);
	if (ids.length === promptIds.length && ids.every((id, i) => id === promptIds[i])) {
		return;
	}
	promptIds = ids;
	active = -1;
	ticks = ids.map((id, index) => {
		const item = state.items.find(i => i.id === id);
		const text = item && item.kind === 'user' ? item.text.replace(/\s+/g, ' ').trim() : '';
		const tick = button('outline-tick', '', () => jumpTo(index));
		tick.title = text.length > 120 ? `${text.slice(0, 119)}…` : text;
		tick.setAttribute('aria-label', tick.title);
		tick.tabIndex = -1;
		return tick;
	});
	outline.replaceChildren(...ticks);
	outline.hidden = ids.length < minPrompts;
	if (!outline.hidden && !frame) {
		frame = requestAnimationFrame(updateActive);
	}
}

/** ⌥⌘↑ / ⌥⌘↓ (Ctrl+Alt elsewhere): the previous or next prompt. True if handled. */
export function onPromptNavKey(event: KeyboardEvent): boolean {
	if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !event.altKey || event.shiftKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) {
		return false;
	}
	if (promptIds.length) {
		const target = promptStep(promptTops(), transcript.scrollTop, event.key === 'ArrowDown' ? 1 : -1);
		if (target >= 0) {
			jumpTo(target);
		} else if (event.key === 'ArrowDown') {
			transcript.scrollTo({ top: transcript.scrollHeight });
		}
	}
	return true;
}

outline.setAttribute('aria-label', strings.promptOutline);
transcript.addEventListener('scroll', () => {
	if (!outline.hidden && !frame) {
		frame = requestAnimationFrame(updateActive);
	}
}, { passive: true });
window.addEventListener('keydown', event => {
	if (!event.isComposing && onPromptNavKey(event)) {
		event.preventDefault();
		event.stopPropagation();
	}
}, true);

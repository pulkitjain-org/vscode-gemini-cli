/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Reactions in the chat (src/acp/reactions.ts says what they do): the reaction
// button and chips on a reply's turn-end row, the agent's badge on a prompt,
// and the line a reaction prompt shows as. Hovering or focusing the reaction
// button shows one quick bar, shared by every reply: the four quick reactions,
// then a button for every emoji. The picker is its own chunk (emojiPicker.ts),
// loaded the first time a reaction button is hovered or focused.

import { format, type ItemOf } from './chatLogic';
import { button, el, onIntent, setLabel, setTip } from './dom';
import { heart, question, thumbsDown, thumbsUp, type ReactionRef } from '../src/acp/reactions';
import type { PickerOptions } from './emojiPicker';
import { elements, state, strings, ui, vscode } from './view';

const pickerUrl = document.querySelector<HTMLScriptElement>('script[data-strings]')?.dataset.emojiPicker;
let picker: Promise<{ openPicker(options: PickerOptions): void } | undefined> | undefined;

/** The quick reactions and their names, as the picker names them. */
const quick: readonly (readonly [string, string])[] = [[thumbsUp, 'thumbs up'], [thumbsDown, 'thumbs down'], [question, 'red question mark'], [heart, 'red heart']];

/** The quick bar, shared: it moves to the turn-end row the pointer or focus is on. */
let bar: HTMLElement | undefined;
let barTurnEnd = '';
/** The reaction button the bar is showing for, which Escape in the bar goes back to. */
let barAnchor: HTMLElement | undefined;
/** Set while Escape puts focus back on the reaction button, which would otherwise show the bar again. */
let closing = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** The reply whose reaction button had focus when it reacted: its row is drawn again with the chip, and focus goes back to it. */
let refocus: string | undefined;

function loadPicker(): NonNullable<typeof picker> {
	// Loaded on demand on purpose: most chats never open the picker, and the chat opens faster without its data.
	// eslint-disable-next-line no-restricted-syntax
	return picker ??= pickerUrl ? import(/* webpackIgnore: true */ pickerUrl).catch(() => undefined) : Promise.resolve(undefined);
}

function react(turnEnd: string, emoji: string, name: string): void {
	const active = document.activeElement;
	refocus = active instanceof HTMLElement && (active.classList.contains('reaction-add') || !!bar?.contains(active)) ? turnEnd : undefined;
	vscode.postMessage({ type: 'react', turnEnd, emoji, name });
	if (strings.reactions) {
		ui.announce.textContent = format(strings.reactions.reacted, emoji);
	}
}

/** The reaction button's icon: a smiley with a plus at its top right. */
function smiley(): SVGSVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('reaction-icon');
	for (const d of ['M13.9 7.5A6 6 0 1 1 9 2.6', 'M5.5 10.3Q8 12.6 10.5 10.3', 'M13.5 0.5V4.5M11.5 2.5H15.5']) {
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		svg.append(path);
	}
	for (const cx of ['5.9', '10.1']) {
		const eye = document.createElementNS(ns, 'circle');
		eye.setAttribute('cx', cx);
		eye.setAttribute('cy', '7');
		eye.setAttribute('r', '0.6');
		svg.append(eye);
	}
	return svg;
}

function quickBar(): HTMLElement {
	if (bar) {
		return bar;
	}
	const node = el('span', 'reaction-bar');
	node.setAttribute('role', 'toolbar');
	quick.forEach(([emoji, name], i) => {
		const option = button('reaction-quick', '', () => react(barTurnEnd, emoji, name));
		option.textContent = emoji;
		setLabel(option, strings.reactions?.quick[i] ?? name);
		node.append(option);
	});
	const more = button('reaction-more', '', () => openPicker(more, barTurnEnd));
	more.append(smiley());
	setLabel(more, strings.reactions?.more ?? '');
	node.append(el('span', 'reaction-divider'), more);
	node.addEventListener('keydown', event => onBarKey(event));
	bar = node;
	return node;
}

/** Opens the picker by `anchor` for reply `turnEnd`; the bar stays while it is open. */
function openPicker(anchor: HTMLElement, turnEnd: string): void {
	const labels = strings.reactions;
	if (!labels) {
		return;
	}
	void loadPicker().then(module => module?.openPicker({
		anchor,
		recents: state.recents,
		strings: labels,
		onPick: (emoji, name) => react(turnEnd, emoji, name),
	}));
}

/** The bar is a toolbar: the arrow keys move along it, Escape goes back to the reaction button. */
function onBarKey(event: KeyboardEvent): void {
	const options = bar ? [...bar.querySelectorAll<HTMLButtonElement>('button')] : [];
	const index = options.indexOf(document.activeElement as HTMLButtonElement);
	if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
		event.preventDefault();
		options.at((index + (event.key === 'ArrowRight' ? 1 : -1)) % options.length)?.focus();
	} else if (event.key === 'Escape' && barAnchor?.isConnected) {
		// Closes the bar: focus goes back to the reaction button without showing it again.
		event.preventDefault();
		event.stopPropagation();
		bar?.remove();
		closing = true;
		barAnchor.focus();
		closing = false;
	}
}

/** Shows the quick bar after `add`, the reaction button of reply `turnEnd`. */
function showBar(add: HTMLElement, turnEnd: string): void {
	if (closing) {
		return;
	}
	clearTimeout(hideTimer);
	const node = quickBar();
	barTurnEnd = turnEnd;
	barAnchor = add;
	if (add.nextSibling !== node) {
		add.after(node);
	}
	// The bar floats over the row (chat.css), just after the button, so showing it never moves the chat.
	node.style.left = `${add.offsetLeft + add.offsetWidth + 2}px`;
}

function hideBarSoon(): void {
	clearTimeout(hideTimer);
	hideTimer = setTimeout(() => {
		// The picker's anchor is in the bar, so the bar stays while the picker is open.
		if (bar && !bar.contains(document.activeElement) && !bar.matches(':hover') && !document.querySelector('.emoji-picker')) {
			bar.remove();
		}
	}, 300);
}

/** A reply's reactions, for its turn-end row: a chip per emoji, then the reaction button when reactions are on. */
export function replyReactions(item: ItemOf<'turnEnd'>): HTMLElement[] {
	const labels = strings.reactions;
	if (!labels) {
		return [];
	}
	const nodes = (item.reactions ?? []).map(emoji => {
		const chip = el('span', 'reaction-chip', emoji);
		chip.setAttribute('role', 'img');
		chip.setAttribute('aria-label', format(labels.chip, emoji));
		return chip;
	});
	if (!state.reactions) {
		return nodes;
	}
	// Hover and focus show the quick bar; a click (or Enter) shows it too, and moves into it.
	const add = button('turn-action reaction-add', '', () => {
		showBar(add, item.id);
		bar?.querySelector<HTMLButtonElement>('.reaction-quick')?.focus();
	});
	add.append(smiley());
	setLabel(add, labels.add);
	onIntent(add, () => void loadPicker());
	add.addEventListener('pointerenter', () => showBar(add, item.id));
	add.addEventListener('focus', () => showBar(add, item.id));
	add.addEventListener('pointerleave', hideBarSoon);
	add.addEventListener('blur', hideBarSoon);
	if (refocus === item.id) {
		refocus = undefined;
		requestAnimationFrame(() => add.focus());
	}
	nodes.push(add);
	return nodes;
}

/** Keeps the quick bar while the pointer or focus is on it. */
export function initReactionBar(): void {
	const node = quickBar();
	node.addEventListener('pointerenter', () => clearTimeout(hideTimer));
	node.addEventListener('pointerleave', hideBarSoon);
	node.addEventListener('focusout', hideBarSoon);
}

/** The agent's reaction to a prompt, as a badge on its bubble. */
export function agentBadge(emoji: string): HTMLElement {
	const badge = el('span', 'agent-reaction', emoji);
	const label = strings.reactions ? format(strings.reactions.agentReacted, emoji) : emoji;
	badge.setAttribute('role', 'img');
	badge.setAttribute('aria-label', label);
	setTip(badge, label);
	return badge;
}

/** A prompt's reactions, each as a line that shows the reply it reacted to. */
export function reactionLines(reactions: readonly ReactionRef[]): HTMLElement[] {
	const labels = strings.reactions;
	return reactions.map(({ turnEnd, emoji }) => {
		const text = labels ? format(labels.reacted, emoji) : emoji;
		if (!turnEnd) {
			return el('div', 'reaction-line', text);
		}
		const line = button('reaction-line', text, () => elements.get(turnEnd)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
		if (labels) {
			setTip(line, labels.showReply);
		}
		return line;
	});
}

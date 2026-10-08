/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The transcript: which items it shows, their elements, and keeping it
// scrolled to the latest. Layout is read at most once per batch of updates.

import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { TextAppend } from '../src/acp/textDeltas';
import { updateActivity } from './activity';
import { indexOfItem, isNearBottom as nearBottom, withAppended, type ItemOf } from './chatLogic';
import { el } from './dom';
import { render, renderEmpty, renderNotice } from './items';
import { updateOutline } from './promptNav';
import { renderStreamingReply, streamingReplies, updateStreamingReply } from './streamingReply';
import { elements, expanded, state, thoughtTimes, ui } from './view';

const { transcript, scrollButton, dock } = ui;

export function isNearBottom(): boolean {
	return nearBottom(transcript.scrollHeight, transcript.scrollTop, transcript.clientHeight);
}

function scrollToBottom(): void {
	transcript.scrollTop = transcript.scrollHeight;
}

/** Shows the jump-to-latest button while the user reads further up. */
function updateScrollButton(): void {
	const hidden = isNearBottom();
	if (scrollButton.hidden !== hidden) {
		scrollButton.hidden = hidden;
	}
}

/** A pending check of the jump-to-latest button; scrolling checks at most once a frame. */
let scrollFrame: number | undefined;

function onScroll(): void {
	scrollFrame ??= requestAnimationFrame(() => {
		scrollFrame = undefined;
		updateScrollButton();
	});
}

let dockHeight = 0;

/** When the working strip or composer grows, a transcript that was at the bottom stays there. */
function onDockResize(entries: readonly ResizeObserverEntry[]): void {
	const height = Math.ceil(entries.at(-1)?.borderBoxSize[0]?.blockSize ?? dock.offsetHeight);
	if (height === dockHeight) {
		return;
	}
	dockHeight = height;
	if (isNearBottom()) {
		scrollToBottom();
	}
}

/**
 * Scrolls to the bottom after an update if `scroll`, else shows the
 * jump-to-latest button: the view was not at the bottom, and the update
 * added below it. Uses no layout reads of its own.
 */
export function settleScroll(scroll: boolean): void {
	if (scroll) {
		scrollToBottom();
	}
	scrollButton.hidden = scroll;
}

/** Records when thought `id` ended, if it was still running. */
function endThought(id: string): void {
	const times = thoughtTimes.get(id);
	if (times && times.end === undefined) {
		times.end = Date.now();
	}
}

function trackThoughts(previous: TranscriptItem | undefined, item: TranscriptItem): void {
	if (previous?.kind === 'thought') {
		endThought(previous.id);
	}
	if (item.kind === 'thought') {
		thoughtTimes.set(item.id, { start: Date.now() });
	}
}

function renderItem(item: TranscriptItem): HTMLElement {
	return render(item, toggleToolCall);
}

/** Expands or collapses a tool call's output. */
function toggleToolCall(item: ItemOf<'toolCall'>): void {
	const opening = !expanded.delete(item.id);
	if (opening) {
		expanded.add(item.id);
	}
	upsert(item);
	if (opening) {
		elements.get(item.id)?.querySelector('.tool-body')?.classList.add('reveal');
	}
}

/** Adds or replaces one item, keeping the view scrolled to the bottom if it was there. */
function upsert(item: TranscriptItem, live = false): void {
	const stick = isNearBottom();
	settleScroll(applyItem(item, live) || stick);
}

/**
 * Adds or replaces one item without touching the scroll position, so a batch
 * of them causes one layout rather than one each. True if the view should
 * scroll to the bottom whatever its position (the user's own message).
 */
export function applyItem(item: TranscriptItem, live: boolean): boolean {
	const { items } = state;
	const index = indexOfItem(items, item.id);
	let previous: TranscriptItem | undefined;
	if (index === -1) {
		previous = items.at(-1);
		if (live) {
			trackThoughts(previous, item);
		}
		items.push(item);
	} else {
		items[index] = item;
	}
	const existing = elements.get(item.id);
	if (!existing && index !== -1 && backfill.includes(item.id)) {
		// Not shown yet: it is added, as it is now, with the other older items.
		return false;
	}
	const reply = item.kind === 'agent' && live && state.busy ? streamingReplies.get(item.id) : undefined;
	if (reply && item.kind === 'agent' && existing === reply.node && updateStreamingReply(reply, item.text)) {
		return false;
	}
	streamingReplies.delete(item.id);
	const node = item.kind === 'agent' && live && state.busy ? renderStreamingReply(item) : renderItem(item);
	if (existing) {
		replaceNode(existing, node);
	} else {
		transcript.querySelector('.empty')?.remove();
		if (live) {
			// Only new items animate in, not ones shown again or restored.
			node.classList.add('enter');
		}
		transcript.append(node);
	}
	elements.set(item.id, node);
	if (previous?.kind === 'agent' && streamingReplies.has(previous.id)) {
		// Something came after the reply, so it is done.
		streamingReplies.delete(previous.id);
		rerender(previous);
	}
	if (previous?.kind === 'thought') {
		// It is no longer the last item, so it is no longer "Thinking".
		rerender(previous);
	}
	if (item.kind === 'permission' && !item.answer) {
		node.querySelector<HTMLButtonElement>('button.primary')?.focus();
	}
	return item.kind === 'user';
}

/** The item that `update` adds text to, with that text added. */
export function appended(update: TextAppend): TranscriptItem | undefined {
	return withAppended(state.items[indexOfItem(state.items, update.id)], update);
}

function rerender(item: TranscriptItem): void {
	const existing = elements.get(item.id);
	if (existing) {
		const node = renderItem(item);
		replaceNode(existing, node);
		elements.set(item.id, node);
	}
}

/** Puts `node` in place of `existing`, keeping a thought open if the user opened it. */
function replaceNode(existing: HTMLElement, node: HTMLElement): void {
	if (existing instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
		node.open = existing.open;
	}
	existing.replaceWith(node);
}

/** Renders finished replies as a whole, which also mends anything split across blocks (a loose list). */
function finishStreamingReplies(): void {
	for (const id of [...streamingReplies.keys()]) {
		streamingReplies.delete(id);
		const item = state.items.find(i => i.id === id);
		if (item) {
			rerender(item);
		}
	}
}

/** How many of the newest items a reset shows at once; older ones follow in idle time. */
const firstItems = 30;
/** How many older items each idle slice adds. */
const backfillChunk = 20;
/** Older items a reset has not shown yet, oldest first; their elements are added above the rest. */
let backfill: string[] = [];
let backfillHandle: number | undefined;

/**
 * Shows `newItems` in place of the transcript. A long chat shows its newest
 * items at once and adds the older ones above them in idle time, newest
 * first, so it opens as fast as a short one; Markdown is the slow part.
 */
export function reset(newItems: readonly TranscriptItem[]): void {
	streamingReplies.clear();
	transcript.replaceChildren();
	elements.clear();
	cancelBackfill();
	const split = Math.max(0, newItems.length - firstItems);
	state.items = newItems.slice(0, split);
	backfill = state.items.map(item => item.id);
	// No layout reads while adding, so the shown part is laid out once.
	for (const item of newItems.slice(split)) {
		applyItem(item, false);
	}
	settleScroll(true);
	if (!state.items.length) {
		transcript.append(renderEmpty());
		expanded.clear();
		thoughtTimes.clear();
	}
	if (backfill.length) {
		backfillHandle = requestIdleCallback(addOlder, { timeout: 500 });
	}
}

function cancelBackfill(): void {
	if (backfillHandle !== undefined) {
		cancelIdleCallback(backfillHandle);
		backfillHandle = undefined;
	}
	backfill = [];
}

/** Adds the next slice of older items above the ones shown, keeping a view at the bottom there. */
function addOlder(deadline: IdleDeadline): void {
	backfillHandle = undefined;
	const stick = isNearBottom();
	while (backfill.length && (deadline.timeRemaining() > 4 || deadline.didTimeout)) {
		const ids = backfill.splice(-backfillChunk);
		const nodes = ids.flatMap(id => {
			const item = state.items[indexOfItem(state.items, id)];
			if (!item) {
				return [];
			}
			const node = renderItem(item);
			elements.set(id, node);
			return [node];
		});
		transcript.prepend(...nodes);
		if (deadline.didTimeout) {
			break;
		}
	}
	if (stick) {
		scrollToBottom();
	}
	if (backfill.length) {
		backfillHandle = requestIdleCallback(addOlder, { timeout: 500 });
	} else {
		updateOutline();
	}
}

/** Three pulsing dots after the user's message, until the agent's first reply, thought or tool call. */
const working = el('div', 'working');
working.setAttribute('aria-hidden', 'true');
working.append(el('span'), el('span'), el('span'));

export function updateWorking(): void {
	updateActivity();
	if (state.busy && state.items.at(-1)?.kind === 'user') {
		if (transcript.lastElementChild !== working) {
			transcript.append(working);
		}
	} else {
		working.remove();
	}
}

/** Shows whether the agent is working on a turn. */
export function setTranscriptBusy(value: boolean): void {
	state.busy = value;
	const last = state.items.at(-1);
	if (!value) {
		finishStreamingReplies();
		// The turn ended: a thought that was still last has ended too.
		if (last?.kind === 'thought') {
			endThought(last.id);
		}
	}
	if (last?.kind === 'thought') {
		rerender(last);
	}
	updateWorking();
}

/** Shows an error below the transcript for a few seconds. */
export function setTransientNotice(text: string): void {
	const notice = renderNotice(text, 'error');
	transcript.append(notice);
	scrollToBottom();
	setTimeout(() => notice.remove(), 6000);
}

scrollButton.addEventListener('click', () => {
	transcript.scrollTo({ top: transcript.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	ui.input.focus();
});
transcript.addEventListener('scroll', onScroll, { passive: true });
new ResizeObserver(onDockResize).observe(dock);

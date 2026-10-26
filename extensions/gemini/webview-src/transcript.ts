/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The transcript: which items it shows, their elements, and keeping it
// scrolled to the latest. Layout is read at most once per batch of updates.

import type { TranscriptItem } from '../src/acp/chatTranscript';
import type { TextAppend } from '../src/acp/textDeltas';
import type { ViewStall } from '../src/host/chatProtocol';
import { teamToolTitle } from '../src/acp/toolLinks';
import { updateActivity } from './activity';
import { format, indexOfItem, isNearBottom as nearBottom, withAppended, type ItemOf } from './chatLogic';
import { el } from './dom';
import { render, renderEmpty, renderNotice, renderStall, setToolCallOpen, updateThought } from './items';
import { updateOutline } from './promptNav';
import { renderStreamingReply, streamingReplies, updateStreamingReply } from './streamingReply';
import { autoOpened, elements, expanded, foldOpen, runOpen, state, strings, thoughtTimes, ui } from './view';
import { renderFoldHead, renderPinned, renderRunRow, type FoldState } from './work';
import { foldGroups, runId, turnLayout, turnOf, turnStarts, workSummary, type FoldGroup } from './workFold';

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

/** A new element for `item`; a reply that is still streaming is drawn so that its tail can grow. */
function draw(item: TranscriptItem, live: boolean): HTMLElement {
	return item.kind === 'agent' && live && state.busy ? renderStreamingReply(item) : renderItem(item);
}

/** Expands or collapses a tool call's output in place, so its row keeps focus, keeping the view at the bottom if it was there. */
function toggleToolCall(item: ItemOf<'toolCall'>): void {
	const opening = !expanded.delete(item.id);
	if (opening) {
		expanded.add(item.id);
	}
	const card = elements.get(item.id);
	if (card) {
		const stick = isNearBottom();
		const current = state.items[indexOfItem(state.items, item.id)];
		setToolCallOpen(card, current?.kind === 'toolCall' ? current : item, opening);
		settleScroll(stick);
	}
}

/**
 * Runs `change`, then puts focus back if it was in the transcript and the
 * change took it away: on the same element if it was only moved, else on the
 * element drawn in its place, found by `data-focus-key` (a tool call's row,
 * a fold's line, a permission's choices).
 */
function keepFocus<T>(change: () => T): T {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !transcript.contains(active)) {
		return change();
	}
	const key = active.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey;
	const result = change();
	const now = document.activeElement;
	const lost = now === active ? !active.isConnected : !now || now === document.body;
	if (lost) {
		const target = active.isConnected ? active : key ? [...transcript.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.dataset.focusKey === key) : undefined;
		target?.focus({ preventScroll: true });
	}
	return result;
}

/**
 * Adds or replaces one item without touching the scroll position, so a batch
 * of them causes one layout rather than one each. True if the view should
 * scroll to the bottom whatever its position (the user's own message).
 */
export function applyItem(item: TranscriptItem, live: boolean): boolean {
	const scroll = keepFocus(() => addOrUpdate(item, live));
	if (item.kind === 'permission') {
		markNewestCard();
	}
	return scroll;
}

function addOrUpdate(item: TranscriptItem, live: boolean): boolean {
	const { items } = state;
	const index = indexOfItem(items, item.id);
	let previous: TranscriptItem | undefined;
	if (index === -1) {
		previous = items.at(-1);
		if (live) {
			trackThoughts(previous, item);
		}
		items.push(item);
		if (item.kind === 'user') {
			starts.push(items.length - 1);
		}
	} else {
		items[index] = item;
	}
	const existing = elements.get(item.id);
	if (!existing && index !== -1 && backfill.includes(item.id)) {
		// Not shown yet: it is added, as it is now, with the other older items.
		return false;
	}
	if (live && item.kind === 'toolCall' && item.status === 'failed' && !autoOpened.has(item.id)) {
		// A step that fails while the agent works shows its output without a click, once.
		autoOpened.add(item.id);
		expanded.add(item.id);
	}
	const reply = item.kind === 'agent' && live && state.busy ? streamingReplies.get(item.id) : undefined;
	if (reply && item.kind === 'agent' && existing === reply.node && updateStreamingReply(reply, item.text)) {
		return false;
	}
	streamingReplies.delete(item.id);
	const turn = foldingTurn(index === -1 ? items.length - 1 : index);
	if (turn !== -1) {
		// In a turn that folds: where it goes is the turn's layout, which only a new item or a step's change can alter.
		if (existing) {
			refresh(existing, item, live);
		}
		if (!resetting && (index === -1 || (item.kind !== 'agent' && item.kind !== 'thought'))) {
			layoutTurn(turn, live);
		}
	} else if (existing) {
		refresh(existing, item, live);
	} else {
		const node = draw(item, live);
		transcript.querySelector('.empty')?.remove();
		if (live) {
			// Only new items animate in, not ones shown again or restored.
			node.classList.add('enter');
		}
		transcript.append(node);
		markSettled(false);
		elements.set(item.id, node);
	}
	if (previous?.kind === 'agent' && streamingReplies.has(previous.id)) {
		// Something came after the reply, so it is done.
		streamingReplies.delete(previous.id);
		rerender(previous);
	}
	if (previous?.kind === 'thought') {
		// It is no longer the last item, so it is no longer "Thinking".
		rerender(previous);
	}
	if (item.kind === 'permission' && !item.answer && live) {
		if (!announced.has(item.id)) {
			// Said whether or not focus moves: someone typing the next prompt hears that the turn waits.
			announced.add(item.id);
			ui.announce.textContent = format(strings.permissionWaiting, teamToolTitle(item.title, strings.teamToolVerbs)?.title ?? item.title);
		}
		if (!isEditing()) {
			// Never while the user types: a Space or Return meant for the composer would answer it unseen.
			elements.get(item.id)?.querySelector<HTMLButtonElement>('button.primary')?.focus();
		}
	}
	return item.kind === 'user';
}

/** Questions already announced, so an update to one is not announced again. */
const announced = new Set<string>();

/** Indexes of the prompts in `state.items`; each starts a turn. */
let starts: number[] = [];
/** While a reset adds items: each turn is laid out once, after them all. */
let resetting = false;
/** Each turn's fold, by its prompt's id. */
const folds = new Map<string, HTMLElement>();
/** Each run's element in an opened fold, by its id (workFold.ts `runId`). */
const runElements = new Map<string, HTMLElement>();
/** What a fold's line or a run's line was drawn from, so an unchanged one is kept. */
const drawn = new WeakMap<HTMLElement, string>();

/** The index of the prompt whose turn folds the item at `index`; -1 for a prompt, anything before the first, or with folding off. */
function foldingTurn(index: number): number {
	if (!state.foldWork || state.items[index]?.kind === 'user') {
		return -1;
	}
	return turnOf(starts, index);
}

/** The element for `item`, rendered if it has none yet. */
function elementFor(item: TranscriptItem, live: boolean): HTMLElement {
	let node = elements.get(item.id);
	if (!node) {
		node = draw(item, live);
		if (live) {
			node.classList.add('enter');
		}
		elements.set(item.id, node);
	}
	return node;
}

/** Forgets the element of an item that is no longer shown, so it is rendered afresh when it is. */
function forget(id: string): void {
	elements.get(id)?.remove();
	elements.delete(id);
	streamingReplies.delete(id);
}

/** Makes `parent`'s children `wanted`, in order, moving rather than re-creating them. */
function reconcile(parent: HTMLElement, wanted: readonly HTMLElement[]): void {
	let cursor: ChildNode | null = parent.firstChild;
	for (const node of wanted) {
		if (node === cursor) {
			cursor = cursor.nextSibling;
		} else {
			parent.insertBefore(node, cursor);
		}
	}
	while (cursor) {
		const next: ChildNode | null = cursor.nextSibling;
		cursor.remove();
		cursor = next;
	}
}

/**
 * Lays out the turn of the prompt at `start`: the prompt, then its fold (the
 * steps, under one line), then what shows after it (the answer, the plan,
 * notices, a waiting question, the turn's end). Elements are moved, not
 * rebuilt; a folded fold has no elements for its steps at all.
 */
function layoutTurn(start: number, live: boolean): void {
	if (state.foldWork) {
		keepFocus(() => layoutTurnNow(start, live));
	}
}

function layoutTurnNow(start: number, live: boolean): void {
	const { items } = state;
	const prompt = items[start];
	const promptNode = prompt && elements.get(prompt.id);
	if (!promptNode) {
		// Not shown yet: the older items add it, laid out, when they come.
		return;
	}
	const following = starts.find(index => index > start);
	const end = following ?? items.length;
	const { folded, after } = turnLayout(items.slice(start + 1, end));
	const running = state.busy && following === undefined;
	let fold = folds.get(prompt.id);
	if (folded.length) {
		fold ??= el('div', 'work-fold');
		folds.set(prompt.id, fold);
		fillFold(fold, prompt.id, folded, after, running, live);
	} else if (fold) {
		fold.remove();
		folds.delete(prompt.id);
		fold = undefined;
	}
	let cursor: HTMLElement = promptNode;
	const place = (node: HTMLElement) => {
		if (cursor.nextElementSibling !== node) {
			cursor.after(node);
		}
		cursor = node;
	};
	if (fold) {
		place(fold);
	}
	for (const item of after) {
		const node = elementFor(item, live);
		place(node);
		if (item.kind === 'turnEnd') {
			// The fold's line says how long it worked, so the turn's end does not say it again.
			node.classList.toggle('has-fold', !!fold);
		}
	}
	markSettled(false);
}

/** How the turn went, for its fold's line. */
function foldState(after: readonly TranscriptItem[], running: boolean): FoldState {
	if (running) {
		return { kind: 'working' };
	}
	const end = after.find((item): item is ItemOf<'turnEnd'> => item.kind === 'turnEnd');
	const failed = after.some(item => item.kind === 'notice' && item.severity === 'error');
	return { kind: failed ? 'stopped' : 'done', durationMs: end?.durationMs };
}

function fillFold(fold: HTMLElement, key: string, folded: readonly TranscriptItem[], after: readonly TranscriptItem[], running: boolean, live: boolean): void {
	// Open while the agent works, folded once it is done, unless the user said otherwise.
	const open = foldOpen.get(key) ?? running;
	const summary = workSummary(folded);
	const how = foldState(after, running);
	const steps = folded.filter(item => item.kind === 'thought' || item.kind === 'toolCall').length;
	fold.className = `work-fold${open ? ' open' : ''}${how.kind === 'stopped' ? ' stopped' : ''}`;
	// Each new step lays the turn out again; its line is rebuilt only when what it says changes, and opening or closing changes it in place.
	const headKey = JSON.stringify([how, steps, summary.counts, summary.failed.length, summary.recovered.size]);
	let head = fold.firstElementChild as HTMLElement | null;
	if (!head || drawn.get(head) !== headKey) {
		head = renderFoldHead(how, steps, summary, open, () => toggleFold(key, !fold.classList.contains('open')));
		head.dataset.focusKey = `fold:${key}`;
		drawn.set(head, headKey);
	} else {
		head.setAttribute('aria-expanded', String(open));
	}
	const parts: HTMLElement[] = [head];
	if (!open) {
		const pinned = renderPinned(summary, call => showOutput(key, call));
		if (pinned) {
			parts.push(pinned);
		}
		reconcile(fold, parts);
		for (const item of folded) {
			forget(item.id);
		}
		for (const [id, node] of runElements) {
			if (!node.isConnected) {
				runElements.delete(id);
			}
		}
		return;
	}
	const body = fold.querySelector<HTMLElement>(':scope > .work-body') ?? el('div', 'work-body');
	parts.push(body);
	reconcile(fold, parts);
	const groups = foldGroups(folded);
	reconcile(body, groups.map((group, i) => group.kind === 'item'
		? elementFor(group.item, live)
		: runElement(key, group, running && i === groups.length - 1, live)));
	markSteps(body);
}

/** How many of an open fold's last lines are always laid out (chat.css, `.settled-step`). */
const liveSteps = 4;

/** Marks an open fold's lines before its last few as settled, so they skip layout while out of view; see `markSettled`. */
function markSteps(body: HTMLElement): void {
	const children = body.children;
	for (let i = 0; i < children.length; i++) {
		children[i].classList.toggle('settled-step', i < children.length - liveSteps);
	}
}

/** A run of steps: its line and, when open, each step. The run still growing is open while the agent works. */
function runElement(key: string, group: Extract<FoldGroup, { kind: 'run' }>, current: boolean, live: boolean): HTMLElement {
	const id = runId(group);
	const open = runOpen.get(id) ?? current;
	let node = runElements.get(id);
	if (!node) {
		node = el('div', 'work-run');
		runElements.set(id, node);
	}
	node.classList.toggle('open', open);
	const run = node;
	const rowKey = group.calls.map(call => `${call.status} ${call.title} ${call.locations.map(location => location.path).join()}`).join('\n');
	let row = node.firstElementChild as HTMLElement | null;
	if (!row || drawn.get(row) !== rowKey) {
		row = renderRunRow(group, open, () => {
			runOpen.set(id, !run.classList.contains('open'));
			relayout(key);
		});
		row.dataset.focusKey = `run:${id}`;
		drawn.set(row, rowKey);
	} else {
		row.setAttribute('aria-expanded', String(open));
	}
	if (!open) {
		reconcile(node, [row]);
		for (const call of group.calls) {
			forget(call.id);
		}
		return node;
	}
	const calls = node.querySelector<HTMLElement>(':scope > .work-run-calls') ?? el('div', 'work-run-calls');
	reconcile(node, [row, calls]);
	reconcile(calls, group.calls.map(call => elementFor(call, live)));
	return node;
}

/** Lays out again the turn of the prompt `key`, after the user opened or closed part of it. */
function relayout(key: string): void {
	const start = indexOfItem(state.items, key);
	if (start !== -1) {
		layoutTurn(start, false);
		updateScrollButton();
	}
}

function toggleFold(key: string, open: boolean): void {
	foldOpen.set(key, open);
	relayout(key);
}

/** Opens the fold at a failed step, with its output showing. */
function showOutput(key: string, call: ItemOf<'toolCall'>): void {
	foldOpen.set(key, true);
	expanded.add(call.id);
	relayout(key);
	elements.get(call.id)?.scrollIntoView({ block: 'nearest' });
}

/** Turns folding on or off, and shows the transcript again that way. */
export function setFoldWork(on: boolean): void {
	if (state.foldWork !== on) {
		state.foldWork = on;
		reset(state.items.slice());
	}
}

/** Whether focus is in something the user types into. */
function isEditing(): boolean {
	const active = document.activeElement;
	return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || (active instanceof HTMLElement && active.isContentEditable);
}

/** The item that `update` adds text to, with that text added. */
export function appended(update: TextAppend): TranscriptItem | undefined {
	return withAppended(state.items[indexOfItem(state.items, update.id)], update);
}

function rerender(item: TranscriptItem): void {
	const existing = elements.get(item.id);
	if (existing) {
		keepFocus(() => refresh(existing, item, false));
	}
}

/**
 * Brings `item`'s element up to date. A thought is updated in place, so one
 * the user opened stays open and text selected in it stays selected while it
 * streams; anything else is drawn again.
 */
function refresh(existing: HTMLElement, item: TranscriptItem, live: boolean): void {
	if (item.kind === 'thought' && existing instanceof HTMLDetailsElement) {
		updateThought(existing, item);
		return;
	}
	const node = draw(item, live);
	for (const settled of ['settled', 'settled-step']) {
		if (existing.classList.contains(settled)) {
			node.classList.add(settled);
		}
	}
	existing.replaceWith(node);
	elements.set(item.id, node);
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
	folds.clear();
	runElements.clear();
	cancelBackfill();
	let split = Math.max(0, newItems.length - firstItems);
	const turn = state.foldWork ? turnOf(turnStarts(newItems), split) : -1;
	if (turn !== -1) {
		// Whole turns, so each fold is laid out with all its steps.
		split = turn;
	}
	state.items = newItems.slice(0, split);
	starts = turnStarts(state.items);
	backfill = state.items.map(item => item.id);
	// No layout reads while adding, so the shown part is laid out once.
	resetting = true;
	try {
		for (const item of newItems.slice(split)) {
			applyItem(item, false);
		}
	} finally {
		resetting = false;
	}
	for (const start of starts) {
		if (start >= split) {
			layoutTurn(start, false);
		}
	}
	markSettled(true);
	settleScroll(true);
	if (!state.items.length) {
		transcript.append(renderEmpty());
		expanded.clear();
		thoughtTimes.clear();
		foldOpen.clear();
		runOpen.clear();
		autoOpened.clear();
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
		// The backfill is the first items, in order, so an id's place in it is its index.
		let cut = Math.max(0, backfill.length - backfillChunk);
		const turn = state.foldWork ? turnOf(starts, cut) : -1;
		if (turn !== -1) {
			// Whole turns: a fold is laid out with all its steps.
			cut = turn;
		}
		const from = cut;
		const ids = backfill.splice(cut);
		const nodes = ids.flatMap((id, i) => {
			const item = state.items[from + i];
			if (!item || foldingTurn(from + i) !== -1) {
				// A turn's steps and answer go where its layout puts them, below.
				return [];
			}
			const node = renderItem(item);
			elements.set(id, node);
			return [node];
		});
		transcript.prepend(...nodes);
		for (const start of starts) {
			if (start >= from && start < from + ids.length) {
				layoutTurn(start, false);
			}
		}
		markSettled(true);
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

/** How many of the latest elements are always laid out (chat.css, `.settled`). */
const liveElements = 30;

/**
 * Marks the elements older than the latest few as settled, so they skip
 * layout while out of view. A class rather than `:nth-last-child`, which
 * would make every append restyle the whole transcript. `all` checks every
 * element, after older ones were added at the top; otherwise it stops at
 * the first one already marked.
 */
function markSettled(all: boolean): void {
	const children = transcript.children;
	for (let i = children.length - liveElements - 1; i >= 0; i--) {
		const child = children[i];
		if (child.classList.contains('settled')) {
			if (!all) {
				return;
			}
			continue;
		}
		child.classList.add('settled');
	}
}

/** Three pulsing dots after the user's message, until the agent's first reply, thought or tool call. */
const working = el('div', 'working');
working.setAttribute('aria-hidden', 'true');
working.append(el('span'), el('span'), el('span'));

/** The stall notice (M2), last in the running turn while the agent has said nothing for a while. */
let stallNotice: HTMLElement | undefined;

export function updateWorking(): void {
	updateActivity();
	if (state.busy && state.items.at(-1)?.kind === 'user') {
		if (transcript.lastElementChild !== working && transcript.lastElementChild?.previousElementSibling !== working) {
			transcript.append(working);
		}
	} else {
		working.remove();
	}
	if (stallNotice && transcript.lastElementChild !== stallNotice) {
		transcript.append(stallNotice);
	}
}

/** Shows the stall notice at the end of the running turn, or takes it away (`undefined`) once anything arrives. */
export function setStall(stall: ViewStall | undefined): void {
	const stick = isNearBottom();
	stallNotice?.remove();
	stallNotice = stall && state.busy ? renderStall(stall) : undefined;
	if (stallNotice) {
		transcript.append(stallNotice);
		settleScroll(stick);
	}
}

/**
 * Marks the newest card waiting for an answer, the one the chat box's keys
 * answer, so only it shows them (chat.css, `.permission.newest`). Run when a
 * card is added or answered, not on every update.
 */
function markNewestCard(): void {
	const waiting = transcript.querySelectorAll('.permission.waiting');
	waiting.forEach((card, index) => card.classList.toggle('newest', index === waiting.length - 1));
}

/** Shows whether the agent is working on a turn. */
export function setTranscriptBusy(value: boolean): void {
	state.busy = value;
	// A tool call or plan step stopped mid-turn stays "in progress": its spinner stops with the turn (chat.css).
	transcript.classList.toggle('turn-running', value);
	const last = state.items.at(-1);
	if (!value) {
		setStall(undefined);
		finishStreamingReplies();
		// The turn ended: a thought that was still last has ended too.
		if (last?.kind === 'thought') {
			endThought(last.id);
		}
	}
	if (last?.kind === 'thought') {
		rerender(last);
	}
	const lastTurn = starts.at(-1);
	if (state.foldWork && lastTurn !== undefined) {
		// A turn's fold opens while it works and folds when it is done.
		layoutTurn(lastTurn, false);
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

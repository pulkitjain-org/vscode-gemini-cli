/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The transcript's older part as blocks that are drawn only near the view.
// A block (a turn when work folds, else one item) that is out of view stands
// as a slot: an empty element of the block's measured height, or an estimate
// until it has been drawn once. A slot that comes within `nearMargin` of the
// view is drawn in its place; a drawn block whose every element has left
// `farMargin` goes back to a slot. The transcript (transcript.ts) draws and
// takes out the items; this module only decides when, and keeps the heights.
// The browser's scroll anchoring keeps what is in view still while a block
// above it changes height, including during a smooth scroll to a prompt.

import { isNearBottom } from './chatLogic';

/** How the transcript draws a block and takes it out again. */
export interface BlockHost {
	/** The scrolling element the blocks are in. */
	readonly root: HTMLElement;
	/** Draws the block starting at item `from` in place of `slot`. */
	render(from: number, slot: HTMLElement): void;
	/** Forgets the elements of the block starting at `from`; `slot` is already in their place. */
	unrender(from: number, slot: HTMLElement): void;
	/** The drawn block's elements in `root`, in order; none if it is not drawn. */
	nodes(from: number): HTMLElement[];
}

/** The class of a slot, for the transcript to tell one from an item's element. */
export const slotClass = 'turn-slot';

/** How far beyond the view, in CSS pixels, a slot is drawn, and a drawn block kept. */
const nearMargin = 1200;
const farMargin = 3000;
/** The height a block is given before it has been drawn, per element it is expected to have. */
const estimatedHeight = 80;

export function isSlot(node: Element | undefined): boolean {
	return !!node && node.classList.contains(slotClass);
}

export class VirtualBlocks {
	/** Each block that stands as a slot, by its first item's index. */
	private readonly slots = new Map<number, HTMLElement>();
	/** Each block's height when it was last taken out, by its first item's index. */
	private readonly heights = new Map<number, number>();
	/** The block each watched element (a slot, or a drawn block's element) belongs to. */
	private readonly blockOf = new WeakMap<Element, number>();
	/** Of each drawn block, the elements within `farMargin` of the view, as the observer last said. */
	private readonly inView = new Map<number, Set<Element>>();
	private readonly near: IntersectionObserver | undefined;
	private readonly far: IntersectionObserver | undefined;

	constructor(private readonly host: BlockHost) {
		if (typeof IntersectionObserver !== 'undefined') {
			this.near = new IntersectionObserver(entries => this.onNear(entries), { root: host.root, rootMargin: `${nearMargin}px 0px` });
			this.far = new IntersectionObserver(entries => this.onFar(entries), { root: host.root, rootMargin: `${farMargin}px 0px` });
		}
	}

	/** Forgets every block, as before the transcript is drawn again. */
	clear(): void {
		this.near?.disconnect();
		this.far?.disconnect();
		this.slots.clear();
		this.heights.clear();
		this.inView.clear();
	}

	/**
	 * A slot for each block, in order, for the transcript to put in: `from`
	 * is the block's first item, `elements` how many elements it is expected
	 * to draw, for its height until it has been.
	 */
	slotsFor(blocks: readonly { readonly from: number; readonly elements: number }[]): HTMLElement[] {
		return blocks.map(({ from, elements }) => this.slot(from, elements * estimatedHeight));
	}

	/** Whether the block starting at `from` stands as a slot. */
	isSlotted(from: number): boolean {
		return this.slots.has(from);
	}

	/** Blocks drawn until now, no longer among the latest: taken out once they are far from the view. */
	release(froms: readonly number[]): void {
		for (const from of froms) {
			this.watch(from);
		}
	}

	/** An element of a drawn block was drawn again: the new one is watched in its place. */
	replaced(old: HTMLElement, node: HTMLElement): void {
		const from = this.blockOf.get(old);
		if (from === undefined || this.slots.has(from)) {
			return;
		}
		this.far?.unobserve(old);
		const seen = this.inView.get(from);
		if (seen?.delete(old)) {
			seen.add(node);
		}
		this.blockOf.set(node, from);
		this.far?.observe(node);
	}

	private slot(from: number, estimate: number): HTMLElement {
		const slot = document.createElement('div');
		slot.className = slotClass;
		slot.setAttribute('aria-hidden', 'true');
		slot.style.height = `${Math.round(this.heights.get(from) ?? estimate)}px`;
		this.slots.set(from, slot);
		this.blockOf.set(slot, from);
		this.near?.observe(slot);
		return slot;
	}

	private watch(from: number): void {
		const nodes = this.host.nodes(from);
		this.inView.set(from, new Set(nodes));
		for (const node of nodes) {
			this.blockOf.set(node, from);
			this.far?.observe(node);
		}
	}

	private onNear(entries: readonly IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			const from = this.blockOf.get(entry.target);
			if (entry.isIntersecting && from !== undefined && this.slots.get(from) === entry.target) {
				this.draw(from, entry.target as HTMLElement);
			}
		}
	}

	private draw(from: number, slot: HTMLElement): void {
		const { root } = this.host;
		const stick = isNearBottom(root.scrollHeight, root.scrollTop, root.clientHeight);
		this.near?.unobserve(slot);
		this.slots.delete(from);
		this.host.render(from, slot);
		this.watch(from);
		if (stick) {
			root.scrollTop = root.scrollHeight;
		}
	}

	private onFar(entries: readonly IntersectionObserverEntry[]): void {
		const changed = new Set<number>();
		for (const entry of entries) {
			const from = this.blockOf.get(entry.target);
			const seen = from === undefined ? undefined : this.inView.get(from);
			if (from === undefined || !seen) {
				continue;
			}
			if (entry.isIntersecting) {
				seen.add(entry.target);
			} else {
				seen.delete(entry.target);
				changed.add(from);
			}
		}
		for (const from of changed) {
			const seen = this.inView.get(from);
			if (seen && [...seen].every(node => !node.isConnected)) {
				this.takeOut(from);
			}
		}
	}

	/** Puts a slot of the block's measured height in its place, unless the user's focus or selection is in it. */
	private takeOut(from: number): void {
		const nodes = this.host.nodes(from);
		if (!nodes.length || nodes.some(node => node.contains(document.activeElement) || selectedIn(node))) {
			return;
		}
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		const next = last.nextElementSibling;
		const height = (next ? next.getBoundingClientRect().top : last.getBoundingClientRect().bottom) - first.getBoundingClientRect().top;
		if (height > 0) {
			this.heights.set(from, height);
		}
		for (const node of nodes) {
			this.far?.unobserve(node);
		}
		this.inView.delete(from);
		const slot = this.slot(from, nodes.length * estimatedHeight);
		first.before(slot);
		this.host.unrender(from, slot);
		for (const node of nodes) {
			node.remove();
		}
	}
}

/** Whether the user has text selected in `node`. */
function selectedIn(node: HTMLElement): boolean {
	const selection = document.getSelection();
	return !!selection && !selection.isCollapsed && selection.containsNode(node, true);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The emoji picker: a search box, a strip of categories, the Recent row and a
// grid of every emoji the system can draw. Its own chunk (media/emojiPicker.js),
// loaded by reactionBar.ts the first time a reaction button is hovered or
// focused, so the chat's startup script carries none of its data. It shares no
// module state with the chat's script: everything it needs comes in
// `openPicker`'s options.

import type { ReactionStrings } from '../src/host/chatProtocol';
import data from './emojiData.json';
import { buildIndex, moveInGrid, recentEmoji, searchEmoji, type EmojiEntry, type GridPosition, type IndexedEmoji } from './emojiSearch';

export interface PickerOptions {
	/** The reaction button: the picker opens beside it, and focus goes back to it. */
	readonly anchor: HTMLElement;
	readonly recents: readonly string[];
	/** Every emoji with a meaning, and what it asks for: shown first, and in the footer. */
	readonly meanings: readonly (readonly [string, string])[];
	readonly strings: ReactionStrings;
	onPick(emoji: string, name: string): void;
}

const columns = 8;
const width = 324;
/** Each category's emoji in the category strip, in emojiData.json's order. */
const categoryIcons = ['\u{1F600}', '\u{1F9D1}', '\u{1F436}', '\u{1F34E}', '\u{2708}\u{FE0F}', '\u{26BD}', '\u{1F4A1}', '\u{1F523}', '\u{1F3F3}\u{FE0F}'];
const recentIcon = '\u{1F558}';
const meaningIcon = '\u{2B50}';

interface Section {
	readonly title: string;
	readonly entries: readonly IndexedEmoji[];
}

/** emojiData.json's lists, typed: its JSON type cannot say each entry has four parts. */
const groups = data.groups as unknown as readonly (readonly EmojiEntry[])[];
let index: IndexedEmoji[] | undefined;
let current: Picker | undefined;

/** Opens the picker by `options.anchor`, closing one already open. */
export function openPicker(options: PickerOptions): void {
	current?.close(false);
	index ??= buildIndex(groups, drawableVersion());
	current = new Picker(options, index);
}

/**
 * The newest emoji version the system's emoji font draws, so the picker skips
 * emoji that would show as empty boxes: one emoji of each version from 12 on
 * is drawn on a canvas, newest first, until one comes out in colour.
 */
function drawableVersion(): number {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 24;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) {
		return Infinity;
	}
	const samples = new Map<number, string>();
	for (const [emoji, , , version] of groups.flat()) {
		if (version >= 12 && !samples.has(version)) {
			samples.set(version, emoji);
		}
	}
	context.font = '20px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
	context.textBaseline = 'top';
	for (const version of [...samples.keys()].sort((a, b) => b - a)) {
		context.clearRect(0, 0, 24, 24);
		context.fillText(samples.get(version)!, 0, 0);
		const pixels = context.getImageData(0, 0, 24, 24).data;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i + 3] && (pixels[i] !== pixels[i + 1] || pixels[i + 1] !== pixels[i + 2])) {
				return version;
			}
		}
	}
	return 11;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

class Picker {
	private readonly root = el('div', 'emoji-picker');
	private readonly search = el('input', 'emoji-search');
	private readonly body = el('div', 'emoji-body');
	private readonly footerEmoji = el('span', 'emoji-footer-emoji');
	private readonly footerName = el('span', 'emoji-footer-name');
	private readonly footerMeaning = el('span', 'emoji-footer-meaning');
	private readonly meaningOf: ReadonlyMap<string, string>;
	private sections: readonly Section[] = [];
	/** Each shown section's cells, filled in as the section is drawn. */
	private cells: HTMLButtonElement[][] = [];
	private readonly drawn = new Set<number>();
	private active: GridPosition = { section: 0, cell: 0 };
	private readonly defaultSections: readonly Section[];
	private drawing: number | undefined;
	private readonly onOutside = (event: PointerEvent) => {
		const target = event.target;
		if (target instanceof Node && !this.root.contains(target) && !this.options.anchor.contains(target)) {
			this.close(false);
		}
	};

	constructor(private readonly options: PickerOptions, private readonly emoji: readonly IndexedEmoji[]) {
		const { strings } = options;
		this.root.setAttribute('role', 'dialog');
		this.root.setAttribute('aria-label', strings.picker);
		this.root.setAttribute('popover', 'manual');
		this.search.type = 'search';
		this.search.placeholder = strings.search;
		this.search.setAttribute('aria-label', strings.search);
		this.search.spellcheck = false;

		const recent = recentEmoji(emoji, options.recents);
		const meant = recentEmoji(emoji, options.meanings.map(([e]) => e));
		this.meaningOf = new Map(options.meanings.map(([e, meaning]) => [e.replace(/\u{FE0F}/gu, ''), meaning]));
		this.defaultSections = [
			{ title: strings.withMeaning, entries: meant },
			{ title: strings.recent, entries: recent },
			...strings.groups.map((title, group) => ({ title, entries: emoji.filter(entry => entry.group === group) })),
		];
		const tabs = el('div', 'emoji-tabs');
		[meaningIcon, recentIcon, ...categoryIcons].forEach((glyph, section) => {
			const tab = el('button', 'emoji-tab', glyph);
			tab.type = 'button';
			tab.tabIndex = -1;
			tab.setAttribute('aria-label', this.defaultSections[section]?.title ?? '');
			tab.addEventListener('click', () => this.showSection(section));
			tab.hidden = (section === 0 && !meant.length) || (section === 1 && !recent.length);
			tabs.append(tab);
		});
		const footer = el('div', 'emoji-footer');
		const names = el('span', 'emoji-footer-names');
		names.append(this.footerName, this.footerMeaning);
		footer.append(this.footerEmoji, names);
		this.root.append(this.search, tabs, this.body, footer);

		this.search.addEventListener('input', () => this.filter());
		this.search.addEventListener('keydown', event => this.onSearchKey(event));
		this.body.addEventListener('click', event => {
			const cell = this.cellOf(event.target);
			if (cell) {
				this.pick(cell);
			}
		});
		this.body.addEventListener('pointerover', event => {
			const cell = this.cellOf(event.target);
			if (cell) {
				this.showName(cell);
			}
		});
		this.body.addEventListener('keydown', event => this.onGridKey(event));
		this.root.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.close(true);
			}
		});
		this.root.addEventListener('focusout', event => {
			const next = event.relatedTarget;
			if (next instanceof Node && !this.root.contains(next)) {
				this.close(false);
			}
		});

		document.body.append(this.root);
		this.root.showPopover();
		this.show(this.defaultSections);
		this.place();
		document.addEventListener('pointerdown', this.onOutside, true);
		this.search.focus();
	}

	/** Takes the picker away; `returnFocus` puts focus back on the reaction button. */
	close(returnFocus: boolean): void {
		if (current === this) {
			current = undefined;
		}
		if (this.drawing !== undefined) {
			cancelIdleCallback(this.drawing);
		}
		document.removeEventListener('pointerdown', this.onOutside, true);
		this.root.remove();
		if (returnFocus && this.options.anchor.isConnected) {
			this.options.anchor.focus();
		}
	}

	/** Above the button when there is room, else below; kept inside the view. */
	private place(): void {
		const anchor = this.options.anchor.getBoundingClientRect();
		const height = this.root.offsetHeight;
		const above = anchor.top - height - 6;
		const top = above >= 8 || anchor.bottom + height + 6 > innerHeight ? Math.max(8, above) : anchor.bottom + 6;
		const left = Math.min(Math.max(8, anchor.right - width), innerWidth - width - 8);
		this.root.style.top = `${top}px`;
		this.root.style.left = `${Math.max(8, left)}px`;
	}

	private filter(): void {
		const query = this.search.value.trim();
		this.show(query ? [{ title: '', entries: searchEmoji(this.emoji, query) }] : this.defaultSections);
	}

	/**
	 * Draws `sections`: those near the top at once, the rest when the view is
	 * idle, so opening the picker never waits for all of its emoji.
	 */
	private show(sections: readonly Section[]): void {
		if (this.drawing !== undefined) {
			cancelIdleCallback(this.drawing);
			this.drawing = undefined;
		}
		this.sections = sections;
		this.cells = sections.map(() => []);
		this.drawn.clear();
		this.body.replaceChildren();
		this.body.scrollTop = 0;
		const first = sections.findIndex(section => section.entries.length);
		this.active = { section: Math.max(0, first), cell: 0 };
		if (first < 0) {
			this.body.append(el('div', 'emoji-empty', this.options.strings.noResults));
			this.showName(undefined);
			return;
		}
		this.drawUpTo(first + 1);
		const drawRest = () => {
			const next = sections.findIndex((_, section) => !this.drawn.has(section));
			if (next >= 0) {
				this.drawUpTo(next);
				this.drawing = requestIdleCallback(drawRest);
			} else {
				this.drawing = undefined;
			}
		};
		this.drawing = requestIdleCallback(drawRest);
		this.showName(this.cells[this.active.section]?.[0]);
	}

	/** Draws every section up to `section` not drawn yet, in order, so the grid's order stays the sections'. */
	private drawUpTo(section: number): void {
		for (let s = 0; s <= Math.min(section, this.sections.length - 1); s++) {
			if (!this.drawn.has(s)) {
				this.drawn.add(s);
				this.drawSection(s);
			}
		}
	}

	private drawSection(section: number): void {
		const { title, entries } = this.sections[section];
		if (!entries.length) {
			return;
		}
		const block = el('section', 'emoji-section');
		block.dataset.section = String(section);
		if (title) {
			block.append(el('div', 'emoji-section-title', title));
		}
		const grid = el('div', 'emoji-grid');
		grid.setAttribute('role', 'grid');
		grid.setAttribute('aria-label', title || this.options.strings.picker);
		const cells = this.cells[section];
		let row: HTMLElement | undefined;
		entries.forEach((entry, i) => {
			if (i % columns === 0) {
				row = el('div', 'emoji-row');
				row.setAttribute('role', 'row');
				grid.append(row);
			}
			const cell = el('button', 'emoji-cell', entry.emoji);
			cell.type = 'button';
			cell.setAttribute('role', 'gridcell');
			cell.setAttribute('aria-label', entry.name);
			cell.dataset.section = String(section);
			cell.dataset.cell = String(i);
			cell.tabIndex = section === this.active.section && i === this.active.cell ? 0 : -1;
			cells.push(cell);
			row!.append(cell);
		});
		block.append(grid);
		this.body.append(block);
	}

	/** A category in the strip: draws it and the ones before it if not yet drawn, and scrolls to it. */
	private showSection(section: number): void {
		if (this.search.value) {
			this.search.value = '';
			this.show(this.defaultSections);
		}
		this.drawUpTo(section);
		this.body.querySelector(`section[data-section="${section}"]`)?.scrollIntoView({ block: 'start' });
	}

	private cellOf(target: EventTarget | null): HTMLButtonElement | undefined {
		return target instanceof HTMLButtonElement && target.classList.contains('emoji-cell') ? target : undefined;
	}

	private entryOf(cell: HTMLButtonElement): IndexedEmoji | undefined {
		return this.sections[Number(cell.dataset.section)]?.entries[Number(cell.dataset.cell)];
	}

	private showName(cell: HTMLButtonElement | undefined): void {
		const entry = cell && this.entryOf(cell);
		this.footerEmoji.textContent = entry?.emoji ?? '';
		this.footerName.textContent = entry?.name ?? '';
		// What picking it asks Gemini to do, before it is picked.
		this.footerMeaning.textContent = entry ? this.meaningOf.get(entry.emoji.replace(/\u{FE0F}/gu, '')) ?? this.options.strings.readsIt : '';
	}

	private pick(cell: HTMLButtonElement): void {
		const entry = this.entryOf(cell);
		if (entry) {
			this.close(true);
			this.options.onPick(entry.emoji, entry.name);
		}
	}

	private focusCell(at: GridPosition): void {
		this.drawUpTo(at.section);
		const cell = this.cells[at.section]?.[at.cell];
		if (!cell) {
			return;
		}
		this.cells[this.active.section]?.[this.active.cell]?.setAttribute('tabindex', '-1');
		this.active = at;
		cell.tabIndex = 0;
		cell.focus();
		this.showName(cell);
	}

	private onSearchKey(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			this.focusCell(this.active);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const cell = this.cells[this.active.section]?.[this.active.cell];
			if (cell) {
				this.pick(cell);
			}
		}
	}

	private onGridKey(event: KeyboardEvent): void {
		const cell = this.cellOf(event.target);
		if (!cell) {
			return;
		}
		if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
			// Typing in the grid searches.
			event.preventDefault();
			this.search.focus();
			this.search.value += event.key;
			this.filter();
			return;
		}
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		const sizes = this.sections.map(section => section.entries.length);
		const at = { section: Number(cell.dataset.section), cell: Number(cell.dataset.cell) };
		const next = moveInGrid(sizes, columns, at, event.key);
		if (next) {
			this.focusCell(next);
		} else {
			this.search.focus();
		}
	}
}

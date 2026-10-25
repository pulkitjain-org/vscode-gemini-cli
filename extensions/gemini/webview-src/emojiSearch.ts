/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The emoji picker's logic, kept free of the DOM so it is tested on its own:
// the search index, how arrow keys move through the picker's sections, and
// the Recent row.

/** One emoji as webview-src/emojiData.json has it: the emoji, its name, a few search words, its emoji version. */
export type EmojiEntry = readonly [emoji: string, name: string, words: string, version: number];

export interface IndexedEmoji {
	readonly emoji: string;
	readonly name: string;
	/** Its category, as an index into the picker's categories. */
	readonly group: number;
	/** The name's words and the search words, lowercased, for matching. */
	readonly nameWords: readonly string[];
	readonly words: readonly string[];
}

/** Every emoji the system can draw (`maxVersion`), in the picker's order. */
export function buildIndex(groups: readonly (readonly EmojiEntry[])[], maxVersion: number): IndexedEmoji[] {
	return groups.flatMap((entries, group) => entries
		.filter(([, , , version]) => version <= maxVersion)
		.map(([emoji, name, words]) => ({
			emoji,
			name,
			group,
			nameWords: name.toLowerCase().split(/[\s:,]+/).filter(Boolean),
			words: words.toLowerCase().split(/\s+/).filter(Boolean),
		})));
}

/**
 * The emoji matching `query`, best first: every word typed must start a word
 * of the name or of the search words. A name that is the query comes first,
 * then names that start with it, then other name matches, then search words.
 */
export function searchEmoji(index: readonly IndexedEmoji[], query: string): IndexedEmoji[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) {
		return [];
	}
	const whole = terms.join(' ');
	const ranked: { readonly entry: IndexedEmoji; readonly rank: number }[] = [];
	for (const entry of index) {
		let inName = true;
		let found = true;
		for (const term of terms) {
			if (entry.nameWords.some(word => word.startsWith(term))) {
				continue;
			}
			inName = false;
			if (!entry.words.some(word => word.startsWith(term))) {
				found = false;
				break;
			}
		}
		if (!found) {
			continue;
		}
		const name = entry.name.toLowerCase();
		const rank = name === whole ? 0 : name.startsWith(whole) ? 1 : inName ? 2 : 3;
		ranked.push({ entry, rank });
	}
	// Array.prototype.sort is stable, so equal ranks keep the picker's order.
	return ranked.sort((a, b) => a.rank - b.rank).map(match => match.entry);
}

/** Where focus is among the picker's sections: a section and a cell in it. */
export interface GridPosition {
	readonly section: number;
	readonly cell: number;
}

/**
 * Where an arrow key, Home or End moves focus in sections of `sizes` cells
 * laid out `columns` to a row. Up and down cross into the section above or
 * below, keeping the column as far as that row allows; left and right run on
 * through the sections. Undefined when the key leaves the grid upward, so
 * focus can go back to the search box.
 */
export function moveInGrid(sizes: readonly number[], columns: number, at: GridPosition, key: string): GridPosition | undefined {
	const rowsOf = (section: number) => Math.ceil(sizes[section] / columns);
	const column = at.cell % columns;
	const row = Math.floor(at.cell / columns);
	const next = (section: number, step: 1 | -1): number | undefined => {
		for (let s = section + step; s >= 0 && s < sizes.length; s += step) {
			if (sizes[s]) {
				return s;
			}
		}
		return undefined;
	};
	switch (key) {
		case 'ArrowRight': {
			if (at.cell + 1 < sizes[at.section]) {
				return { section: at.section, cell: at.cell + 1 };
			}
			const section = next(at.section, 1);
			return section === undefined ? at : { section, cell: 0 };
		}
		case 'ArrowLeft': {
			if (at.cell > 0) {
				return { section: at.section, cell: at.cell - 1 };
			}
			const section = next(at.section, -1);
			return section === undefined ? at : { section, cell: sizes[section] - 1 };
		}
		case 'ArrowDown': {
			if (row + 1 < rowsOf(at.section)) {
				return { section: at.section, cell: Math.min(at.cell + columns, sizes[at.section] - 1) };
			}
			const section = next(at.section, 1);
			return section === undefined ? at : { section, cell: Math.min(column, sizes[section] - 1) };
		}
		case 'ArrowUp': {
			if (row > 0) {
				return { section: at.section, cell: at.cell - columns };
			}
			const section = next(at.section, -1);
			if (section === undefined) {
				return undefined;
			}
			const lastRow = rowsOf(section) - 1;
			return { section, cell: Math.min(lastRow * columns + column, sizes[section] - 1) };
		}
		case 'Home':
			return { section: at.section, cell: row * columns };
		case 'End':
			return { section: at.section, cell: Math.min(row * columns + columns, sizes[at.section]) - 1 };
		default:
			return at;
	}
}

/** The Recent row: the emoji used last that the index has, newest first. */
export function recentEmoji(index: readonly IndexedEmoji[], recents: readonly string[]): IndexedEmoji[] {
	const byEmoji = new Map(index.map(entry => [plain(entry.emoji), entry]));
	return recents.map(emoji => byEmoji.get(plain(emoji))).filter((entry): entry is IndexedEmoji => !!entry);
}

/** An emoji without variation selectors, so one stored either way is found. */
function plain(emoji: string): string {
	return emoji.replace(/\u{FE0F}/gu, '');
}

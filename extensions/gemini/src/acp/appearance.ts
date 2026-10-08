/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The choices on the Make It Yours page, and how an accent becomes colour
// customizations. No editor API here, so it can be tested.

export const themeIds = ['GeminiCode Dark', 'GeminiCode Midnight', 'GeminiCode Dusk', 'GeminiCode Light'] as const;

export const accentIds = ['theme', 'blue', 'violet', 'rose', 'teal', 'amber', 'gradient'] as const;
export type AccentId = typeof accentIds[number];

export interface CodeFont {
	readonly id: string;
	readonly label: string;
	/** The `editor.fontFamily` it sets. */
	readonly family: string;
}

/** Fonts the page offers. JetBrains Mono and Geist Mono ship with GeminiCode; SF Mono is the Mac's own. */
export const codeFonts: readonly CodeFont[] = [
	{ id: 'jetbrains', label: 'JetBrains Mono', family: `'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace` },
	{ id: 'geist', label: 'Geist Mono', family: `'Geist Mono', Menlo, Monaco, 'Courier New', monospace` },
	{ id: 'sf', label: 'SF Mono', family: `ui-monospace, 'SF Mono', Menlo, Monaco, 'Courier New', monospace` },
	{ id: 'menlo', label: 'Menlo', family: `Menlo, Monaco, 'Courier New', monospace` },
];

/** The font whose family `family` is, if it is one of ours. */
export function codeFontOf(family: string | undefined): CodeFont | undefined {
	const normalize = (f: string) => f.replace(/\s+/g, ' ').trim();
	return codeFonts.find(font => normalize(font.family) === normalize(family ?? ''));
}

export interface AccentTable {
	/** Accent id to its colour on dark themes and on light ones. */
	readonly accents: Record<string, readonly [string, string]>;
	/** Theme name to the colour keys that carry its accent, with the alpha each adds. */
	readonly themes: Record<string, { readonly kind: 'dark' | 'light'; readonly keys: Record<string, string> }>;
}

type Customizations = Record<string, unknown>;

/**
 * `workbench.colorCustomizations` with `accent` applied to the GeminiCode
 * theme in use, or undefined when it already is. Only the accent keys inside
 * the `[GeminiCode …]` blocks change; anything else the user set is kept. The
 * other themes, and the theme's own accent ("theme"), get those keys removed,
 * so settings.json holds one theme's worth of them.
 */
export function withAccent(current: Customizations | undefined, accent: AccentId, activeTheme: string, table: AccentTable): Customizations | undefined {
	const next: Customizations = { ...current };
	let changed = false;
	for (const [theme, { kind, keys }] of Object.entries(table.themes)) {
		const colors = accent === 'theme' || theme !== activeTheme ? undefined : table.accents[accent];
		const blockKey = `[${theme}]`;
		const existing = next[blockKey];
		const block: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
		for (const [key, alpha] of Object.entries(keys)) {
			const value = colors ? `${colors[kind === 'light' ? 1 : 0]}${alpha}` : undefined;
			if (block[key] !== value) {
				if (value === undefined) {
					delete block[key];
				} else {
					block[key] = value;
				}
				changed = true;
			}
		}
		if (Object.keys(block).length) {
			next[blockKey] = block;
		} else if (next[blockKey] !== undefined) {
			delete next[blockKey];
			changed = true;
		}
	}
	return changed ? next : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

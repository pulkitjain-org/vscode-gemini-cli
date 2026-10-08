/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Makes the Midnight and Dusk themes from GeminiCode Dark, and the accent
// colour sets the Make It Yours page applies, so they never drift from the
// themes they are based on. Edit GeminiCode Dark or Light, then run:
//
//   node extensions/gemini/scripts/build-themes.mts
//
// A unit test fails when the files in themes/ differ from what this makes.

import * as fs from 'node:fs';
import * as path from 'node:path';

const themesDir = path.join(path.dirname(import.meta.dirname), 'themes');

interface Theme {
	name: string;
	colors: Record<string, string>;
	tokenColors: { settings: Record<string, string> }[];
	semanticTokenColors: Record<string, string>;
	[key: string]: unknown;
}

/** The colours of GeminiCode Dark that make up its greys, in the order of the palette below. */
const darkNeutrals = ['#0B0C0E', '#0F1013', '#141519', '#1B1C21', '#1F2126', '#23252B', '#24262C', '#2A2D34', '#2C2F36', '#4A4F59', '#5C616B', '#5F6570', '#7E838D', '#8B909A', '#D6D8DD', '#E8EAED'];

const darkAccent = '#8AB4F8';
const darkAccentLight = '#A8C7FA';
const lightAccent = '#1A5FD6';

interface Variant {
	readonly file: string;
	readonly name: string;
	/** Replacements for `darkNeutrals`, in the same order. */
	readonly neutrals: readonly string[];
	readonly accent: string;
	readonly accentLight: string;
}

const variants: readonly Variant[] = [
	{
		file: 'geminicode-midnight.json',
		name: 'GeminiCode Midnight',
		// True black for OLED screens and dark rooms.
		neutrals: ['#000000', '#030304', '#000000', '#0C0D10', '#111216', '#15161A', '#17181C', '#1E2025', '#222429', '#3C4049', '#53575F', '#5A5E66', '#767A83', '#7E838D', '#E3E5EA', '#F1F2F4'],
		accent: '#B69CF6',
		accentLight: '#CBB8FA',
	},
	{
		file: 'geminicode-dusk.json',
		name: 'GeminiCode Dusk',
		// Warm greys, easier on the eyes late in the day.
		neutrals: ['#141110', '#171311', '#1C1816', '#221D1A', '#26201D', '#2A2421', '#2B2522', '#332B27', '#362E2A', '#564B45', '#6B605A', '#7A6E67', '#8C817A', '#9A8F87', '#E6DDD6', '#F0E9E3'],
		accent: '#F2A28B',
		accentLight: '#F6BCA9',
	},
];

/** The accents on the Make It Yours page: the colour on dark themes, then on GeminiCode Light. */
export const accents = {
	blue: ['#8AB4F8', '#1A5FD6'],
	violet: ['#B69CF6', '#7A3EC8'],
	rose: ['#F28BB0', '#C2185B'],
	teal: ['#7FD3C4', '#00796B'],
	amber: ['#F2C17D', '#A35A00'],
	// The middle of the Gemini gradient; the chat's Send button shows the gradient itself.
	gradient: ['#A79CF2', '#6750C9'],
} as const;

export type AccentId = keyof typeof accents;

/** Colours that name a meaning rather than the accent, so an accent never changes them. */
const notAccent = new Set(['charts.blue', 'charts.purple', 'charts.red', 'charts.orange', 'charts.yellow', 'charts.green', 'statusBar.debuggingBackground']);

function replaceColor(value: string, map: ReadonlyMap<string, string>): string {
	const base = value.slice(0, 7).toUpperCase();
	const replacement = map.get(base);
	return replacement ? replacement + value.slice(7) : value;
}

function makeVariant(dark: Theme, variant: Variant): Theme {
	const neutrals = new Map(darkNeutrals.map((color, i) => [color, variant.neutrals[i]]));
	const ui = new Map([...neutrals, [darkAccent, variant.accent], [darkAccentLight, variant.accentLight]]);
	const colors = Object.fromEntries(Object.entries(dark.colors).map(([key, value]) =>
		[key, notAccent.has(key) ? replaceColor(value, neutrals) : replaceColor(value, ui)]));
	// Syntax colours keep their hues; only the greys (text, comments) follow the variant.
	const tokenColors = dark.tokenColors.map(rule => ({
		...rule,
		settings: Object.fromEntries(Object.entries(rule.settings).map(([key, value]) => [key, key === 'foreground' ? replaceColor(value, neutrals) : value])),
	}));
	return { ...dark, name: variant.name, colors, tokenColors };
}

/** For each GeminiCode theme, the colour keys that carry its accent, with the alpha each adds. */
function accentKeys(theme: Theme, accent: string, accentLight?: string): Record<string, string> {
	const keys: Record<string, string> = {};
	for (const [key, value] of Object.entries(theme.colors)) {
		const base = value.slice(0, 7).toUpperCase();
		if (!notAccent.has(key) && (base === accent || base === accentLight)) {
			// The alpha the theme adds; the lighter shade some keys use becomes the accent itself.
			keys[key] = value.slice(7);
		}
	}
	return keys;
}

/** What `themes/` should contain: file name to text. */
export function buildThemes(): Map<string, string> {
	const read = (file: string) => JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf8')) as Theme;
	const dark = read('geminicode-dark.json');
	const light = read('geminicode-light.json');
	const files = new Map<string, string>();
	const accentTargets: Record<string, { kind: 'dark' | 'light'; keys: Record<string, string> }> = {
		[dark.name]: { kind: 'dark', keys: accentKeys(dark, darkAccent, darkAccentLight) },
		[light.name]: { kind: 'light', keys: accentKeys(light, lightAccent) },
	};
	for (const variant of variants) {
		const theme = makeVariant(dark, variant);
		files.set(variant.file, JSON.stringify(theme, undefined, '\t') + '\n');
		accentTargets[theme.name] = { kind: 'dark', keys: accentKeys(theme, variant.accent, variant.accentLight) };
	}
	files.set('accents.json', JSON.stringify({ accents, themes: accentTargets }, undefined, '\t') + '\n');
	return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	for (const [file, text] of buildThemes()) {
		fs.writeFileSync(path.join(themesDir, file), text);
		console.log(`Wrote themes/${file}`);
	}
}

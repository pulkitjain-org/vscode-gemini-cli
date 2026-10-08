/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Makes the Midnight, Dusk and Glass themes from GeminiCode Dark and Light, and the accent
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

interface GlassVariant {
	readonly file: string;
	readonly name: string;
	readonly base: 'dark' | 'light';
	/** For the dark one, its greys in place of `darkNeutrals`. */
	readonly neutrals?: readonly string[];
	/** Colours set outright. The wallpaper, the glass and the gradients are CSS in the workbench (`geminiGlass.css`). */
	readonly colors: Record<string, string>;
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

/**
 * Glass, the default: translucent side bars and frosted pop-ups over an aurora wallpaper, with
 * the Gemini gradient for Gemini's own moments. The side bars' see-through colour is
 * `surface.background`; `sideBar.background` stays solid for what paints inside them.
 */
const glassVariants: readonly GlassVariant[] = [
	{
		file: 'geminicode-glass-dark.json',
		name: 'GeminiCode Glass Dark',
		base: 'dark',
		// Ink greys with a little blue in them.
		neutrals: ['#0A0B10', '#0D0E15', '#11121A', '#171826', '#1B1C27', '#20212D', '#22232F', '#282A37', '#2B2D3A', '#474A5C', '#5A5D70', '#6E7285', '#8A8DA0', '#A6A9B8', '#D9DBE5', '#ECEDF3'],
		colors: {
			'surface.background': '#1B1C23D9',
			'surface.border': '#FFFFFF0F',
			'sideBar.background': '#16171F',
			'sideBar.border': '#FFFFFF0F',
			'sideBarTitle.background': '#00000000',
			'sideBarSectionHeader.background': '#00000000',
			'sideBarSectionHeader.border': '#FFFFFF0A',
			'sideBarStickyScroll.background': '#16171F',
			'list.activeSelectionBackground': '#FFFFFF14',
			'list.inactiveSelectionBackground': '#FFFFFF0F',
			'list.hoverBackground': '#FFFFFF0A',
			'editorGroupHeader.tabsBackground': '#00000000',
			'editorGroupHeader.noTabsBackground': '#11121A',
			'editorGroupHeader.tabsBorder': '#00000000',
			'editorGroupHeader.border': '#00000000',
			'tab.activeBackground': '#FFFFFF1A',
			'tab.selectedBackground': '#FFFFFF1A',
			'tab.unfocusedActiveBackground': '#FFFFFF12',
			'tab.inactiveBackground': '#00000000',
			'tab.unfocusedInactiveBackground': '#00000000',
			'activityBarTop.background': '#00000000',
			'activityBarTop.activeBackground': '#FFFFFF1A',
			'input.background': '#171826',
			'titleBar.activeBackground': '#0A0B10',
			'titleBar.inactiveBackground': '#0A0B10',
		},
	},
	{
		file: 'geminicode-glass-light.json',
		name: 'GeminiCode Glass Light',
		base: 'light',
		colors: {
			'modernUI.shellBackground': '#ECEEF6',
			'modernUI.inactiveShellBackground': '#ECEEF6',
			'titleBar.activeBackground': '#ECEEF6',
			'titleBar.inactiveBackground': '#ECEEF6',
			'statusBar.background': '#ECEEF6',
			'statusBar.inactiveBackground': '#ECEEF6',
			'statusBar.noFolderBackground': '#ECEEF6',
			'statusBar.foreground': '#33353F',
			'surface.background': '#FFFFFF5C',
			'surface.border': '#FFFFFF99',
			'sideBar.background': '#F4F5FB',
			'sideBar.border': '#FFFFFF99',
			'sideBar.foreground': '#33353F',
			'sideBarTitle.background': '#00000000',
			'sideBarSectionHeader.background': '#00000000',
			'sideBarSectionHeader.border': '#FFFFFF80',
			'sideBarStickyScroll.background': '#F4F5FB',
			'list.activeSelectionBackground': '#4285F42E',
			'list.inactiveSelectionBackground': '#4285F41F',
			'list.hoverBackground': '#FFFFFF73',
			'editorGroupHeader.tabsBackground': '#00000000',
			'editorGroupHeader.tabsBorder': '#00000000',
			'editorGroupHeader.border': '#00000000',
			'tab.activeBackground': '#FFFFFFB8',
			'tab.selectedBackground': '#FFFFFFB8',
			'tab.unfocusedActiveBackground': '#FFFFFF8C',
			'tab.inactiveBackground': '#00000000',
			'tab.unfocusedInactiveBackground': '#00000000',
			'tab.hoverBackground': '#FFFFFF66',
			'activityBar.background': '#00000000',
			'activityBarTop.background': '#00000000',
			'activityBarTop.activeBackground': '#FFFFFFB8',
			'panel.border': '#FFFFFF99',
		},
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
	for (const glass of glassVariants) {
		const base = glass.base === 'dark'
			? makeVariant(dark, { file: glass.file, name: glass.name, neutrals: glass.neutrals!, accent: darkAccent, accentLight: darkAccentLight })
			: { ...light, name: glass.name };
		const theme = { ...base, colors: { ...base.colors, ...glass.colors } };
		files.set(glass.file, JSON.stringify(theme, undefined, '\t') + '\n');
		accentTargets[theme.name] = glass.base === 'dark'
			? { kind: 'dark', keys: accentKeys(theme, darkAccent, darkAccentLight) }
			: { kind: 'light', keys: accentKeys(theme, lightAccent) };
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

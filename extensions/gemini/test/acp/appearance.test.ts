/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccentTable, codeFontOf, codeFonts, themeIds, withAccent } from '../../src/acp/appearance';
import { buildThemes } from '../../scripts/build-themes.mjs';

const extensionDir = path.join(__dirname, '..', '..');
const table: AccentTable = {
	accents: { blue: ['#8AB4F8', '#1A5FD6'], violet: ['#B69CF6', '#7A3EC8'] },
	themes: {
		'GeminiCode Dark': { kind: 'dark', keys: { focusBorder: '99', 'textLink.foreground': '' } },
		'GeminiCode Light': { kind: 'light', keys: { focusBorder: '99' } },
	},
};

describe('withAccent', () => {
	it('sets the accent keys of the theme in use, in its light or dark shade', () => {
		expect(withAccent(undefined, 'violet', 'GeminiCode Dark', table)).toEqual({
			'[GeminiCode Dark]': { focusBorder: '#B69CF699', 'textLink.foreground': '#B69CF6' },
		});
		expect(withAccent(undefined, 'violet', 'GeminiCode Light', table)).toEqual({
			'[GeminiCode Light]': { focusBorder: '#7A3EC899' },
		});
	});

	it('moves the accent when the theme changes, and drops it for other themes', () => {
		const dark = withAccent(undefined, 'blue', 'GeminiCode Dark', table)!;
		expect(withAccent(dark, 'blue', 'GeminiCode Light', table)).toEqual({ '[GeminiCode Light]': { focusBorder: '#1A5FD699' } });
		expect(withAccent(dark, 'blue', 'Default Dark Modern', table)).toEqual({});
	});

	it('keeps what the user customized, and changes nothing when the accent is already shown', () => {
		const current = { 'editor.background': '#000000', '[GeminiCode Dark]': { 'tab.border': '#111111' } };
		const next = withAccent(current, 'blue', 'GeminiCode Dark', table)!;
		expect(next['editor.background']).toBe('#000000');
		expect(next['[GeminiCode Dark]']).toEqual({ 'tab.border': '#111111', focusBorder: '#8AB4F899', 'textLink.foreground': '#8AB4F8' });
		expect(withAccent(next, 'blue', 'GeminiCode Dark', table)).toBeUndefined();
	});

	it('removes its keys, and blocks it emptied, for the theme\'s own accent', () => {
		const next = withAccent({ '[GeminiCode Dark]': { 'tab.border': '#111111' } }, 'violet', 'GeminiCode Dark', table)!;
		expect(withAccent(next, 'theme', 'GeminiCode Dark', table)).toEqual({ '[GeminiCode Dark]': { 'tab.border': '#111111' } });
		expect(withAccent(undefined, 'theme', 'GeminiCode Dark', table)).toBeUndefined();
	});
});

describe('codeFontOf', () => {
	it('recognises the families the page sets, whatever the spacing', () => {
		expect(codeFontOf(`'JetBrains Mono',  Menlo, Monaco, 'Courier New', monospace`)?.id).toBe('jetbrains');
		expect(codeFontOf('Fira Code')).toBeUndefined();
		expect(new Set(codeFonts.map(f => f.id)).size).toBe(codeFonts.length);
	});
});

describe('themes', () => {
	it('are what scripts/build-themes.mts makes (run it after editing GeminiCode Dark or Light)', () => {
		for (const [file, text] of buildThemes()) {
			expect(readFileSync(path.join(extensionDir, 'themes', file), 'utf8'), file).toBe(text);
		}
	});

	it('are all contributed, with an accent table entry each', () => {
		const contributed = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).contributes.themes.map((t: { id: string }) => t.id);
		const accents = JSON.parse(readFileSync(path.join(extensionDir, 'themes', 'accents.json'), 'utf8')) as AccentTable;
		for (const id of themeIds) {
			expect(contributed).toContain(id);
			expect(Object.keys(accents.themes[id].keys).length).toBeGreaterThan(40);
		}
	});
});

describe('file icon theme', () => {
	it('has a file for every icon it names, and names an icon for every file', () => {
		const dir = path.join(extensionDir, 'icons');
		const theme = JSON.parse(readFileSync(path.join(dir, 'geminicode-icon-theme.json'), 'utf8'));
		const definitions: Record<string, { iconPath: string }> = theme.iconDefinitions;
		for (const { iconPath } of Object.values(definitions)) {
			expect(existsSync(path.join(dir, iconPath)), iconPath).toBe(true);
		}
		const used = new Set<string>();
		for (const section of [theme, theme.light]) {
			for (const key of ['file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded']) {
				used.add(section[key]);
			}
			for (const map of ['fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded']) {
				Object.values(section[map] as Record<string, string>).forEach(id => used.add(id));
			}
		}
		for (const id of used) {
			expect(definitions[id], id).toBeDefined();
		}
		expect(used.size).toBe(Object.keys(definitions).length);
	});
});

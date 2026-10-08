/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeFontOf, codeFonts, themeIds, withoutOldAccents } from '../../src/acp/appearance';

const extensionDir = path.join(__dirname, '..', '..');

describe('withoutOldAccents', () => {
	it('drops the GeminiCode theme blocks and keeps everything else', () => {
		const current = { 'editor.background': '#000000', '[GeminiCode Dark]': { focusBorder: '#B69CF699' }, '[Monokai]': { 'tab.border': '#111111' } };
		expect(withoutOldAccents(current)).toEqual({ 'editor.background': '#000000', '[Monokai]': { 'tab.border': '#111111' } });
	});

	it('changes nothing when there is no GeminiCode block', () => {
		expect(withoutOldAccents(undefined)).toBeUndefined();
		expect(withoutOldAccents({ 'editor.background': '#000000' })).toBeUndefined();
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
	it('are all contributed', () => {
		const contributed = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).contributes.themes.map((t: { id: string }) => t.id);
		expect(contributed).toEqual([...themeIds]);
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

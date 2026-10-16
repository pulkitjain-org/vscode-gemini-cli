/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every list a user opens is drawn in the theme. A <select> in a webview or in
// the workbench's DOM opens the system's menu on macOS, so each one is wrapped
// (webview-src/selectMenu.ts) or is the workbench's SelectBox.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const createsSelect = /['"]select['"]\s*\)|\$\(\s*['"]select|<select[\s>]/;

function sources(folder: string): string[] {
	return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
		? sources(path.join(folder, entry.name))
		: /\.ts$/.test(entry.name) ? [path.join(folder, entry.name)] : []);
}

describe('themed menus', () => {
	it('wraps every <select> a webview makes in a themed menu', () => {
		const bare = sources(path.join(root, 'webview-src'))
			.filter(file => !file.endsWith('selectMenu.ts'))
			.filter(file => {
				const text = readFileSync(file, 'utf8');
				return createsSelect.test(text) && !text.includes('selectMenu(');
			})
			.map(file => path.relative(root, file));
		expect(bare).toEqual([]);
	});

	it('draws no <select> in GeminiCode\'s workbench code', () => {
		const workbench = path.join(root, '..', '..', 'src', 'vs', 'workbench', 'contrib', 'gemini');
		const bare = sources(workbench)
			.filter(file => {
				// Comments may name the element.
				const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
				return createsSelect.test(code);
			})
			.map(file => path.relative(root, file));
		expect(bare).toEqual([]);
	});
});

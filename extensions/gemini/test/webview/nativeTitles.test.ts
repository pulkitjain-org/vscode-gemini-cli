/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every tooltip in a webview is the themed one (webview-src/tooltip.ts): a
// native `title` is the system's, slow to appear and unthemed. No page sets
// one, by the property or the attribute; `setTip` is the only way.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const setsTitle = /\.title\s*=[^=]|setAttribute\(\s*['"]title['"]/;
/** Files that may set a native title; none today. */
const allowed: readonly string[] = [];

function sources(folder: string): string[] {
	return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
		? sources(path.join(folder, entry.name))
		: /\.ts$/.test(entry.name) ? [path.join(folder, entry.name)] : []);
}

describe('native titles', () => {
	it('are set by no webview module; tooltips go through setTip', () => {
		const titled = sources(path.join(root, 'webview-src'))
			.filter(file => file !== path.join(root, 'webview-src', 'tooltip.ts'))
			.filter(file => {
				// Comments may name the property.
				const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
				return setsTitle.test(code);
			})
			.map(file => path.relative(root, file))
			.filter(file => !allowed.includes(file));
		expect(titled).toEqual([]);
	});
});

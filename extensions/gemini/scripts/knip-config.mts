/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes knip.json's entry list from the bundlers' entry maps (esbuild.mts,
// esbuild.webview.mts), so a chunk added to a build is an entry for knip
// without a second list to keep in step. Gemini CI runs it and fails when
// the committed knip.json differs:
//
//   node extensions/gemini/scripts/knip-config.mts

import * as fs from 'node:fs';
import * as path from 'node:path';

const extensionDir = path.dirname(import.meta.dirname);

/** The `'name': path.join(srcDir, 'file.ts')` entries of a bundler file, as `file.ts`. */
function entriesOf(file: string): string[] {
	const text = fs.readFileSync(path.join(extensionDir, file), 'utf8');
	return [...text.matchAll(/'[\w-]+': path\.join\(srcDir, '([\w-]+\.ts)'\)/g)].map(match => match[1]);
}

const config = {
	$schema: 'https://unpkg.com/knip@6/schema.json',
	entry: [
		...entriesOf('esbuild.mts').map(file => `src/${file}`),
		...entriesOf('esbuild.webview.mts').map(file => `webview-src/${file}`),
		'scripts/*.mts',
		'esbuild*.mts',
		'test/**/*.ts',
	],
	project: ['src/**/*.ts', 'webview-src/**/*.ts', 'scripts/**/*.mts', 'test/**/*.ts'],
	ignoreDependencies: ['@vscode/codicons', 'katex'],
};
fs.writeFileSync(path.join(extensionDir, 'knip.json'), `${JSON.stringify(config, null, '\t')}\n`);
console.log(`Wrote knip.json with ${config.entry.length} entries.`);

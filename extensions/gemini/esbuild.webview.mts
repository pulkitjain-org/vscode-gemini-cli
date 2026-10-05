/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'webview-src');
const outDir = path.join(import.meta.dirname, 'media');

run({
	entryPoints: {
		'chat': path.join(srcDir, 'chat.ts'),
		'changes': path.join(srcDir, 'changes.ts'),
		'home': path.join(srcDir, 'home.ts'),
		'settings': path.join(srcDir, 'settings.ts'),
		'highlight': path.join(srcDir, 'highlight.ts'),
		'codicon': path.join(import.meta.dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		// The icon font as its own file rather than inlined: every page (chat, Home, Changes, settings)
		// then parses a small stylesheet and shares one cached font.
		loader: {
			'.ttf': 'file',
		},
		assetNames: '[name]',
	}
}, process.argv);

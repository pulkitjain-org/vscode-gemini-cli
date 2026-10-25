/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'webview-src');
const outDir = path.join(import.meta.dirname, 'media');

run({
	entryPoints: {
		'chat': path.join(srcDir, 'chat.ts'),
		'changes': path.join(srcDir, 'changes.ts'),
		'home': path.join(srcDir, 'home.ts'),
		'connections': path.join(srcDir, 'connections.ts'),
		'auditLog': path.join(srcDir, 'auditLog.ts'),
		'settings': path.join(srcDir, 'settings.ts'),
		'indexPage': path.join(srcDir, 'indexPage.ts'),
		'teamFlow': path.join(srcDir, 'teamFlow.ts'),
		'highlight': path.join(srcDir, 'highlight.ts'),
		'katex': path.join(srcDir, 'katex.ts'),
		'draftMarkdown': path.join(srcDir, 'draftMarkdown.ts'),
		'commentBox': path.join(srcDir, 'commentBox.ts'),
		'homePopups': path.join(srcDir, 'homePopups.ts'),
		'emojiPicker': path.join(srcDir, 'emojiPicker.ts'),
		'katex-style': path.join(import.meta.dirname, 'node_modules', 'katex', 'dist', 'katex.min.css'),
		'codicon': path.join(import.meta.dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		// Text as UTF-8 rather than escaped: the emoji picker's data is mostly emoji, which escapes would make a fifth larger.
		// Module scripts are always read as UTF-8. The stylesheets are escaped back to ASCII below.
		charset: 'utf8',
		// The icon font as its own file rather than inlined: every page (chat, Home, Changes, settings)
		// then parses a small stylesheet and shares one cached font.
		loader: {
			'.ttf': 'file',
			'.woff2': 'file',
		},
		plugins: [{
			// markdown-it needs only entities' decoder; its package entry also pulls in the
			// encoder tables, which esbuild cannot drop (about 23 KB of every page's script).
			name: 'entities-decode-only',
			setup(build) {
				build.onResolve({ filter: /^entities$/ }, () => ({ path: path.join(import.meta.dirname, 'node_modules', 'entities', 'lib', 'esm', 'decode.js') }));
			},
		}, {
			// The built stylesheets stay ASCII, with CSS escapes: the codicon font's glyphs are
			// private-use characters, which the hygiene check refuses in any file it reads.
			name: 'css-ascii',
			setup(build) {
				build.onEnd(async () => {
					for (const file of ['codicon.css', 'katex-style.css']) {
						const at = path.join(outDir, file);
						const css = await fs.readFile(at, 'utf8').catch(() => undefined);
						const ascii = css?.replace(/[^\x00-\x7f]/gu, char => `\\${char.codePointAt(0)!.toString(16)} `);
						if (css !== undefined && ascii !== css) {
							await fs.writeFile(at, ascii!);
						}
					}
				});
			},
		}, {
			// KaTeX's fonts ship as woff2 only, which every webview reads first; its woff and
			// ttf copies stay unresolved links that are never fetched.
			name: 'katex-woff2-only',
			setup(build) {
				build.onResolve({ filter: /KaTeX_.*\.(woff|ttf)$/ }, args => ({ path: args.path, external: true }));
			},
		}],
		assetNames: '[name]',
	}
}, process.argv);

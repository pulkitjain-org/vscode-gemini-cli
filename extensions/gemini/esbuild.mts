/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
		// The indexer process (src/acp/index), forked on first use; none of it loads in the extension host.
		'indexer': path.join(srcDir, 'indexer.ts'),
		// Features loaded the first time one of their commands runs (src/host/lazyFeature.ts), so the
		// extension's own bundle never carries them: pages opened on request, and tools used rarely.
		'pages': path.join(srcDir, 'pages.ts'),
		'onDemand': path.join(srcDir, 'onDemand.ts'),
		// The ACP connection with its SDK and zod, loaded when the agent process starts, seconds after activation.
		'connection': path.join(srcDir, 'connection.ts'),
		// Confluence: its client, agents' calls, drafts and the Review Page, loaded the first time Confluence is used.
		'confluence': path.join(srcDir, 'confluence.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		plugins: [{
			// The ACP SDK validates with zod, whose `z.locales` carries its error messages in
			// some fifty languages: a third of this bundle. English, the one zod uses unless
			// `z.config` picks another (nothing here does), is loaded by zod's schemas on
			// their own (v4/classic/schemas.js), so the list keeps only it.
			name: 'zod-english-only',
			setup(build) {
				build.onResolve({ filter: /locales[\\/]index\.js$/ }, args => /[\\/]node_modules[\\/]zod[\\/]/.test(args.importer)
					? { path: path.join(path.dirname(args.importer), args.path), namespace: 'zod-english-only' }
					: undefined);
				build.onLoad({ filter: /.*/, namespace: 'zod-english-only' }, args => ({
					contents: 'export { default as en } from "./en.js";',
					resolveDir: path.dirname(args.path),
					loader: 'js',
				}));
			},
		}],
	},
}, process.argv);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lets Node run the extension's TypeScript sources from a script: their
// imports leave out the extension (`./cli/formats`), as esbuild and vitest
// accept, so a relative import without one is tried with `.ts`. Load it
// before the sources, with `node --import ./scripts/sourceImports.mts`, or as
// a script's first import with the sources imported dynamically after it.

import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier) && /\.m?ts$/.test(context.parentURL ?? '')) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// Not a TypeScript file: resolve it as written.
			}
		}
		return nextResolve(specifier, context);
	},
});

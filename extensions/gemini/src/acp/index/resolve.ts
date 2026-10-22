/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which file an import names, for related_files. Only imports that name a
// file in the folder are resolved: relative ones, Python and Java modules by
// their path, Rust `mod` files and quoted C includes. Packages and path
// aliases are left alone.

import * as path from 'node:path';

export interface KnownFiles {
	has(relative: string): boolean;
	/** Folder-relative paths of the files named `base`. */
	named(base: string): readonly string[];
}

const scriptExtensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.vue', '.svelte'];

/** The folder-relative file `spec` names when imported from `from`, or undefined. */
export function resolveImport(from: string, spec: string, lang: string, files: KnownFiles): string | undefined {
	const dir = path.posix.dirname(from);
	switch (lang) {
		case 'typescript': {
			if (!spec.startsWith('.')) {
				return undefined;
			}
			const base = path.posix.normalize(path.posix.join(dir, spec));
			const stem = base.replace(/\.(?:m|c)?js$/, '');
			const candidates = [base, ...scriptExtensions.map(e => stem + e), ...scriptExtensions.map(e => `${base}/index${e}`)];
			return candidates.find(c => !c.startsWith('..') && files.has(c));
		}
		case 'python': {
			const dots = /^\.*/.exec(spec)![0].length;
			const module = spec.slice(dots).replace(/\./g, '/');
			if (dots) {
				let base = dir;
				for (let i = 1; i < dots; i++) {
					base = path.posix.dirname(base);
				}
				const stem = path.posix.normalize(path.posix.join(base, module));
				return [`${stem}.py`, `${stem}/__init__.py`].find(c => files.has(c));
			}
			return bySuffix(files, `${module}.py`) ?? bySuffix(files, `${module}/__init__.py`);
		}
		case 'java':
		case 'kotlin': {
			const module = spec.replace(/\./g, '/');
			return bySuffix(files, `${module}.java`) ?? bySuffix(files, `${module}.kt`) ?? bySuffix(files, `${module}.scala`);
		}
		case 'rust':
			return [path.posix.join(dir, `${spec}.rs`), path.posix.join(dir, spec, 'mod.rs')].find(c => files.has(c));
		case 'ruby': {
			const base = path.posix.normalize(path.posix.join(dir, spec));
			return [base, `${base}.rb`].find(c => files.has(c));
		}
		case 'c': {
			const local = path.posix.normalize(path.posix.join(dir, spec));
			return files.has(local) ? local : bySuffix(files, spec);
		}
		default:
			return undefined;
	}
}

/** The one file whose path ends with `suffix`, preferring the shortest path when several do. */
function bySuffix(files: KnownFiles, suffix: string): string | undefined {
	const base = suffix.slice(suffix.lastIndexOf('/') + 1);
	const matches = files.named(base).filter(file => file === suffix || file.endsWith(`/${suffix}`));
	return matches.sort((a, b) => a.length - b.length)[0];
}

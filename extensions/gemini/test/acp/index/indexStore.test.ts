/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importParts, IndexStore } from '../../../src/acp/index/indexStore';

describe('IndexStore imports', () => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'store-imports-')));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('splits a specifier into the names a file can match', () => {
		expect([
			'./cart', 'com.acme.Cart', 'cart.h', './cart.service', '../cart/index', '.cart', 'crate::cart::discount', 'lodash',
		].map(importParts)).toEqual([
			{ last: 'cart', stem: 'cart' },
			{ last: 'Cart', stem: 'com' },
			{ last: 'h', stem: 'cart' },
			{ last: 'service', stem: 'cart' },
			{ last: 'index', stem: 'index' },
			{ last: 'cart', stem: 'cart' },
			{ last: 'discount', stem: 'crate' },
			{ last: 'lodash', stem: 'lodash' },
		]);
	});

	it('finds the unresolved imports a new file can resolve through indexed columns, not by reading them all', async () => {
		const store = await IndexStore.open(path.join(dir, 'index.db'));
		try {
			const file = (relative: string, lang: string, imports: string[], targets: (string | undefined)[] = []) => store.writeFile(
				{ path: relative, lang, size: 1, mtime: 1, hash: relative },
				{ lang, symbols: [], chunks: [], imports },
				targets,
			);
			store.transaction(() => {
				file('src/a.ts', 'typescript', ['./cart.service', 'react']);
				file('src/B.java', 'java', ['com.acme.Cart', 'java.util.List']);
				file('src/c.ts', 'typescript', ['./other'], ['src/other.ts']);
				file('src/d.py', 'python', ['.cart']);
			});
			const specs = (names: string[]) => store.unresolvedImports(new Set(names)).map(row => `${row.path} ${row.spec} ${row.lang}`);
			expect(specs(['cart'])).toEqual(['src/a.ts ./cart.service typescript', 'src/d.py .cart python']);
			expect(specs(['Cart'])).toEqual(['src/B.java com.acme.Cart java']);
			// Resolved already, and nothing named that.
			expect(specs(['other', 'nothing'])).toEqual([]);
			// More names than one query may carry go in several.
			expect(specs([...Array.from({ length: 900 }, (_, i) => `n${i}`), 'cart'])).toHaveLength(2);
			const indexes = (store.statement('SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'imports\' ORDER BY name').all() as { name: string }[]).map(row => row.name);
			expect(indexes).toEqual(['imports_last', 'imports_path', 'imports_stem', 'imports_target']);
		} finally {
			store.close();
		}
	});
});

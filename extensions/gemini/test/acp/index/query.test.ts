/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cappedNote, formatSearch, searchFooter } from '../../../src/acp/index/format';
import { IndexStore } from '../../../src/acp/index/indexStore';
import { maxScanned, search } from '../../../src/acp/index/query';

/**
 * A store where a common word is everywhere outside one folder, and the
 * folder's own mentions rank last: `outside` chunks of the word repeated, then
 * three long chunks under src/cart that say it once.
 */
async function storeWith(dir: string, name: string, outside: number): Promise<IndexStore> {
	const store = await IndexStore.open(path.join(dir, name));
	const file = (relative: string, text: string) => store.writeFile(
		{ path: relative, lang: 'typescript', size: text.length, mtime: 1, hash: relative },
		{ lang: 'typescript', symbols: [], imports: [], chunks: [{ startLine: 1, endLine: 2, text }] },
	);
	store.transaction(() => {
		for (let i = 0; i < outside; i++) {
			file(`lib/f${i}.ts`, '// widget widget widget widget\nexport const a = 1;');
		}
		for (let i = 0; i < 3; i++) {
			file(`src/cart/c${i}.ts`, `// the cart keeps one widget for each line of the order, ${'and this comment goes on at length '.repeat(6)}\nexport const b = 1;`);
		}
	});
	return store;
}

describe('search with a path filter', () => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'query-')));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('finds a folder\'s matches when a common word outranks them elsewhere, as a folder and as a glob', async () => {
		const store = await storeWith(dir, 'wide.db', 600);
		try {
			const folder = search(store, { query: 'widget', path: 'src/cart' });
			expect(folder.hits.map(h => h.path).sort()).toEqual(['src/cart/c0.ts', 'src/cart/c1.ts', 'src/cart/c2.ts']);
			expect([folder.total, folder.capped]).toEqual([3, undefined]);
			const glob = search(store, { query: 'widget', path: 'src/cart/*.ts' });
			expect(glob.hits.map(h => h.path).sort()).toEqual(['src/cart/c0.ts', 'src/cart/c1.ts', 'src/cart/c2.ts']);
			expect(glob.capped).toBeUndefined();
			// A folder narrows the ranking itself, so the file it names and nothing beside it.
			expect(search(store, { query: 'widget', path: '/src/cart/c1.ts' }).hits.map(h => h.path)).toEqual(['src/cart/c1.ts']);
			expect(search(store, { query: 'widget', path: 'src/car' }).hits).toEqual([]);
		} finally {
			store.close();
		}
	});

	it('says when a glob was checked against only the best-ranked matches', async () => {
		const store = await storeWith(dir, 'huge.db', maxScanned + 100);
		try {
			const folder = search(store, { query: 'widget', path: 'src/cart' });
			expect([folder.hits.length, folder.capped]).toEqual([3, undefined]);
			const glob = search(store, { query: 'widget', path: 'src/cart/*.ts' });
			expect([glob.hits, glob.capped]).toEqual([[], true]);
			expect(formatSearch('widget', glob)).toContain(cappedNote);
			const shown = formatSearch('widget', { hits: glob.hits.length ? glob.hits : [{ path: 'lib/f0.ts', startLine: 1, endLine: 2, text: 'widget' }], total: 400, terms: ['widget'], capped: true });
			expect(shown).toContain('showing 1 of at least 400');
			expect(shown).toContain(cappedNote);
			expect(shown).not.toContain(searchFooter);
		} finally {
			store.close();
		}
	});
});

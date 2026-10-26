/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DocsLibrary } from '../../../src/acp/docs/docsLibrary';
import type { DocsPage } from '../../../src/acp/index/indexerProtocol';

describe('DocsLibrary', () => {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'docs-library-')));
	const library = new DocsLibrary(base);
	afterAll(() => {
		library.dispose();
		rmSync(base, { recursive: true, force: true });
	});
	const page = (n: number): DocsPage => ({ url: `https://docs.example.com/p${n}`, body: `# Page ${n}\n\nRetry number ${n} waits longer.`, type: 'markdown' });

	it('stores a large batch in short transactions and searches it', async () => {
		const pages = Array.from({ length: 400 }, (_, n) => page(n));
		const status = await library.ingest({ source: { id: 'big', url: 'https://docs.example.com/', run: 1 }, pages, unchanged: [], complete: true });
		expect(status).toMatchObject({ id: 'big', pages: 400, sections: 400 });
		expect((await library.search({ ids: ['big'], query: 'retry number 123' })).hits[0]?.url).toBe('https://docs.example.com/p123');
		// The next complete run drops what it no longer has.
		const next = await library.ingest({ source: { id: 'big', url: 'https://docs.example.com/', run: 2 }, pages: [page(1)], unchanged: [page(2).url], complete: true });
		expect(next).toMatchObject({ pages: 2, sections: 2 });
	});

	it('deletes a damaged store, and keeps one it can\'t open for another reason', async () => {
		const docs = path.join(base, 'docs');
		writeFileSync(path.join(docs, 'damaged.db'), 'this is not a database');
		expect(await library.ingest({ source: { id: 'damaged', url: 'https://d.example.com/', run: 1 }, pages: [page(1)], unchanged: [], complete: true })).toMatchObject({ pages: 1 });
		mkdirSync(path.join(docs, 'busy.db'));
		await expect(library.ingest({ source: { id: 'busy', url: 'https://b.example.com/', run: 1 }, pages: [page(1)], unchanged: [], complete: true })).rejects.toThrow();
		expect([existsSync(path.join(docs, 'busy.db')), statSync(path.join(docs, 'busy.db')).isDirectory()]).toEqual([true, true]);
	});
});

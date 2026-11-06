/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DocsLibrary, siteTitleOf } from '../../../src/acp/docs/docsLibrary';
import type { DocsPage } from '../../../src/acp/index/indexerProtocol';

/** Whether each conversion ran inside a write transaction of the source's store. */
const conversions: boolean[] = [];
let openStores: Map<string, { db: DatabaseSync }> | undefined;
vi.mock('../../../src/acp/docs/htmlToMarkdown', async importOriginal => {
	const original = await importOriginal<typeof import('../../../src/acp/docs/htmlToMarkdown')>();
	return {
		...original,
		htmlToMarkdown: (html: string, url: string) => {
			conversions.push([...openStores?.values() ?? []].some(entry => entry.db.isTransaction));
			return original.htmlToMarkdown(html, url);
		},
	};
});

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

	it('converts pages before writing them, holding no transaction while it does', async () => {
		openStores = (library as unknown as { open: Map<string, { db: DatabaseSync }> }).open;
		const html = (n: number): DocsPage => ({ url: `https://h.example.com/p${n}`, body: `<html><head><title>Page ${n}</title></head><body><main><h1>Page ${n}</h1><p>Retry number ${n}.</p></main></body></html>`, type: 'html' });
		const status = await library.ingest({ source: { id: 'html', url: 'https://h.example.com/', run: 1 }, pages: [html(1), html(2), html(3)], unchanged: [], complete: true });
		expect(status).toMatchObject({ pages: 3, sections: 3 });
		expect(conversions).toEqual([false, false, false]);
		// A page whose Markdown is unchanged keeps its sections; a changed one is cut again.
		const again = await library.ingest({ source: { id: 'html', url: 'https://h.example.com/', run: 2 }, pages: [html(1), { ...html(2), body: html(2).body.replace('Retry number 2.', 'Retry number two.') }], unchanged: [html(3).url], complete: true });
		expect(again).toMatchObject({ pages: 3, sections: 3 });
		expect((await library.search({ ids: ['html'], query: 'retry number two' })).hits[0]?.url).toBe('https://h.example.com/p2');
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

describe('siteTitleOf', () => {
	it('names the docs from a site title or the start page, never from another page\'s heading', () => {
		const source = 'https://vitest.dev/api/';
		expect([
			siteTitleOf('describe | Test API Reference | Vitest', true, 'https://vitest.dev/api/describe', source),
			siteTitleOf('describe', false, 'https://vitest.dev/api/describe.md', source),
			siteTitleOf('Expect', true, 'https://vitest.dev/api/expect', source),
			siteTitleOf('Vitest API', true, 'https://vitest.dev/api', source),
			siteTitleOf('https://vitest.dev/api/', false, 'https://vitest.dev/api/', source),
		]).toEqual([
			{ title: 'Vitest', start: false },
			undefined,
			undefined,
			{ title: 'Vitest API', start: true },
			undefined,
		]);
	});
});

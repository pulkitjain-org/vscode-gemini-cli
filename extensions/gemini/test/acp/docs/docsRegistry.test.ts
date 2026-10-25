/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DocsRegistry, DocsSource, isDue, provisionalTitle, sourceId } from '../../../src/acp/docs/docsRegistry';

describe('DocsRegistry', () => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'docs-registry-')));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const source = (over: Partial<DocsSource> = {}): DocsSource => ({ id: 'a1', url: 'https://react.dev/reference', scope: 'prefix', maxPages: 500, addedAt: 0, folders: ['/repo'], ...over });

	it('saves sources atomically and reads them back, dropping malformed ones', async () => {
		const file = path.join(dir, 'sources.json');
		const registry = new DocsRegistry(file);
		expect(await registry.load()).toEqual([]);
		await registry.update(() => [source()]);
		await registry.update(sources => sources.map(s => ({ ...s, folders: [...s.folders, '/other'] })));
		expect(await new DocsRegistry(file).load()).toEqual([source({ folders: ['/repo', '/other'] })]);
		writeFileSync(file, JSON.stringify({ version: 1, sources: [source(), { id: '../escape', url: 'x', scope: 'prefix', maxPages: 1, folders: [] }] }));
		expect((await new DocsRegistry(file).load()).map(s => s.id)).toEqual(['a1']);
	});

	it('names one source by its address and scope, however it is written', () => {
		expect(sourceId('https://react.dev/reference/', 'prefix')).toBe(sourceId('https://react.dev/reference#top', 'prefix'));
		expect(sourceId('https://react.dev/reference', 'prefix')).not.toBe(sourceId('https://react.dev/reference', 'site'));
		expect(provisionalTitle('https://react.dev/reference/react')).toBe('react.dev › react');
	});

	it('is due by its own refresh, else the setting\'s', () => {
		const day = 24 * 60 * 60 * 1000;
		expect([
			isDue(source(), 'daily', day),
			isDue(source({ fetchedAt: 0 }), 'daily', day / 2),
			isDue(source({ fetchedAt: 1 }), 'daily', day + 1),
			isDue(source({ fetchedAt: 1, refresh: 'weekly' }), 'daily', day + 1),
			isDue(source({ fetchedAt: 1, refresh: 'manual' }), 'daily', 100 * day),
		]).toEqual([true, false, true, false, false]);
	});
});

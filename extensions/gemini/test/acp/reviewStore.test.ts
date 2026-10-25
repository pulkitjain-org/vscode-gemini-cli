/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewKeepMs, ReviewStore } from '../../src/acp/reviewStore';

const review = (iid: number) => ({
	project: 'vca/cms-vca2', iid, title: `MR ${iid}`, url: `u/${iid}`, author: 'hh', source: 'feature', target: 'develop',
	repository: '/repo', remote: 'origin', summary: '', state: 'ready' as const, draft: { comments: [], replies: [] }, rev: 1,
});

describe('review store', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('keeps each review until it is removed or two weeks untouched, the last changed first', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'reviews-'));
		let t = Date.parse('2026-10-01T09:00:00Z');
		const store = new ReviewStore(dir, () => new Date(t));
		await store.save(review(12));
		t += 1000;
		const second = await store.save(review(9558));
		t += 1000;
		const again = await store.save({ ...second, summary: 'Ready' });
		expect(again.createdAt).toBe(second.createdAt);
		expect((await store.list()).map(r => [r.iid, r.summary])).toEqual([[9558, 'Ready'], [12, '']]);
		expect(await store.get('vca/cms-vca2', 12)).toMatchObject({ iid: 12, updatedAt: '2026-10-01T09:00:00.000Z' });
		await store.remove('vca/cms-vca2', 12);
		expect(await store.get('vca/cms-vca2', 12)).toBeUndefined();
		t += reviewKeepMs + 1;
		expect(await store.list()).toEqual([]);
		expect(await store.get('vca/cms-vca2', 9558)).toBeUndefined();
	});

	it('moves an unreadable review aside, and leaves no temporary file behind', async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'reviews-'));
		const store = new ReviewStore(dir);
		await store.save(review(12));
		await writeFile(path.join(dir, 'broken-1.json'), '{');
		expect((await store.list()).map(r => r.iid)).toEqual([12]);
		expect((await readdir(dir)).sort()).toEqual(['broken-1.json.broken', 'vca_cms-vca2-12.json']);
	});
});

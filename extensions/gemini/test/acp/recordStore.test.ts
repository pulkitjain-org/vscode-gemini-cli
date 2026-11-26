/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordStore, type RecordChange } from '../../src/acp/recordStore';

interface Note {
	readonly id: string;
	readonly text: string;
	readonly updatedAt: number;
	readonly [extra: string]: unknown;
}

/** Resolves once `predicate` holds, checking every 20 ms for up to 5 s. */
async function until(predicate: () => boolean): Promise<void> {
	for (let waited = 0; !predicate(); waited += 20) {
		if (waited > 5_000) {
			throw new Error('Timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

describe('RecordStore', () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function folder() {
		const dir = await mkdtemp(path.join(tmpdir(), 'records-'));
		dirs.push(dir);
		return path.join(dir, 'notes');
	}

	const open = (dir: string, errors: string[] = []) => new RecordStore<Note>(dir, { newer: (theirs, ours) => theirs.updatedAt > ours.updatedAt, onError: message => errors.push(message) });

	it('writes one file per record, and only the records that changed', async () => {
		const dir = await folder();
		const store = open(dir);
		const a = { id: 'a', text: 'one', updatedAt: 1 };
		const b = { id: 'b', text: 'two', updatedAt: 1 };
		await store.save([a, b]);
		expect((await readdir(dir)).sort()).toEqual(['a.json', 'b.json']);
		const before = (await stat(path.join(dir, 'a.json'))).mtimeMs;
		await new Promise(resolve => setTimeout(resolve, 20));
		await store.save([a, { ...b, text: 'three' }]);
		expect((await stat(path.join(dir, 'a.json'))).mtimeMs).toBe(before);
		expect((await open(dir).load()).map(n => n.text)).toEqual(['one', 'three']);
	});

	it('keeps fields it does not know', async () => {
		const dir = await folder();
		await open(dir).save([{ id: 'a', text: 'one', updatedAt: 1, fromNewerVersion: { kept: true } }]);
		expect(await open(dir).load()).toEqual([{ id: 'a', text: 'one', updatedAt: 1, fromNewerVersion: { kept: true } }]);
	});

	it('moves a file it cannot read aside as .broken, and never writes over one of a newer version', async () => {
		const dir = await folder();
		const errors: string[] = [];
		const first = open(dir);
		await first.save([{ id: 'a', text: 'one', updatedAt: 1 }, { id: 'b', text: 'two', updatedAt: 1 }]);
		await writeFile(path.join(dir, 'a.json'), '{ half');
		const newer = JSON.stringify({ version: 2, order: 0, record: { id: 'b', text: 'from 2', updatedAt: 9 } });
		await writeFile(path.join(dir, 'b.json'), newer);
		const store = open(dir, errors);
		expect(await store.load()).toEqual([]);
		expect((await readdir(dir)).sort()).toEqual(['a.json.broken', 'b.json']);
		expect(errors).toHaveLength(1);
		await store.save([{ id: 'b', text: 'mine', updatedAt: 10 }]);
		expect(await readFile(path.join(dir, 'b.json'), 'utf8')).toBe(newer);
		// A second broken copy doesn't replace the first.
		await writeFile(path.join(dir, 'a.json'), 'nope');
		await open(dir).load();
		expect((await readdir(dir)).filter(name => name.startsWith('a.json.broken'))).toHaveLength(2);
	});

	it('leaves a tombstone, so a window that still has the record never brings it back', async () => {
		const dir = await folder();
		const a = { id: 'a', text: 'one', updatedAt: 1 };
		const one = open(dir);
		const two = open(dir);
		await one.save([a]);
		const [loaded] = await two.load();
		await one.save([]);
		// The second window hasn't heard yet, and changes the record.
		const change = await two.save([{ ...loaded, text: 'edited', updatedAt: 2 }]);
		expect(change).toEqual({ upserted: [], removed: ['a'] });
		expect(await open(dir).load()).toEqual([]);
	});

	it('takes the newer copy of another window instead of writing over it', async () => {
		const dir = await folder();
		const one = open(dir);
		const two = open(dir);
		await one.save([{ id: 'a', text: 'one', updatedAt: 1 }]);
		const [loaded] = await two.load();
		await one.save([{ id: 'a', text: 'used in one', updatedAt: 5 }]);
		const change = await two.save([{ ...loaded, text: 'older edit in two', updatedAt: 3 }]);
		expect(change.upserted.map(n => n.text)).toEqual(['used in one']);
		expect((await open(dir).load())[0].text).toBe('used in one');
	});

	it('hears of records another window adds, changes and removes', async () => {
		const dir = await folder();
		const one = open(dir);
		const two = open(dir);
		await one.save([{ id: 'a', text: 'one', updatedAt: 1 }]);
		await two.load();
		const changes: RecordChange<Note>[] = [];
		const watching = two.watch(change => changes.push(change));
		try {
			await new Promise(resolve => setTimeout(resolve, 50));
			await one.save([{ id: 'a', text: 'one', updatedAt: 1 }, { id: 'b', text: 'two', updatedAt: 1 }]);
			await until(() => changes.some(c => c.upserted.some(n => n.id === 'b')));
			await one.save([{ id: 'b', text: 'two', updatedAt: 1 }]);
			await until(() => changes.some(c => c.removed.includes('a')));
			// Its own writes are not news.
			const count = changes.length;
			await two.save([{ id: 'b', text: 'two, edited', updatedAt: 2 }]);
			await new Promise(resolve => setTimeout(resolve, 250));
			expect(changes.length).toBe(count);
		} finally {
			watching.dispose();
		}
	});

	it('removes tombstones past their time and temporary files a crash left', async () => {
		const dir = await folder();
		let now = Date.now();
		const store = new RecordStore<Note>(dir, { now: () => now, tombstoneMs: 100 });
		await store.save([{ id: 'a', text: 'one', updatedAt: 1 }]);
		await store.save([]);
		await writeFile(path.join(dir, 'b.json.123.0.tmp'), '{');
		now += 2 * 24 * 60 * 60 * 1000;
		await new RecordStore<Note>(dir, { now: () => now, tombstoneMs: 100 }).load();
		expect(await readdir(dir)).toEqual([]);
	});
});

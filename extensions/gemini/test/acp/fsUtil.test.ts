/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRecord, KeyedQueue, privateWrite, quarantine, removeOldDayFiles, samePath, writeFileAtomic, writeJsonAtomic } from '../../src/acp/fsUtil';

describe('fsUtil', () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
	});

	async function folder() {
		const dir = await mkdtemp(path.join(tmpdir(), 'fsutil-'));
		dirs.push(dir);
		return dir;
	}

	it('writes atomically, through a temporary file of its own, and leaves none behind', async () => {
		const dir = await folder();
		const file = path.join(dir, 'deep', 'a.json');
		await Promise.all([writeJsonAtomic(file, { a: 1 }), writeJsonAtomic(file, { a: 2 })]);
		expect([{ a: 1 }, { a: 2 }]).toContainEqual(JSON.parse(await readFile(file, 'utf8')));
		await writeJsonAtomic(file, { b: true }, { indent: '\t', newline: false, mode: 0o600 });
		expect(await readFile(file, 'utf8')).toBe('{\n\t"b": true\n}');
		await writeFileAtomic(path.join(dir, 'pieces.txt'), ['one ', 'two ', 'x'.repeat(70_000), ' three']);
		expect(await readFile(path.join(dir, 'pieces.txt'), 'utf8')).toBe(`one two ${'x'.repeat(70_000)} three`);
		expect(await readdir(path.join(dir, 'deep'))).toEqual(['a.json']);
		expect((await stat(path.join(dir, 'pieces.txt'))).isFile()).toBe(true);
	});

	it('writes GeminiCode\'s own files for the user alone', async () => {
		const dir = await folder();
		const file = path.join(dir, 'private', 'a.json');
		await writeJsonAtomic(file, { a: 1 }, privateWrite);
		const modes = process.platform === 'win32' ? [0o600, 0o700] : [(await stat(file)).mode & 0o777, (await stat(path.dirname(file))).mode & 0o777];
		expect(modes).toEqual([0o600, 0o700]);
	});

	it('moves a file aside without writing over an earlier one', async () => {
		const dir = await folder();
		const file = path.join(dir, 'a.json');
		await writeFile(file, 'first');
		expect(await quarantine(file, 5)).toBe(`${file}.broken`);
		await writeFile(file, 'second');
		expect(await quarantine(file, 5)).toBe(`${file}.broken-5`);
		expect(await quarantine(file, 6)).toBeUndefined();
		expect(await readFile(`${file}.broken`, 'utf8')).toBe('first');
	});

	it('removes the day files older than the days kept, and none when 0', async () => {
		const dir = await folder();
		for (const name of ['2026-01-01.jsonl', '2026-03-30.jsonl', '2026-03-31.jsonl', 'notes.txt']) {
			await writeFile(path.join(dir, name), '');
		}
		const now = new Date('2026-04-30T12:00:00Z');
		expect(await removeOldDayFiles(dir, 0, now)).toBe(0);
		expect(await removeOldDayFiles(dir, 30, now)).toBe(2);
		expect((await readdir(dir)).sort()).toEqual(['2026-03-31.jsonl', 'notes.txt']);
	});

	it('runs tasks one after another per key, past a failure', async () => {
		const queue = new KeyedQueue();
		const order: string[] = [];
		const slow = queue.run('a', async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			order.push('a1');
		});
		const failing = queue.run('a', async () => {
			throw new Error('disk full');
		});
		const after = queue.run('a', async () => void order.push('a2'));
		const other = queue.run('b', async () => void order.push('b1'));
		await expect(failing).rejects.toThrow('disk full');
		await Promise.all([slow, after, other, queue.flush()]);
		expect(order).toEqual(['b1', 'a1', 'a2']);
	});

	it('compares folders and records', () => {
		expect(samePath('/a/b/../c', '/a/c')).toBe(true);
		expect(samePath('/a/c', '/a/d')).toBe(false);
		expect([{}, [], null, 'x'].map(isRecord)).toEqual([true, false, false, false]);
	});
});

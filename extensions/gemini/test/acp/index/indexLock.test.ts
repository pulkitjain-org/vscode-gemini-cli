/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { IndexLock, staleLockMs } from '../../../src/acp/index/indexLock';

async function eventually(check: () => boolean): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (check()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('The condition never held.');
}

describe('IndexLock, between processes', () => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lock-')));
	const lockFile = path.join(dir, 'index.lock');
	afterEach(() => rmSync(lockFile, { force: true }));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('takes a lock whose holder stopped refreshing it, even when its pid is alive', async () => {
		writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: Date.now() - staleLockMs - 1_000, token: 'old' }));
		const lock = await IndexLock.acquire(dir, process.pid, 'index.lock', { heartbeatMs: 0 });
		expect(lock).toBeDefined();
		await lock!.release();
	});

	it('refreshes its time while held, and a release leaves another holder\'s lock alone', async () => {
		let now = 1_000;
		const lock = await IndexLock.acquire(dir, process.pid, 'index.lock', { now: () => now, heartbeatMs: 10 });
		now = 99_000;
		await eventually(() => JSON.parse(readFileSync(lockFile, 'utf8')).at === 99_000);
		// Another process took it over (as after this one hung for five minutes).
		writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: Date.now(), token: 'theirs' }));
		await eventually(() => !lock!.held);
		await lock!.release();
		expect(JSON.parse(readFileSync(lockFile, 'utf8')).token).toBe('theirs');
	});

	it('gives the lock up after a pause long enough for another process to have taken it', async () => {
		let now = 1_000;
		const lock = await IndexLock.acquire(dir, process.pid, 'index.lock', { now: () => now, heartbeatMs: 10 });
		now += staleLockMs;
		await eventually(() => !lock!.held);
		expect(JSON.parse(readFileSync(lockFile, 'utf8')).at).toBe(1_000);
		await lock!.release();
	});

	it('never shows a half-written or missing lock while it beats faster than it writes', async () => {
		const lock = await IndexLock.acquire(dir, process.pid, 'index.lock', { heartbeatMs: 1 });
		let unreadable = 0;
		const end = Date.now() + 500;
		while (Date.now() < end) {
			try {
				JSON.parse(readFileSync(lockFile, 'utf8'));
			} catch {
				unreadable++;
			}
			await new Promise(resolve => setImmediate(resolve));
		}
		await lock!.release();
		expect(unreadable).toBe(0);
	});

	it('stays released when a rewrite was under way at the release', async () => {
		const lock = await IndexLock.acquire(dir, process.pid, 'index.lock', { heartbeatMs: 1 });
		await new Promise(resolve => setTimeout(resolve, 20));
		await lock!.release();
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(existsSync(lockFile)).toBe(false);
	});

	it('takes a lock it can\'t read as one being written, until it is as old as a stale one', async () => {
		writeFileSync(lockFile, '{"pid":');
		const fresh = await IndexLock.acquire(dir, process.pid, 'index.lock', { heartbeatMs: 0 });
		const old = (Date.now() - staleLockMs - 1_000) / 1000;
		utimesSync(lockFile, old, old);
		const left = await IndexLock.acquire(dir, process.pid, 'index.lock', { heartbeatMs: 0 });
		expect({ fresh, left: !!left }).toEqual({ fresh: undefined, left: true });
		await left!.release();
	});

	it('lets exactly one of several processes take a free lock at once', async () => {
		const pids = [process.pid, process.ppid, 1];
		const locks = await Promise.all(pids.map(pid => IndexLock.acquire(dir, pid, 'index.lock', { heartbeatMs: 0 })));
		expect(locks.filter(Boolean)).toHaveLength(1);
		await Promise.all(locks.map(lock => lock?.release()));
	});
});

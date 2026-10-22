/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One writer per index. Every GeminiCode window has its own indexer process,
// and two windows can open the same folder; the first to take the lock
// writes, the others only read (SQLite lets them, in WAL mode) and try again
// before each change. A lock whose process is gone is taken over.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export class IndexLock {

	private constructor(private readonly file: string) { }

	/** Takes the lock `name` in `dir`, or undefined when a live process holds it. */
	static async acquire(dir: string, pid: number = process.pid, name = 'index.lock'): Promise<IndexLock | undefined> {
		const file = path.join(dir, name);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.writeFile(file, JSON.stringify({ pid, at: Date.now() }), { flag: 'wx' });
				return new IndexLock(file);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					return undefined;
				}
			}
			const holder = await readHolder(file);
			if (holder === pid) {
				return new IndexLock(file);
			}
			if (holder !== undefined && isAlive(holder)) {
				return undefined;
			}
			// Another process may take it over first; the next attempt finds out.
			await fs.unlink(file).catch(() => undefined);
		}
		return undefined;
	}

	async release(): Promise<void> {
		await fs.unlink(this.file).catch(() => undefined);
	}
}

async function readHolder(file: string): Promise<number | undefined> {
	try {
		const pid = (JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown }).pid;
		return typeof pid === 'number' ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

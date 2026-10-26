/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One writer per index. Every GeminiCode window has its own indexer process,
// and two windows can open the same folder; the first to take the lock
// writes, the others only read (SQLite lets them, in WAL mode) and try again
// before each change.
//
// The lock file is made whole in a temporary file and linked into place, so
// two processes can't both take it, and it carries a token, so a release
// only ever removes the holder's own lock. The holder rewrites its time
// every minute; a lock whose process is gone, or whose time is more than
// five minutes old (the process hung, or its pid now belongs to another
// program), is taken over.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** How often the holder rewrites its time. */
const heartbeatMs = 60_000;
/** A lock not rewritten for this long is taken over, whatever process has its pid now. */
export const staleLockMs = 5 * 60_000;

interface Holder {
	readonly pid: number;
	readonly at: number;
	readonly token?: string;
}

export interface LockOptions {
	readonly now?: () => number;
	/** 0 turns the heartbeat off, for tests. */
	readonly heartbeatMs?: number;
}

export class IndexLock {

	private timer: ReturnType<typeof setInterval> | undefined;
	private lost = false;

	private constructor(private readonly file: string, private readonly holder: Holder, private readonly now: () => number, heartbeat: number) {
		if (heartbeat > 0) {
			this.timer = setInterval(() => void this.beat(), heartbeat);
			this.timer.unref?.();
		}
	}

	/** Takes the lock `name` in `dir`, or undefined when a live process holds it. */
	static async acquire(dir: string, pid: number = process.pid, name = 'index.lock', options: LockOptions = {}): Promise<IndexLock | undefined> {
		const file = path.join(dir, name);
		const now = options.now ?? Date.now;
		for (let attempt = 0; attempt < 3; attempt++) {
			const holder: Holder = { pid, at: now(), token: randomUUID() };
			const created = await createExclusive(file, holder);
			if (created === 'created') {
				return new IndexLock(file, holder, now, options.heartbeatMs ?? heartbeatMs);
			}
			if (created === 'failed') {
				return undefined;
			}
			const current = await readHolder(file);
			if (current && current.pid !== pid && isAlive(current.pid) && now() - current.at < staleLockMs) {
				return undefined;
			}
			// Gone, hung, or this process's own: move it out of the way and try again.
			if (!await removeIfUnchanged(file, current)) {
				return undefined;
			}
		}
		return undefined;
	}

	/** Whether this process still holds the lock: false once another process took it over. */
	get held(): boolean {
		return !this.lost;
	}

	async release(): Promise<void> {
		clearInterval(this.timer);
		this.timer = undefined;
		if (this.lost) {
			return;
		}
		this.lost = true;
		if ((await readHolder(this.file))?.token === this.holder.token) {
			await fs.unlink(this.file).catch(() => undefined);
		}
	}

	/** Rewrites the lock's time, while it is still this process's. */
	private async beat(): Promise<void> {
		const current = await readHolder(this.file);
		if (current?.token !== this.holder.token) {
			this.lost = !!current || this.lost;
			if (current) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			return;
		}
		const temporary = `${this.file}.${this.holder.token}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify({ ...this.holder, at: this.now() }));
			await fs.rename(temporary, this.file);
		} catch {
			await fs.unlink(temporary).catch(() => undefined);
		}
	}
}

/** Writes the lock whole, then links it into place, which fails when a lock is there. */
async function createExclusive(file: string, holder: Holder): Promise<'created' | 'exists' | 'failed'> {
	const temporary = `${file}.${holder.token}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(holder));
		await fs.link(temporary, file);
		return 'created';
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}

/**
 * Moves a stale lock aside, unless another process replaced it after it was
 * read, in which case that process's lock is put back. Whether to try again.
 */
async function removeIfUnchanged(file: string, seen: Holder | undefined): Promise<boolean> {
	const aside = `${file}.${randomUUID()}.stale`;
	try {
		await fs.rename(file, aside);
	} catch (err) {
		// Gone already: someone released or moved it.
		return (err as NodeJS.ErrnoException).code === 'ENOENT';
	}
	const moved = await readHolder(aside);
	if (seen && moved?.token !== seen.token) {
		await fs.link(aside, file).catch(() => undefined);
		await fs.unlink(aside).catch(() => undefined);
		return false;
	}
	await fs.unlink(aside).catch(() => undefined);
	return true;
}

async function readHolder(file: string): Promise<Holder | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Holder>;
		return typeof value.pid === 'number' ? { pid: value.pid, at: typeof value.at === 'number' ? value.at : 0, token: typeof value.token === 'string' ? value.token : undefined } : undefined;
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

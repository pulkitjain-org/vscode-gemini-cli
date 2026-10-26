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
// only ever removes the holder's own lock. Each rewrite goes through a
// temporary file of its own, one at a time: two heartbeats sharing one once
// renamed a half-written file into place, and a window reading it took the
// lock for free. A lock that can't be read is taken as one being written,
// held until it is as old as a stale one. The holder rewrites its time
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
	/** A rewrite in progress: the next heartbeat skips rather than overlapping it, and a release waits for it. */
	private beating: Promise<void> | undefined;

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
			const { holder: current, unreadable, modified } = await readLock(file);
			if (unreadable && (modified === undefined || now() - modified < staleLockMs)) {
				// Being written, or written by a version that wrote it in place: held.
				return undefined;
			}
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
		// A rewrite under way would put the lock back after it was removed.
		await this.beating;
		if ((await readHolder(this.file))?.token === this.holder.token) {
			await fs.unlink(this.file).catch(() => undefined);
		}
	}

	/** Rewrites the lock's time, while it is still this process's. */
	private async beat(): Promise<void> {
		if (this.beating || this.lost) {
			return;
		}
		this.beating = this.rewrite();
		try {
			await this.beating;
		} finally {
			this.beating = undefined;
		}
	}

	private async rewrite(): Promise<void> {
		const current = await readHolder(this.file);
		if (current?.token !== this.holder.token) {
			this.lost = !!current || this.lost;
			if (current) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			return;
		}
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify({ ...this.holder, at: this.now() }));
			if (this.lost) {
				// Released meanwhile.
				await fs.unlink(temporary);
				return;
			}
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
	return (await readLock(file)).holder;
}

/**
 * The lock at `file`: its holder, or `unreadable` when a file is there but
 * isn't a whole lock, with when it was last written (to tell one being
 * written from one left behind).
 */
async function readLock(file: string): Promise<{ readonly holder?: Holder; readonly unreadable: boolean; readonly modified?: number }> {
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		return { unreadable: false };
	}
	try {
		const value = JSON.parse(text) as Partial<Holder>;
		if (typeof value.pid === 'number') {
			return { holder: { pid: value.pid, at: typeof value.at === 'number' ? value.at : 0, token: typeof value.token === 'string' ? value.token : undefined }, unreadable: false };
		}
	} catch {
		// Not whole: fall through.
	}
	const modified = await fs.stat(file).then(stats => stats.mtimeMs, () => undefined);
	return { unreadable: true, ...modified !== undefined ? { modified } : {} };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

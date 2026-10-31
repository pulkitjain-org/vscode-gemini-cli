/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Following a log file the user picked (DEBUG_MODE.md, Picked log files):
// only what is added after the pick, from the file's size at that moment. A
// file that shrinks was truncated and is read again from zero; one replaced
// under the same path (a new inode) is reopened from its start; one that is
// deleted ends the grant. Lines are cut at 2 KB, at most 1 MB is read per
// run, and a binary file is refused. `poll` is the whole of it; `start` runs
// it on fs.watch with a stat every two seconds as the backstop.

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';

export const logTailLimits = {
	maxLineBytes: 2 * 1024,
	maxBytesPerRun: 1024 * 1024,
	/** How much of the file's head is checked for NUL bytes. */
	binaryProbeBytes: 4 * 1024,
	maxFilters: 5,
	backstopMs: 2000,
} as const;

export type TailEnd = 'deleted' | 'stopped' | 'unreadable';

export interface LogTailOptions {
	/** Literal substrings; a line passes when it holds one of them. Lines with `@@gc:` always pass. */
	readonly filters?: readonly string[];
	onLines(lines: readonly string[]): void;
	onEnd?(reason: TailEnd): void;
}

export type PollResult = { readonly lines: number; readonly truncated?: boolean; readonly rotated?: boolean; readonly capped?: boolean } | { readonly ended: TailEnd };

/** The chunk read at a time. */
const readChunk = 64 * 1024;

export class LogTail {

	private offset = 0;
	private inode = 0;
	private readThisRun = 0;
	private partial = '';
	private watcher: fs.FSWatcher | undefined;
	private backstop: NodeJS.Timeout | undefined;
	private polling: Promise<PollResult> | undefined;
	private ended = false;
	private readonly filters: readonly string[];

	constructor(readonly file: string, private readonly options: LogTailOptions) {
		this.filters = (options.filters ?? []).filter(f => f.length).slice(0, logTailLimits.maxFilters);
	}

	/** Reads nothing, but takes the file's size as the starting point; refuses a binary file. */
	async open(): Promise<{ readonly ok: true; readonly size: number } | { readonly ok: false; readonly error: string }> {
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(this.file);
		} catch {
			return { ok: false, error: 'The file could not be read.' };
		}
		if (!stat.isFile()) {
			return { ok: false, error: 'Only a file can be followed, not a folder.' };
		}
		if (await this.looksBinary()) {
			return { ok: false, error: 'The file is binary.' };
		}
		this.offset = stat.size;
		this.inode = stat.ino;
		return { ok: true, size: stat.size };
	}

	/** A new reproduction: the per-run read cap starts again. */
	newRun(): void {
		this.readThisRun = 0;
	}

	/** Reads what was added since the last poll, and tells the options about it. */
	poll(): Promise<PollResult> {
		if (this.ended) {
			return Promise.resolve({ ended: 'stopped' });
		}
		this.polling ??= this.doPoll().finally(() => {
			this.polling = undefined;
		});
		return this.polling;
	}

	/** Follows the file until `stop` or the file goes. */
	start(): void {
		this.watch();
		this.backstop = setInterval(() => void this.poll(), logTailLimits.backstopMs);
	}

	stop(): void {
		if (this.ended) {
			return;
		}
		this.end('stopped');
	}

	private watch(): void {
		this.watcher?.close();
		this.watcher = undefined;
		try {
			this.watcher = fs.watch(this.file, () => void this.poll());
			this.watcher.on('error', () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			// The backstop stat still follows it.
		}
	}

	private end(reason: TailEnd): void {
		this.ended = true;
		this.watcher?.close();
		this.watcher = undefined;
		if (this.backstop) {
			clearInterval(this.backstop);
			this.backstop = undefined;
		}
		this.options.onEnd?.(reason);
	}

	private async doPoll(): Promise<PollResult> {
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(this.file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				this.end('deleted');
				return { ended: 'deleted' };
			}
			this.end('unreadable');
			return { ended: 'unreadable' };
		}
		let truncated = false;
		let rotated = false;
		if (stat.ino !== this.inode && this.inode !== 0) {
			rotated = true;
			this.offset = 0;
			this.inode = stat.ino;
			this.partial = '';
			if (this.watcher) {
				this.watch();
			}
		} else if (stat.size < this.offset) {
			truncated = true;
			this.offset = 0;
			this.partial = '';
		}
		if (stat.size <= this.offset) {
			return { lines: 0, truncated, rotated };
		}
		const budget = logTailLimits.maxBytesPerRun - this.readThisRun;
		if (budget <= 0) {
			return { lines: 0, truncated, rotated, capped: true };
		}
		const toRead = Math.min(stat.size - this.offset, budget);
		let handle: fsp.FileHandle;
		try {
			handle = await fsp.open(this.file, 'r');
		} catch {
			this.end('unreadable');
			return { ended: 'unreadable' };
		}
		const lines: string[] = [];
		try {
			let remaining = toRead;
			while (remaining > 0) {
				const buffer = Buffer.alloc(Math.min(readChunk, remaining));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
				if (!bytesRead) {
					break;
				}
				this.offset += bytesRead;
				this.readThisRun += bytesRead;
				remaining -= bytesRead;
				this.take(buffer.subarray(0, bytesRead).toString('utf8'), lines);
			}
		} finally {
			await handle.close();
		}
		const capped = this.readThisRun >= logTailLimits.maxBytesPerRun;
		if (capped) {
			// The run's budget is spent: what the file holds past it is skipped, and reading goes on from its end at the next run.
			this.offset = stat.size;
			this.partial = '';
		}
		if (lines.length) {
			this.options.onLines(lines);
		}
		return { lines: lines.length, truncated, rotated, capped };
	}

	private take(text: string, out: string[]): void {
		const pieces = (this.partial + text).split('\n');
		this.partial = pieces.pop() ?? '';
		if (this.partial.length > logTailLimits.maxLineBytes) {
			// A line that never ends is cut where the cap falls, and the rest of it goes.
			const cut = this.partial.slice(0, logTailLimits.maxLineBytes);
			this.partial = '';
			pieces.push(cut);
		}
		for (const piece of pieces) {
			const line = piece.endsWith('\r') ? piece.slice(0, -1) : piece;
			if (!line.length || !this.passes(line)) {
				continue;
			}
			out.push(line.length > logTailLimits.maxLineBytes ? line.slice(0, logTailLimits.maxLineBytes) : line);
		}
	}

	private passes(line: string): boolean {
		if (!this.filters.length || line.includes('@@gc:')) {
			return true;
		}
		return this.filters.some(f => line.includes(f));
	}

	private async looksBinary(): Promise<boolean> {
		let handle: fsp.FileHandle;
		try {
			handle = await fsp.open(this.file, 'r');
		} catch {
			return false;
		}
		try {
			const buffer = Buffer.alloc(logTailLimits.binaryProbeBytes);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead).includes(0);
		} finally {
			await handle.close();
		}
	}
}
